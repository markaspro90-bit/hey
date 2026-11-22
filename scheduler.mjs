import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./discord.mjs";

const MAX_WAITING = 50;
const MAX_DRAFT_BYTES = 128 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const VOLUME_MESSAGE = "To schedule messages, attach a Railway volume to this service at /data and redeploy.";

export function createScheduler(directory, discord) {
  if (!directory) return null;
  mkdirSync(directory, {recursive: true});
  const database = new DatabaseSync(join(directory, "studio.sqlite"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      summary TEXT NOT NULL,
      draft TEXT,
      created_at INTEGER NOT NULL,
      send_at INTEGER NOT NULL,
      next_attempt INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      detail TEXT,
      message_url TEXT,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_messages(status, next_attempt);
    UPDATE scheduled_messages SET status = 'queued' WHERE status = 'checking';
    UPDATE scheduled_messages
      SET status = 'uncertain', detail = 'Interrupted while sending. Check the channel before scheduling again.',
          draft = NULL, finished_at = unixepoch() * 1000
      WHERE status = 'sending';
  `);

  const fields = "id, channel, channel_name AS channelName, summary, send_at AS sendAt, status, detail, message_url AS messageUrl";
  const find = database.prepare(`SELECT ${fields} FROM scheduled_messages WHERE id = ?`);
  const list = database.prepare(`
    SELECT ${fields} FROM scheduled_messages ORDER BY
      CASE status WHEN 'queued' THEN 0 WHEN 'checking' THEN 0 WHEN 'sending' THEN 0 ELSE 1 END,
      CASE WHEN finished_at IS NULL THEN send_at ELSE -finished_at END, created_at LIMIT 100
  `);
  const capacity = database.prepare("SELECT count(*) AS count, coalesce(sum(length(CAST(draft AS BLOB))), 0) AS bytes FROM scheduled_messages WHERE draft IS NOT NULL");
  const insert = database.prepare(`
    INSERT INTO scheduled_messages (id, channel, channel_name, summary, draft, created_at, send_at, next_attempt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const claim = database.prepare(`
    UPDATE scheduled_messages SET status = 'checking', attempts = attempts + 1, detail = NULL
    WHERE id = (SELECT id FROM scheduled_messages WHERE status = 'queued' AND next_attempt <= ? ORDER BY next_attempt, created_at LIMIT 1)
    RETURNING id, channel, draft, attempts
  `);
  const dispatch = database.prepare("UPDATE scheduled_messages SET status = 'sending' WHERE id = ? AND status = 'checking'");
  const retry = database.prepare("UPDATE scheduled_messages SET status = 'queued', next_attempt = ?, detail = ? WHERE id = ?");
  const finish = database.prepare("UPDATE scheduled_messages SET status = ?, detail = ?, message_url = ?, finished_at = ?, draft = NULL WHERE id = ?");
  const cancel = database.prepare(`
    UPDATE scheduled_messages SET status = 'canceled', finished_at = ?, draft = NULL, detail = NULL
    WHERE id = ? AND status = 'queued'
  `);
  const prune = database.prepare(`
    DELETE FROM scheduled_messages WHERE id IN (
      SELECT id FROM scheduled_messages WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT -1 OFFSET 100
    )
  `);
  let active = null;
  let stopping = false;

  async function publishDue() {
    for (let i = 0; i < 5 && !stopping; i += 1) {
      const job = claim.get(Date.now());
      if (!job) return;
      let dispatched = false;
      try {
        const result = await discord.write(job.channel, JSON.parse(job.draft), job.id, undefined, () => {
          dispatch.run(job.id);
          dispatched = true;
        });
        finish.run("sent", null, result.url, Date.now(), job.id);
      } catch (error) {
        const rateLimited = error.status === 429;
        const temporary = error.status === 502;
        if (job.attempts < MAX_ATTEMPTS && (rateLimited || (temporary && !dispatched))) {
          const delay = rateLimited && Number.isFinite(error.retryAfter) ? Math.max(1000, error.retryAfter) : 5000 * 2 ** (job.attempts - 1);
          retry.run(Date.now() + Math.ceil(delay), rateLimited ? "Discord asked the bot to wait. Retrying automatically." : "Waiting for Discord to respond. Retrying automatically.", job.id);
          continue;
        }
        const uncertain = dispatched && (temporary || !(error instanceof HttpError));
        const detail = uncertain
          ? "Discord did not confirm delivery. Check the channel before scheduling again."
          : error instanceof HttpError ? error.message : "The message could not be sent.";
        finish.run(uncertain ? "uncertain" : "failed", detail, null, Date.now(), job.id);
      }
      prune.run();
    }
  }

  function tick() {
    if (active || stopping) return;
    active = publishDue().catch((error) => console.error("Schedule processing failed", error.name))
      .finally(() => { active = null; });
  }
  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();

  return {
    list: () => list.all(),
    async add(id, channel, sendAt, draft) {
      const existing = find.get(id);
      if (existing) return existing;
      if (!Number.isSafeInteger(sendAt) || sendAt <= Date.now()) {
        throw new HttpError(422, "Choose a date and time in the future.");
      }
      const target = await discord.schedulingChannel(channel, draft);
      const serialized = JSON.stringify(draft);
      const summary = (draft.content?.trim() || draft.embeds[0]?.title?.trim() || draft.embeds[0]?.description?.trim()
        || (draft.embeds.length ? "Embed" : "Image attachment")).replace(/\s+/g, " ").slice(0, 100);
      const repeated = find.get(id);
      if (repeated) return repeated;
      const usage = capacity.get();
      if (usage.count >= MAX_WAITING || usage.bytes + Buffer.byteLength(serialized) > MAX_DRAFT_BYTES) {
        throw new HttpError(422, "The schedule queue is full. Remove a queued message or wait for one to send.");
      }
      insert.run(id, channel, target.name, summary, serialized, Date.now(), sendAt, sendAt);
      return find.get(id);
    },
    cancel(id) {
      if (!cancel.run(Date.now(), id).changes) {
        throw new HttpError(409, "This message is no longer waiting to send. Refresh the schedule to see its status.");
      }
      prune.run();
      return find.get(id);
    },
    async close() {
      stopping = true;
      clearInterval(timer);
      await active;
      database.close();
    },
  };
}

export function requireScheduler(scheduler) {
  if (!scheduler) throw new HttpError(409, VOLUME_MESSAGE);
  return scheduler;
}
