import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { discordClient, discordRequest, HttpError, SNOWFLAKE } from "./discord.mjs";

const ASSETS = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/styles.css", ["styles.css", "text/css"]],
]);
const WEEK = 7 * 24 * 60 * 60;
const MAX_BODY = 12 * 1024 * 1024;

export function loadConfig(env) {
  const local = `http://localhost:${env.PORT || 3000}`;
  const app = new URL(env.APP_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : local));
  if ((app.protocol !== "https:" && !(app.protocol === "http:" && ["localhost", "127.0.0.1"].includes(app.hostname))) ||
      app.username || app.password || app.pathname !== "/" || app.search || app.hash) {
    throw Error("Set APP_URL to the site's origin, using HTTPS for a public deployment.");
  }
  const ids = (env.OWNER_IDS?.trim() || env.OWNER_ID?.trim() || "").split(",").map((id) => id.trim());
  const clientId = env.DISCORD_CLIENT_ID?.trim();
  const guildId = env.GUILD_ID?.trim();
  const botToken = env.DISCORD_TOKEN?.trim();
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  if (!botToken || !clientSecret || !SNOWFLAKE.test(clientId || "") || !SNOWFLAKE.test(guildId || "") || !ids.every((id) => SNOWFLAKE.test(id))) {
    throw Error("Set DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, GUILD_ID, and a comma-separated OWNER_IDS list.");
  }
  return {app, botToken, clientId, clientSecret, guildId, owners: new Set(ids)};
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((pair) => pair.trim().split(/=(.*)/s).slice(0, 2)));
}

function cookie(config, key, value, maxAge) {
  return `${key}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${config.app.protocol === "https:" ? "; Secure" : ""}`;
}

function signed(config, value) {
  return createHmac("sha256", config.clientSecret).update(value).digest("base64url");
}

function session(config, req) {
  const raw = cookies(req).studio_session || "";
  const [key, mac, extra] = raw.split(".");
  if (!mac || extra !== undefined || mac.length !== 43) return null;
  if (Buffer.byteLength(mac) !== 43 || !timingSafeEqual(Buffer.from(mac), Buffer.from(signed(config, key)))) return null;
  try {
    const identity = JSON.parse(Buffer.from(key, "base64url").toString());
    return identity.expires > Date.now() && config.owners.has(identity.id) ? identity : null;
  } catch {
    return null;
  }
}

function sendJSON(res, status, data) {
  res.writeHead(status, {"Content-Type": "application/json; charset=utf-8"});
  res.end(JSON.stringify(data));
}

function redirect(res, location, setCookie = []) {
  res.writeHead(303, {"Location": location, "Set-Cookie": setCookie});
  res.end();
}

async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) {
    throw new HttpError(415, "Send data as JSON.");
  }
  if (Number(req.headers["content-length"]) > MAX_BODY) throw new HttpError(413, "The request is too large.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "The request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request body is invalid.");
  }
}

export function createApp(config, request = discordRequest) {
  const discord = discordClient(config, request);
  const receipts = new Map();
  const callback = new URL("/auth/discord/callback", config.app).href;
  async function finishLogin(req, res, query) {
    const state = cookies(req).studio_oauth;
    const clearState = cookie(config, "studio_oauth", "", 0);
    const code = query.get("code");
    if (!code || !state || state !== query.get("state")) return redirect(res, "/?signin=expired", [clearState]);
    try {
      const tokens = await request("/oauth2/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: config.clientId, client_secret: config.clientSecret, grant_type: "authorization_code",
          code, redirect_uri: callback,
        }),
      });
      if (!tokens.access_token) throw Error();
      const user = await request("/users/@me", {bearer: tokens.access_token});
      if (!config.owners.has(user.id)) return redirect(res, "/?signin=denied", [clearState]);
      const identity = Buffer.from(JSON.stringify({
        id: user.id, name: (user.global_name || user.username || "Discord user").slice(0, 80),
        expires: Date.now() + WEEK * 1000,
      })).toString("base64url");
      return redirect(res, "/", [clearState, cookie(config, "studio_session", `${identity}.${signed(config, identity)}`, WEEK)]);
    } catch {
      return redirect(res, "/?signin=error", [clearState]);
    }
  }
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://discord.com");
    try {
      const {pathname: path, searchParams: query} = new URL(req.url, config.app);
      const method = req.method;
      if (method === "GET" && path === "/healthz") return sendJSON(res, 200, {ok: true});
      if (method === "GET" && ASSETS.has(path)) {
        const [file, type] = ASSETS.get(path);
        const bytes = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, {"Content-Type": `${type}; charset=utf-8`});
        return res.end(bytes);
      }
      if (method === "GET" && path === "/auth/discord") {
        const state = randomBytes(24).toString("base64url");
        const login = new URL("https://discord.com/oauth2/authorize");
        login.search = new URLSearchParams({
          client_id: config.clientId, response_type: "code", scope: "identify", redirect_uri: callback, state,
        });
        return redirect(res, login.href, [cookie(config, "studio_oauth", state, 600)]);
      }
      if (method === "GET" && path === "/auth/discord/callback") return await finishLogin(req, res, query);
      const identity = session(config, req);
      if (method === "GET" && path === "/api/session") {
        return sendJSON(res, 200, {user: identity ? {id: identity.id, name: identity.name} : null});
      }
      if (!path.startsWith("/api/")) throw new HttpError(404, "Page not found.");
      if (!identity) throw new HttpError(401, "Sign in with an approved Discord account.");
      if (method === "GET" && path === "/api/channels") return sendJSON(res, 200, await discord.channels());
      if (!["POST", "PATCH"].includes(method) || req.headers.origin !== config.app.origin || req.headers["x-studio-request"] !== "1") {
        throw new HttpError(403, "Open the editor at its configured public URL and try again.");
      }
      if (path === "/api/logout" && method === "POST") {
        res.setHeader("Set-Cookie", cookie(config, "studio_session", "", 0));
        return sendJSON(res, 200, {ok: true});
      }
      const edit = path.match(/^\/api\/messages\/([0-9]+)\/([0-9]+)$/);
      if (!(method === "POST" && path === "/api/messages") && !(method === "PATCH" && edit)) {
        throw new HttpError(404, "Action not found.");
      }
      const input = await body(req);
      const channel = edit?.[1] ?? input?.channel;
      const message = edit?.[2];
      if (typeof channel !== "string" || !SNOWFLAKE.test(channel) || (message && !SNOWFLAKE.test(message))) {
        throw new HttpError(422, "Choose a valid destination channel.");
      }
      if (typeof input?.nonce !== "string" || !/^[a-f0-9]{24}$/.test(input.nonce)) throw new HttpError(422, "Review the draft again before sending.");
      const now = Date.now();
      for (const [key, entry] of receipts) {
        if (now >= entry.expires) receipts.delete(key);
      }
      const key = `${identity.id}:${method}:${channel}:${message || ""}:${input.nonce}`;
      if (!receipts.has(key)) {
        if (receipts.size >= 512) throw new HttpError(429, "The editor is busy. Wait a few minutes and try again.");
        receipts.set(key, {expires: now + 5 * 60_000, result: discord.write(channel, input.draft, input.nonce, message)});
      }
      return sendJSON(res, 200, await receipts.get(key).result);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJSON(res, error.status, {error: error.message});
      } else {
        console.error("Request failed", error.name);
        sendJSON(res, 500, {error: "The editor encountered an unexpected error."});
      }
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    if (existsSync(".env")) process.loadEnvFile(".env");
    const port = Number(process.env.PORT || 3000);
    const server = createApp(loadConfig(process.env));
    server.listen(port, "0.0.0.0", () => console.log(`Message Studio listening on port ${port}`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
