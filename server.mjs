import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { discordClient, discordRequest, HttpError, SNOWFLAKE } from "./discord.mjs";
import { createScheduler, requireScheduler } from "./scheduler.mjs";

const ASSETS = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/styles.css", ["styles.css", "text/css"]],
]);
const WEEK = 7 * 24 * 60 * 60;
const MAX_BODY = 12 * 1024 * 1024;
const NONCE = /^[a-f0-9]{24}$/;
const LOGIN_BODY = 4096;
const LOGIN_WINDOW = 5 * 60_000;

function passwordHash(password) {
  return createHash("sha256").update(password).digest();
}

export function loadConfig(env) {
  const local = `http://localhost:${env.PORT || 3000}`;
  const app = new URL(env.APP_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : local));
  if ((app.protocol !== "https:" && !(app.protocol === "http:" && ["localhost", "127.0.0.1"].includes(app.hostname))) ||
      app.username || app.password || app.pathname !== "/" || app.search || app.hash) {
    throw Error("Set APP_URL to the site's origin, using HTTPS for a public deployment.");
  }
  const guildId = env.GUILD_ID?.trim();
  const botToken = env.DISCORD_TOKEN?.trim();
  const password = env.STUDIO_PASSWORD;
  if (!botToken || !SNOWFLAKE.test(guildId || "")) {
    throw Error("Set DISCORD_TOKEN and GUILD_ID in the website service's Variables tab.");
  }
  if (!password || password.trim().length < 8 || Buffer.byteLength(password) > 512) {
    throw Error("Set STUDIO_PASSWORD to a private password with at least 8 characters and at most 512 bytes.");
  }
  const dataDir = env.RAILWAY_VOLUME_MOUNT_PATH || (env.RAILWAY_ENVIRONMENT_ID ? null : (env.DATA_DIR || ".data"));
  return {
    app, botToken, guildId, dataDir, passwordDigest: passwordHash(password),
    sessionKey: scryptSync(password, "message-studio password sessions v1", 32),
  };
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((pair) => pair.trim().split(/=(.*)/s).slice(0, 2)));
}

function cookie(config, key, value, maxAge) {
  return `${key}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.app.protocol === "https:" ? "; Secure" : ""}`;
}

function signed(config, value) {
  return createHmac("sha256", config.sessionKey).update(value).digest("base64url");
}

function session(config, req) {
  const raw = cookies(req).studio_session || "";
  const [expires, id, mac, extra] = raw.split(".");
  if (extra !== undefined || !/^\d{13}$/.test(expires) || !/^[a-f0-9]{48}$/.test(id || "") || !/^[a-zA-Z0-9_-]{43}$/.test(mac || "")) return null;
  if (Number(expires) <= Date.now()) return null;
  return timingSafeEqual(Buffer.from(mac), Buffer.from(signed(config, `${expires}.${id}`))) ? id : null;
}

function sendJSON(res, status, data) {
  res.writeHead(status, {"Content-Type": "application/json; charset=utf-8"});
  res.end(JSON.stringify(data));
}

async function body(req, limit = MAX_BODY) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) {
    throw new HttpError(415, "Send data as JSON.");
  }
  if (Number(req.headers["content-length"]) > limit) throw new HttpError(413, "The request is too large.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "The request is too large.");
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
  const scheduler = createScheduler(config.dataDir, discord);
  const receipts = new Map();
  const loginAttempts = new Map();
  let loginWindowExpires = Date.now() + LOGIN_WINDOW;
  let loginCount = 0;
  async function login(req, res) {
    if (loginWindowExpires <= Date.now()) {
      loginWindowExpires = Date.now() + LOGIN_WINDOW;
      loginAttempts.clear();
      loginCount = 0;
    }
    const forwarded = req.headers["x-forwarded-for"]?.split(",").at(-1)?.trim();
    const client = forwarded || req.socket.remoteAddress;
    if ((loginAttempts.get(client) || 0) >= 12 || loginCount >= 80) {
      throw new HttpError(429, "Too many password attempts. Try again in a few minutes.");
    }
    loginCount += 1;
    loginAttempts.set(client, (loginAttempts.get(client) || 0) + 1);
    const input = await body(req, LOGIN_BODY);
    if (typeof input?.password !== "string" || !timingSafeEqual(passwordHash(input.password), config.passwordDigest)) {
      throw new HttpError(401, "Incorrect password.");
    }
    loginAttempts.delete(client);
    const value = `${Date.now() + WEEK * 1000}.${randomBytes(24).toString("hex")}`;
    res.setHeader("Set-Cookie", cookie(config, "studio_session", `${value}.${signed(config, value)}`, WEEK));
    return sendJSON(res, 200, {ok: true});
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const {pathname: path} = new URL(req.url, config.app);
      const method = req.method;
      if (method === "GET" && path === "/healthz") return sendJSON(res, 200, {ok: true});
      if (method === "GET" && ASSETS.has(path)) {
        const [file, type] = ASSETS.get(path);
        const bytes = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, {"Content-Type": `${type}; charset=utf-8`});
        return res.end(bytes);
      }
      const identity = session(config, req);
      if (method === "GET" && path === "/api/session") {
        return sendJSON(res, 200, {authenticated: Boolean(identity)});
      }
      if (!path.startsWith("/api/")) throw new HttpError(404, "Page not found.");
      if (method !== "GET" && (req.headers.origin !== config.app.origin || req.headers["x-studio-request"] !== "1")) {
        throw new HttpError(403, "Open the editor at its configured public URL and try again.");
      }
      if (path === "/api/login" && method === "POST") return await login(req, res);
      if (!identity) throw new HttpError(401, "Enter the website password to continue.");
      if (method === "GET" && path === "/api/channels") return sendJSON(res, 200, await discord.channels());
      if (method === "GET" && path === "/api/schedule") {
        return sendJSON(res, 200, {available: Boolean(scheduler), jobs: scheduler?.list() || []});
      }
      if (path === "/api/logout" && method === "POST") {
        res.setHeader("Set-Cookie", cookie(config, "studio_session", "", 0));
        return sendJSON(res, 200, {ok: true});
      }
      if (path === "/api/schedule" && method === "POST") {
        const queue = requireScheduler(scheduler);
        const input = await body(req);
        if (typeof input?.channel !== "string" || !SNOWFLAKE.test(input.channel)) throw new HttpError(422, "Choose a valid destination channel.");
        if (typeof input.nonce !== "string" || !NONCE.test(input.nonce)) throw new HttpError(422, "Review the draft again before scheduling.");
        return sendJSON(res, 200, await queue.add(input.nonce, input.channel, input.sendAt, input.draft));
      }
      const canceled = path.match(/^\/api\/schedule\/([a-f0-9]{24})$/);
      if (canceled && method === "DELETE") return sendJSON(res, 200, requireScheduler(scheduler).cancel(canceled[1]));
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
      if (typeof input?.nonce !== "string" || !NONCE.test(input.nonce)) throw new HttpError(422, "Review the draft again before sending.");
      const now = Date.now();
      for (const [key, entry] of receipts) {
        if (now >= entry.expires) receipts.delete(key);
      }
      const key = `${identity}:${method}:${channel}:${message || ""}:${input.nonce}`;
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
  server.once("close", () => scheduler?.close().catch((error) => console.error("Schedule shutdown failed", error.name)));
  return server;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    if (existsSync(".env")) process.loadEnvFile(".env");
    const port = Number(process.env.PORT || 3000);
    const server = createApp(loadConfig(process.env));
    server.listen(port, "0.0.0.0", () => console.log(`Message Studio listening on port ${port}`));
    process.once("SIGTERM", () => server.close());
    process.once("SIGINT", () => server.close());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
