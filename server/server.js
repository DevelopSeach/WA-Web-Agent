import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./db.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistDir = path.resolve(__dirname, "..", process.env.CLIENT_DIST_DIR || "client/dist");

function requireToken(req, res, next) {
  const expected = process.env.WEBHOOK_TOKEN;
  if (!expected) return next();
  const token = req.headers["x-api-token"];
  if (token !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

function normalizeUid(msg) {
  return msg.uid || msg.payload?.tag || `${msg.event_type || "event"}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "wa-web-agent-server" });
});

app.post("/api/whatsapp-webhook", requireToken, async (req, res) => {
  const msg = req.body || {};
  msg.uid = normalizeUid(msg);

  const capturedAt = msg.captured_at ? new Date(msg.captured_at) : new Date();

  const sql = `
    INSERT INTO wa_messages
    (message_uid, event_type, source, chat_title, sender, direction, sent_at_text, captured_at, message_text, media_json, reactions_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON))
    ON DUPLICATE KEY UPDATE
      event_type = VALUES(event_type),
      source = VALUES(source),
      chat_title = VALUES(chat_title),
      sender = VALUES(sender),
      direction = VALUES(direction),
      sent_at_text = VALUES(sent_at_text),
      captured_at = VALUES(captured_at),
      message_text = VALUES(message_text),
      media_json = VALUES(media_json),
      reactions_json = VALUES(reactions_json),
      raw_json = VALUES(raw_json)
  `;

  await pool.execute(sql, [
    msg.uid,
    msg.event_type || null,
    msg.source || "whatsapp_web_extension",
    msg.chat_title || msg.payload?.title || null,
    msg.sender || null,
    msg.direction || null,
    msg.sent_at_text || null,
    capturedAt,
    msg.text || msg.payload?.body || null,
    JSON.stringify(msg.media || []),
    JSON.stringify(msg.reactions || []),
    JSON.stringify(msg)
  ]);

  res.json({ ok: true, saved: true, uid: msg.uid });
});

app.get("/api/messages", async (req, res) => {
  const parsedLimit = Number(req.query.limit || 100);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 500)) : 100;
  const chat = String(req.query.chat || "");

  let rows;
  if (chat) {
    [rows] = await pool.execute(
      `SELECT * FROM wa_messages WHERE chat_title LIKE ? ORDER BY id DESC LIMIT ${limit}`,
      [`%${chat}%`]
    );
  } else {
    [rows] = await pool.execute(`SELECT * FROM wa_messages ORDER BY id DESC LIMIT ${limit}`);
  }

  res.json({ ok: true, count: rows.length, messages: rows });
});

app.get("/api/chats", async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT chat_title, COUNT(*) AS total_messages, MAX(created_at) AS last_message_at
    FROM wa_messages
    GROUP BY chat_title
    ORDER BY last_message_at DESC
  `);
  res.json({ ok: true, chats: rows });
});

app.post("/api/commands", requireToken, async (req, res) => {
  const command = req.body || {};
  if (!command.action) return res.status(400).json({ ok: false, error: "Missing command.action" });

  const [result] = await pool.execute(
    `INSERT INTO wa_commands (action, command_json) VALUES (?, CAST(? AS JSON))`,
    [command.action, JSON.stringify(command)]
  );

  res.json({ ok: true, command_id: result.insertId });
});

app.get("/api/commands", requireToken, async (req, res) => {
  const [rows] = await pool.execute(`SELECT * FROM wa_commands ORDER BY id DESC LIMIT 100`);
  res.json({ ok: true, commands: rows });
});

app.get("/api/commands/next", requireToken, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT * FROM wa_commands WHERE status = 'pending' ORDER BY id ASC LIMIT 1 FOR UPDATE`
    );
    if (!rows.length) {
      await conn.commit();
      return res.json({ ok: true, command: null });
    }

    const row = rows[0];
    await conn.execute(`UPDATE wa_commands SET status = 'running', picked_at = NOW() WHERE id = ?`, [row.id]);
    await conn.commit();

    const command = typeof row.command_json === "string" ? JSON.parse(row.command_json) : row.command_json;
    command.id = row.id;
    res.json({ ok: true, command });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

app.post("/api/commands/result", requireToken, async (req, res) => {
  const { command_id, result } = req.body || {};
  if (!command_id) return res.status(400).json({ ok: false, error: "Missing command_id" });

  const ok = result?.ok !== false;
  await pool.execute(
    `UPDATE wa_commands SET status = ?, result_json = CAST(? AS JSON), error_text = ?, completed_at = NOW() WHERE id = ?`,
    [ok ? "done" : "failed", JSON.stringify(result || {}), result?.error || null, command_id]
  );

  res.json({ ok: true });
});

if (fs.existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(clientDistDir, "index.html"));
  });
}

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`WA Web Agent API running on http://localhost:${port}`));
