const $ = (id) => document.getElementById(id);
const files = [];
const embeds = [];
let targets = [];
let sender = "Your bot";
let editTarget = null;
let receipt = null;
let pending = null;
let busy = false;
let scheduleAvailable = false;
let scheduleLoading = false;

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function button(label, action, className) {
  const item = node("button", label, className);
  item.type = "button";
  item.addEventListener("click", action);
  return item;
}

function notice(id, text, error = false) {
  const item = $(id);
  item.textContent = text;
  item.classList.toggle("error", error);
  item.hidden = !text;
}

async function api(path, method = "GET", data) {
  const headers = {"X-Studio-Request": "1"};
  if (data) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {method, headers, body: data ? JSON.stringify(data) : undefined});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "The request failed.");
  return result;
}

function safeURL(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function makeLink(text, url) {
  const item = node("a", text);
  item.href = url;
  item.target = "_blank";
  item.rel = "noopener noreferrer";
  return item;
}

function markdown(host, text) {
  const re = /(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\x60[^\x60\n]+\x60|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/gi;
  for (const part of text.split(re)) {
    const link = part.match(/^\[([^\]]+)\]\((.+)\)$/);
    const url = link && safeURL(link[2]);
    if (url) host.append(makeLink(link[1], url));
    else if (part.startsWith("**") && part.endsWith("**") && part.length > 4) host.append(node("strong", part.slice(2, -2)));
    else if (part.startsWith("__") && part.endsWith("__") && part.length > 4) host.append(node("u", part.slice(2, -2)));
    else if (part.startsWith("~~") && part.endsWith("~~") && part.length > 4) host.append(node("s", part.slice(2, -2)));
    else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) host.append(node("em", part.slice(1, -1)));
    else if (part.startsWith("\x60") && part.endsWith("\x60") && part.length > 2) host.append(node("code", part.slice(1, -1)));
    else host.append(document.createTextNode(part));
  }
}

function image(url, alt, className) {
  const item = node("img", "", className);
  item.alt = alt;
  item.loading = "lazy";
  item.src = url;
  return item;
}

function previewEmbed(embed) {
  const card = node("div", "", "embed-preview");
  if (/^#?[0-9a-f]{6}$/i.test(embed.color || "")) card.style.borderLeftColor = "#" + embed.color.replace("#", "");
  const author = node("div", "", "author");
  const authorIcon = safeURL(embed.authorIcon);
  const authorURL = safeURL(embed.authorUrl);
  if (authorIcon) author.append(image(authorIcon, ""));
  if (authorURL && embed.author) author.append(makeLink(embed.author, authorURL));
  else author.append(node("strong", embed.author));
  if (embed.author) card.append(author);
  const thumb = safeURL(embed.thumbnail);
  if (thumb) card.append(image(thumb, "Embed thumbnail", "thumbnail"));
  if (embed.title) {
    const heading = node("h3");
    const titleURL = safeURL(embed.url);
    heading.append(titleURL ? makeLink(embed.title, titleURL) : document.createTextNode(embed.title));
    card.append(heading);
  }
  if (embed.description) {
    const copy = node("div", "", "embed-copy");
    markdown(copy, embed.description);
    card.append(copy);
  }
  if (embed.fields.length) {
    const fieldList = node("div", "", "embed-fields");
    for (const field of embed.fields) {
      const item = node("div", "", field.inline ? "" : "block");
      item.append(node("strong", field.name));
      const value = node("div", "", "embed-copy");
      markdown(value, field.value);
      item.append(value);
      fieldList.append(item);
    }
    card.append(fieldList);
  }
  const large = safeURL(embed.image);
  if (large) card.append(image(large, "Embed image", "main-image"));
  if (embed.footer || embed.timestamp) {
    const footer = node("div", "", "footer");
    const icon = safeURL(embed.footerIcon);
    if (icon && embed.footer) footer.append(image(icon, ""));
    footer.append(node("span", [embed.footer, embed.timestamp && new Date(embed.timestamp).toLocaleString()].filter(Boolean).join(" · ")));
    card.append(footer);
  }
  return card;
}

function selectedChannel() {
  return targets.find((item) => item.id === $("channel").value);
}

function render() {
  const channel = selectedChannel();
  const content = $("content").value;
  $("counter").textContent = content.length.toLocaleString() + " / 2,000";
  $("preview-channel").textContent = channel ? "#" + channel.name : "No channel selected";
  $("empty-preview").hidden = Boolean(content || embeds.length || files.length || editTarget);
  $("rendered-content").replaceChildren();
  markdown($("rendered-content"), content);
  $("rendered-embeds").replaceChildren(...embeds.map(previewEmbed));
  const shownFiles = files.length ? files : (editTarget?.attachments || []);
  $("rendered-files").replaceChildren(...shownFiles.flatMap(({name, url}) => {
    const source = url.startsWith("blob:") ? url : safeURL(url);
    return source ? [image(source, name)] : [];
  }));
  $("review").disabled = busy || !channel || !(content.trim() || embeds.length || files.length || editTarget);
  $("schedule").hidden = Boolean(editTarget);
  $("schedule").disabled = $("review").disabled || !scheduleAvailable;
  $("review").textContent = editTarget ? "Review edit" : "Review & send";
  $("cancel-edit").hidden = !editTarget;
  $("channel").disabled = busy || Boolean(editTarget) || targets.length === 0;
  $("refresh").disabled = busy || Boolean(editTarget);
  $("file-help").textContent = editTarget
    ? "Existing attachments are kept unless you choose replacement images."
    : "PNG, JPEG, GIF, or WebP · 8 MiB total";
  $("add-embed").disabled = embeds.length >= 10;
}

function field(parent, model, key, label, {limit = 2048, rows, type = "text", placeholder} = {}) {
  const group = node("label", label);
  const input = node(rows ? "textarea" : "input");
  if (rows) input.rows = rows;
  else input.type = type;
  input.maxLength = limit;
  if (placeholder) input.placeholder = placeholder;
  input.value = model[key] || "";
  input.addEventListener("input", () => {
    model[key] = input.value;
    render();
  });
  group.append(input);
  parent.append(group);
  return input;
}

function checkbox(parent, label, value, update) {
  const group = node("label", "", "check");
  const input = node("input");
  input.type = "checkbox";
  input.checked = Boolean(value);
  input.addEventListener("change", () => {
    update(input.checked);
    render();
  });
  group.append(input, document.createTextNode(label));
  parent.append(group);
}

function fieldEditor(embed, parent) {
  const area = node("div");
  function draw() {
    area.replaceChildren();
    embed.fields.forEach((model, index) => {
      const item = node("div", "", "field-editor");
      const toolbar = node("div", "", "embed-tools");
      toolbar.append(node("h3", "Field " + (index + 1)), button("Remove field", () => {
        embed.fields.splice(index, 1);
        draw();
        render();
      }, "quiet"));
      item.append(toolbar);
      field(item, model, "name", "Name", {limit: 256});
      field(item, model, "value", "Value", {limit: 1024, rows: 2});
      checkbox(item, "Show inline", model.inline, (isChecked) => { model.inline = isChecked; });
      area.append(item);
    });
    const add = button("+ Add field", () => {
      embed.fields.push({name: "", value: "", inline: false});
      draw();
      render();
      area.querySelector(".field-editor:last-of-type input")?.focus();
    }, "field-add");
    add.disabled = embed.fields.length >= 25;
    area.append(add);
  }
  draw();
  parent.append(area);
}

function embedEditor(embed, index) {
  const section = node("section", "", "embed-editor");
  const tools = node("div", "", "embed-tools");
  tools.append(node("h3", "Embed " + (index + 1)), button("Remove embed", () => {
    embeds.splice(index, 1);
    drawEmbeds();
    render();
    $("add-embed").focus();
  }, "quiet"));
  section.append(tools);
  field(section, embed, "title", "Title", {limit: 256});
  field(section, embed, "description", "Description", {limit: 4096, rows: 3});
  const main = node("div", "", "form-grid");
  field(main, embed, "color", "Accent color", {limit: 7, placeholder: "#A78BFA"});
  field(main, embed, "image", "Image URL", {type: "url", placeholder: "https://…"});
  section.append(main);
  const details = node("details");
  details.append(node("summary", "Links, author, and footer"));
  const extras = node("div", "", "form-grid");
  for (const [key, label, type, limit] of [
    ["url", "Title link", "url"], ["thumbnail", "Thumbnail URL", "url"],
    ["author", "Author name", "text", 256], ["authorUrl", "Author link", "url"],
    ["authorIcon", "Author icon URL", "url"], ["footer", "Footer text", "text"],
    ["footerIcon", "Footer icon URL", "url"],
  ]) field(extras, embed, key, label, {type, limit});
  details.append(extras);
  checkbox(details, "Include timestamp", embed.timestamp, (isChecked) => {
    embed.timestamp = isChecked ? new Date().toISOString() : "";
  });
  section.append(details);
  fieldEditor(embed, section);
  return section;
}

function drawEmbeds() {
  $("embed-list").replaceChildren(...embeds.map(embedEditor));
}

function drawFiles() {
  $("file-list").replaceChildren(...files.map((file, index) => button("Remove " + file.name, () => {
    URL.revokeObjectURL(file.url);
    files.splice(index, 1);
    drawFiles();
    render();
    $("files").focus();
  })));
}

function clearFiles() {
  for (const file of files) URL.revokeObjectURL(file.url);
  files.length = 0;
  $("files").value = "";
  drawFiles();
}

function setDraft(draft) {
  $("content").value = draft?.content || "";
  $("ping").checked = false;
  embeds.splice(0, embeds.length, ...structuredClone(draft?.embeds || []));
  clearFiles();
  drawEmbeds();
  render();
}

function setChannels(preferred) {
  const select = $("channel");
  const start = node("option", targets.length ? "Choose a channel" : "No sendable channels");
  start.value = "";
  select.replaceChildren(start);
  for (const item of targets) {
    const label = (item.category ? item.category + " / " : "") + "#" + item.name + (item.announcement ? " · Announcement" : "");
    const opt = node("option", label);
    opt.value = item.id;
    select.append(opt);
  }
  select.value = targets.some((item) => item.id === preferred) ? preferred : "";
  render();
}

async function loadChannels() {
  const preferred = $("channel").value;
  $("refresh").disabled = true;
  notice("channel-status", "");
  try {
    const data = await api("/api/channels");
    targets = data.channels;
    sender = data.bot.name;
    $("server-name").textContent = data.guild;
    $("bot-name").textContent = sender;
    $("bot-avatar").textContent = Array.from(sender)[0]?.toUpperCase() || "B";
    if (!targets.length) notice("channel-status", "Give the bot View Channel and Send Messages in at least one text or announcement channel.", true);
  } catch (error) {
    targets = [];
    notice("channel-status", error.message, true);
  }
  setChannels(preferred);
}

$("content").addEventListener("input", render);
$("channel").addEventListener("change", () => {
  notice("action-status", "");
  render();
});
$("add-embed").addEventListener("click", () => {
  embeds.push({fields: []});
  $("embed-list").append(embedEditor(embeds.at(-1), embeds.length - 1));
  $("embed-list").lastElementChild.querySelector("input").focus();
  render();
});
$("files").addEventListener("change", ({target}) => {
  const added = Array.from(target.files);
  target.value = "";
  const total = added.reduce((size, file) => size + file.size, files.reduce((size, file) => size + file.size, 0));
  if (files.length + added.length > 10 || total > 8 * 1024 * 1024 || added.some((file) => !file.size || !["image/jpeg", "image/gif", "image/png", "image/webp"].includes(file.type))) {
    notice("action-status", "Choose up to 10 PNG, JPEG, GIF, or WebP images totaling 8 MiB or less.", true);
    return;
  }
  for (const file of added) files.push({file, name: file.name, url: URL.createObjectURL(file)});
  notice("action-status", "");
  drawFiles();
  render();
});

function fileData({file}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({name: file.name, type: file.type, data: reader.result.split(",")[1]});
    reader.onerror = () => reject(Error("An image could not be read. Remove it and attach it again."));
    reader.readAsDataURL(file);
  });
}

function localInput(date) {
  const pad = (number) => String(number).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
    + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function formatTime(time) {
  return new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(time);
}

function updateScheduleTime() {
  const time = new Date($("send-at").value);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezone = Number.isFinite(time.getTime())
    ? new Intl.DateTimeFormat(undefined, {timeZoneName: "short"}).formatToParts(time)
      .find(({type}) => type === "timeZoneName")?.value
    : "";
  $("time-zone").textContent = "Browser time zone · " + zone + (timezone ? " (" + timezone + ")" : "");
}

function review(schedule = false) {
  const channel = selectedChannel();
  if (!channel || busy) return;
  if ((embeds.length && !channel.embed) || (files.length && !channel.attach)) {
    notice("action-status", embeds.length && !channel.embed ? "The bot needs Embed Links in this channel." : "The bot needs Attach Files in this channel.", true);
    return;
  }
  pending = {
    channel: channel.id, edit: editTarget, files: files.slice(), schedule,
    nonce: Array.from(crypto.getRandomValues(new Uint8Array(12)), (value) => value.toString(16).padStart(2, "0")).join(""),
    draft: {content: $("content").value, embeds: structuredClone(embeds), ping: $("ping").checked},
  };
  $("confirm-title").textContent = schedule ? "Schedule this message?" : (editTarget ? "Save this edit?" : "Send this message?");
  $("confirm-detail").textContent = (schedule ? "Schedule a post to #" : (editTarget ? "Update the message in #" : "Post to #"))
    + channel.name + " as " + sender + ".";
  $("publish").textContent = schedule ? "Schedule message" : (editTarget ? "Save edit" : "Send message");
  $("schedule-fields").hidden = !schedule;
  $("send-at").required = schedule;
  notice("time-error", "");
  if (schedule) {
    $("send-at").min = localInput(new Date());
    if (!(new Date($("send-at").value).getTime() > Date.now())) {
      $("send-at").value = localInput(new Date(Date.now() + 60 * 60_000));
    }
    updateScheduleTime();
  }
  $("confirm").returnValue = "";
  $("confirm").showModal();
  if (schedule) $("send-at").focus();
  else $("confirm").querySelector('[value="cancel"]').focus();
}

$("review").addEventListener("click", () => review());
$("schedule").addEventListener("click", () => review(true));
$("send-at").addEventListener("change", () => {
  updateScheduleTime();
  notice("time-error", "");
});
$("confirm-form").addEventListener("submit", (event) => {
  if (event.submitter !== $("publish") || !pending?.schedule) return;
  const input = $("send-at").value;
  const date = new Date(input);
  if (!(date.getTime() > Date.now()) || localInput(date) !== input) {
    event.preventDefault();
    notice("time-error", "Choose a valid future time in your browser’s time zone.", true);
    return;
  }
  pending.sendAt = date.getTime();
});

$("confirm").addEventListener("close", async () => {
  const send = pending;
  pending = null;
  if ($("confirm").returnValue !== "publish" || !send || busy) return;
  busy = true;
  notice("action-status", send.schedule ? "Saving to the schedule…" : (send.edit ? "Saving edit…" : "Sending to Discord…"));
  lockEditor(true);
  render();
  try {
    const images = await Promise.all(send.files.map(fileData));
    const path = send.schedule ? "/api/schedule" : ("/api/messages" + (send.edit ? "/" + send.channel + "/" + send.edit.id : ""));
    const result = await api(path, send.edit ? "PATCH" : "POST", {
      channel: send.channel, nonce: send.nonce, sendAt: send.sendAt, draft: {...send.draft, files: images},
    });
    if (send.schedule) {
      setDraft(null);
      notice("action-status", "Scheduled for " + formatTime(result.sendAt) + " in #" + result.channelName + ".");
      void loadSchedule();
      return;
    }
    const imagesForReuse = send.files.length ? send.files.map(({file}) => file) : (send.edit?.images || []);
    receipt = {...result, draft: send.draft, images: imagesForReuse};
    editTarget = null;
    $("ping").checked = false;
    $("receipt-text").textContent = (send.edit ? "Updated in #" : "Sent to #") + result.name;
    $("receipt-link").href = result.url;
    $("receipt").hidden = false;
    notice("action-status", "");
  } catch (error) {
    notice("action-status", error.message, true);
  } finally {
    busy = false;
    lockEditor(false);
    render();
  }
});

function lockEditor(locked) {
  $("receipt").inert = locked;
  document.querySelector(".composer").inert = locked;
  $("cancel-edit").disabled = locked;
}

$("refresh").addEventListener("click", loadChannels);

const statusLabels = {
  queued: "Scheduled", checking: "Checking channel", sending: "Sending",
  sent: "Sent", failed: "Failed", uncertain: "Check channel", canceled: "Canceled",
};

function scheduledRow(job) {
  const row = node("li");
  const content = node("div");
  const state = node("span", statusLabels[job.status] || job.status, "schedule-state");
  state.classList.add(job.status);
  content.append(node("strong", job.summary), node("p", "#" + job.channelName + " · " + formatTime(job.sendAt), "muted"), state);
  if (job.detail) content.append(node("p", job.detail, "muted"));
  const link = safeURL(job.messageUrl);
  if (link) content.append(node("br"), makeLink("Open in Discord", link));
  row.append(content);
  if (job.status === "queued") {
    const cancel = button("Cancel", async () => {
      cancel.disabled = true;
      try {
        await api("/api/schedule/" + job.id, "DELETE");
        await loadSchedule();
      } catch (error) {
        notice("schedule-status", error.message, true);
        cancel.disabled = false;
      }
    });
    cancel.setAttribute("aria-label", "Cancel scheduled message for #" + job.channelName + " on " + formatTime(job.sendAt));
    row.append(cancel);
  }
  return row;
}

async function loadSchedule() {
  if (scheduleLoading) return;
  scheduleLoading = true;
  $("refresh-schedule").disabled = true;
  try {
    const result = await api("/api/schedule");
    scheduleAvailable = result.available;
    $("schedule-list").replaceChildren(...result.jobs.map(scheduledRow));
    notice("schedule-status", !result.available ? "Attach a Railway volume at /data and redeploy to enable scheduling."
      : (result.jobs.length ? "" : "No messages scheduled yet."));
  } catch (error) {
    notice("schedule-status", error.message, true);
  } finally {
    scheduleLoading = false;
    $("refresh-schedule").disabled = false;
    render();
  }
}

$("refresh-schedule").addEventListener("click", loadSchedule);
$("reset").addEventListener("click", () => {
  setDraft(null);
  notice("action-status", "");
  $("content").focus();
});
$("again").addEventListener("click", () => {
  const source = receipt;
  editTarget = null;
  setDraft(source.draft);
  for (const file of source.images) files.push({file, name: file.name, url: URL.createObjectURL(file)});
  drawFiles();
  setChannels("");
  $("channel").focus();
});
$("edit").addEventListener("click", () => {
  editTarget = receipt;
  setDraft(receipt.draft);
  setChannels(receipt.channel);
  $("content").focus();
});
$("cancel-edit").addEventListener("click", () => {
  editTarget = null;
  setDraft(null);
  notice("action-status", "");
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", "POST");
    location.href = "/";
  } catch (error) {
    notice("action-status", error.message, true);
  }
});

$("signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("signin-submit").disabled = true;
  notice("signin-error", "");
  try {
    await api("/api/login", "POST", {password: $("password").value});
    $("password").value = "";
    location.href = "/";
  } catch (error) {
    notice("signin-error", error.message, true);
    $("password").focus();
  } finally {
    $("signin-submit").disabled = false;
  }
});

try {
  const {authenticated} = await api("/api/session");
  if (authenticated) {
    $("logout").hidden = false;
    $("studio").hidden = false;
    await Promise.all([loadChannels(), loadSchedule()]);
    setInterval(() => { if (!document.hidden) void loadSchedule(); }, 15_000);
  } else {
    $("signin").hidden = false;
    $("password").focus();
  }
} catch {
  $("signin").hidden = false;
  notice("signin-error", "The editor could not load. Refresh to try again.", true);
} finally {
  $("loading").hidden = true;
}
