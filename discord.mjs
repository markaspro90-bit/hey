const API = "https://discord.com/api/v10";
export const SNOWFLAKE = /^[1-9][0-9]{16,19}$/;
const FILE_LIMIT = 8 * 1024 * 1024;
const FILE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"};
const PERMISSIONS = {
  admin: 1n << 3n, view: 1n << 10n, send: 1n << 11n,
  embed: 1n << 14n, attach: 1n << 15n, history: 1n << 16n,
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function discordFieldError(node, path = []) {
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node._errors) && node._errors[0]?.message) {
    return `${path.join(".") || "Message"}: ${node._errors[0].message}`.slice(0, 350);
  }
  for (const [name, entry] of Object.entries(node)) {
    const found = discordFieldError(entry, [...path, name]);
    if (found) return found;
  }
  return "";
}

export async function discordRequest(path, { token, bearer, method = "GET", body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bot ${token}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body instanceof URLSearchParams) headers["Content-Type"] = "application/x-www-form-urlencoded";
  else if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(API + path, {
      method, headers, body, signal: AbortSignal.timeout(12_000), redirect: "error",
    });
  } catch {
    throw new HttpError(502, "Discord did not respond. For a send or edit, check the channel before trying again.");
  }
  const data = await response.json().catch(() => ({}));
  if (response.ok) return data;
  if (response.status === 429) throw new HttpError(429, "Discord is rate limiting requests. Try again shortly.");
  if (response.status >= 500) {
    throw new HttpError(502, "Discord could not confirm the request. For a send or edit, check the channel before retrying.");
  }
  if (response.status === 401) throw new HttpError(401, "Discord rejected the credentials. Check the app configuration in Railway.");
  if (response.status === 403) throw new HttpError(403, "The bot is missing access or permissions in Discord.");
  if (response.status === 404) throw new HttpError(404, "Discord could not find that server, channel, or message.");
  throw new HttpError(422, discordFieldError(data.errors) || `Discord rejected the request${Number.isInteger(data.code) ? ` (code ${data.code})` : ""}.`);
}

export function channelPermissions(guild, member, botId, channel) {
  const roles = new Set([guild.id, ...member.roles]);
  let bits = guild.roles.reduce((sum, role) => roles.has(role.id) ? sum | BigInt(role.permissions) : sum, 0n);
  if (guild.owner_id === botId || (bits & PERMISSIONS.admin)) return {post: true, embed: true, attach: true, history: true};
  const overrides = channel.permission_overwrites || [];
  const apply = (entry) => {
    if (entry) bits = (bits & ~BigInt(entry.deny)) | BigInt(entry.allow);
  };
  apply(overrides.find((entry) => entry.type === 0 && entry.id === guild.id));
  let deny = 0n;
  let allow = 0n;
  for (const entry of overrides) {
    if (entry.type === 0 && entry.id !== guild.id && roles.has(entry.id)) {
      deny |= BigInt(entry.deny);
      allow |= BigInt(entry.allow);
    }
  }
  bits = (bits & ~deny) | allow;
  apply(overrides.find((entry) => entry.type === 1 && entry.id === botId));
  const has = (permission) => Boolean(bits & permission);
  const post = has(PERMISSIONS.view) && has(PERMISSIONS.send);
  return {post, embed: post && has(PERMISSIONS.embed), attach: post && has(PERMISSIONS.attach), history: has(PERMISSIONS.history)};
}

export function discordClient(config, request = discordRequest) {
  const bot = (path, options) => request(path, {...options, token: config.botToken});
  let botUser;
  async function user() {
    if (!botUser) {
      const result = await bot("/users/@me");
      if (!result.bot || result.id !== config.clientId) {
        throw new HttpError(422, "DISCORD_CLIENT_ID must belong to the same Discord application as DISCORD_TOKEN.");
      }
      botUser = {id: result.id, name: result.global_name || result.username};
    }
    return botUser;
  }
  async function channels() {
    const identity = await user();
    const base = `/guilds/${config.guildId}`;
    const [guild, member, list] = await Promise.all([
      bot(base), bot(`${base}/members/${identity.id}`), bot(`${base}/channels`),
    ]);
    return {
      guild: guild.name,
      bot: identity,
      channels: list
        .filter((channel) => [0, 5].includes(channel.type))
        .map((channel) => ({
          id: channel.id, name: channel.name, announcement: channel.type === 5, position: channel.position,
          category: list.find((parent) => parent.id === channel.parent_id)?.name || "",
          ...channelPermissions(guild, member, identity.id, channel),
        }))
        .filter((channel) => channel.post)
        .sort((left, right) => left.category.localeCompare(right.category) || left.position - right.position || left.name.localeCompare(right.name)),
    };
  }
  async function write(channelId, draft, nonce, messageId) {
    const { channels: list, bot: identity } = await channels();
    const target = list.find((channel) => channel.id === channelId);
    if (!target) throw new HttpError(403, "Choose a channel where the bot can view and send messages.");
    const {payload, files} = validateDraft(draft);
    if (payload.embeds.length && !target.embed) throw new HttpError(403, "The bot needs Embed Links in this channel.");
    if (files.length && !target.attach) throw new HttpError(403, "The bot needs Attach Files in this channel.");
    const path = `/channels/${channelId}/messages`;
    if (messageId) {
      if (!target.history) throw new HttpError(403, "The bot needs Read Message History to edit messages in this channel.");
      const previous = await bot(`${path}/${messageId}`);
      if (previous.author?.id !== identity.id || previous.webhook_id) throw new HttpError(403, "Only messages sent by this bot can be edited.");
      if (!files.length) {
        if (!payload.content && !payload.embeds.length && !previous.attachments?.length) {
          throw new HttpError(422, "Write a message, add an embed, or attach an image.");
        }
        if (previous.attachments?.length) payload.attachments = previous.attachments.map(({id, filename}) => ({id, filename}));
      }
    } else {
      if (!payload.content && !payload.embeds.length && !files.length) throw new HttpError(422, "Write a message, add an embed, or attach an image.");
      if (!payload.content) delete payload.content;
      if (!payload.embeds.length) delete payload.embeds;
      payload.nonce = nonce;
      payload.enforce_nonce = true;
    }
    let body = payload;
    if (files.length) {
      payload.attachments = files.map(({filename}, id) => ({id, filename}));
      body = new FormData();
      body.append("payload_json", JSON.stringify(payload));
      for (const [id, file] of files.entries()) {
        body.append(`files[${id}]`, new Blob([file.bytes], {type: file.type}), file.filename);
      }
    }
    const result = await bot(messageId ? `${path}/${messageId}` : path, {method: messageId ? "PATCH" : "POST", body});
    return {
      id: result.id, channel: channelId, name: target.name,
      url: `https://discord.com/channels/${config.guildId}/${channelId}/${result.id}`,
      attachments: (result.attachments || []).map(({filename, url}) => ({name: filename, url})),
    };
  }
  return {channels, write};
}

function string(value, limit, label, trim = true) {
  if (value == null) return "";
  if (typeof value !== "string") throw new HttpError(422, `${label} must be text.`);
  const cleaned = trim ? value.trim() : value;
  if (cleaned.length > limit) throw new HttpError(422, `${label} can have up to ${limit.toLocaleString("en-US")} characters.`);
  return cleaned;
}

function url(value, label) {
  const cleaned = string(value, 2048, label);
  if (!cleaned) return "";
  try {
    const parsed = new URL(cleaned);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || !/^https?:\/\//i.test(cleaned)) throw Error();
    return parsed.href;
  } catch {
    throw new HttpError(422, `${label} needs a valid HTTP or HTTPS link.`);
  }
}

function embed(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(422, "An embed is incomplete.");
  const label = `Embed ${index + 1}`;
  const title = string(raw.title, 256, `${label} title`);
  const description = string(raw.description, 4096, `${label} description`);
  const titleUrl = url(raw.url, `${label} title link`);
  const image = url(raw.image, `${label} image link`);
  const thumbnail = url(raw.thumbnail, `${label} thumbnail link`);
  const author = string(raw.author, 256, `${label} author`);
  const authorUrl = url(raw.authorUrl, `${label} author link`);
  const authorIcon = url(raw.authorIcon, `${label} author icon`);
  const footer = string(raw.footer, 2048, `${label} footer`);
  const footerIcon = url(raw.footerIcon, `${label} footer icon`);
  const color = string(raw.color, 7, `${label} color`);
  const timestamp = string(raw.timestamp, 35, `${label} timestamp`);
  if (titleUrl && !title) throw new HttpError(422, `${label} needs a title to use a title link.`);
  if ((authorUrl || authorIcon) && !author) throw new HttpError(422, `${label} needs an author name.`);
  if (footerIcon && !footer) throw new HttpError(422, `${label} needs footer text to use a footer icon.`);
  if (color && !/^#?[0-9a-f]{6}$/i.test(color)) throw new HttpError(422, `${label} color must be a six-digit hex color, such as #A78BFA.`);
  if (timestamp && !Number.isFinite(Date.parse(timestamp))) throw new HttpError(422, `${label} timestamp is invalid.`);
  if (!Array.isArray(raw.fields) || raw.fields.length > 25) throw new HttpError(422, `${label} can have up to 25 fields.`);
  const fields = raw.fields.map((field, i) => {
    const name = string(field?.name, 256, `${label} field ${i + 1} name`);
    const value = string(field?.value, 1024, `${label} field ${i + 1} value`);
    if (!name || !value) throw new HttpError(422, `${label} field ${i + 1} needs a name and a value.`);
    return {name, value, inline: field.inline === true};
  });
  if (!title && !description && !image && !thumbnail && !author && !footer && !fields.length) {
    throw new HttpError(422, `${label} is empty. Add content or remove it.`);
  }
  const details = {};
  if (title) details.title = title;
  if (description) details.description = description;
  if (titleUrl) details.url = titleUrl;
  if (image) details.image = {url: image};
  if (thumbnail) details.thumbnail = {url: thumbnail};
  if (author) details.author = {name: author, ...(authorUrl && {url: authorUrl}), ...(authorIcon && {icon_url: authorIcon})};
  if (footer) details.footer = {text: footer, ...(footerIcon && {icon_url: footerIcon})};
  if (color) details.color = Number.parseInt(color.replace("#", ""), 16);
  if (timestamp) details.timestamp = new Date(timestamp).toISOString();
  if (fields.length) details.fields = fields;
  const length = title.length + description.length + author.length + footer.length + fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  return {details, length};
}

function attachments(raw) {
  if (!Array.isArray(raw) || raw.length > 10) throw new HttpError(422, "You can attach up to 10 images.");
  let total = 0;
  return raw.map((file, index) => {
    const type = file?.type;
    const extension = Object.hasOwn(FILE_TYPES, type) ? FILE_TYPES[type] : "";
    if (!extension || typeof file.data !== "string" || file.data.length > Math.ceil(FILE_LIMIT / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.data)) {
      throw new HttpError(422, "Upload PNG, JPEG, GIF, or WebP images totaling up to 8 MiB.");
    }
    const bytes = Buffer.from(file.data, "base64");
    total += bytes.length;
    if (!bytes.length || total > FILE_LIMIT) throw new HttpError(422, "Upload images totaling up to 8 MiB.");
    const filename = typeof file.name === "string" ? file.name : "image";
    const sanitized = filename.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 70);
    return {type, bytes, filename: `${sanitized || `image-${index + 1}`}.${extension}`};
  });
}

export function validateDraft(draft) {
  if (!draft || typeof draft !== "object") throw new HttpError(422, "Compose a message first.");
  const content = string(draft.content, 2000, "Message text", false);
  if (!Array.isArray(draft.embeds) || draft.embeds.length > 10) throw new HttpError(422, "A message can have up to 10 embeds.");
  const embeds = draft.embeds.map(embed);
  if (embeds.reduce((sum, entry) => sum + entry.length, 0) > 6000) throw new HttpError(422, "The embeds can have up to 6,000 combined characters.");
  return {
    payload: {
      content: content.trim() ? content : "", embeds: embeds.map(({details}) => details),
      allowed_mentions: {parse: draft.ping === true ? ["users", "roles"] : [], replied_user: false},
    },
    files: attachments(draft.files),
  };
}
