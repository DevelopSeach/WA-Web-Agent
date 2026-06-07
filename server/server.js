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

function normalizePhoneCandidate(value) {
  const text = String(value || "").trim();
  const hasPlus = text.startsWith("+");
  const digits = text.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return hasPlus ? `+${digits}` : digits;
}

function isGenericDisplayName(value) {
  const text = String(value || "").trim().toLowerCase();
  return [
    "",
    "chats",
    "channels",
    "channel",
    "communities",
    "updates in status",
    "status",
    "search",
    "online",
    "business account",
    "whatsapp business on web",
    "לא ידוע"
  ].includes(text);
}

function parseJsonMaybe(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function chooseBestName(candidates) {
  return candidates.find((candidate) => {
    const text = String(candidate || "").trim();
    return text && !isGenericDisplayName(text) && !normalizePhoneCandidate(text);
  }) || null;
}

function isNoisyMessageText(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return true;
  if ([
    "online",
    "business account"
  ].includes(text)) return true;

  return [
    "updates in status",
    "channels",
    "communities",
    "last seen today",
    "last seen ",
    "messages and calls are end-to-end encrypted",
    "click here for contact info",
    "click here for group info",
    "changed this group's icon",
    "invite to group via link",
    "add members",
    "add description",
    "created today by",
    "this message was deleted",
    "uses a default timer for disappearing messages",
    "new messages will disappear from this chat"
  ].some((needle) => text.includes(needle));
}

function isMalformedSidebarRow(row) {
  const raw = parseJsonMaybe(row.raw_json);
  if (String(row.source || raw.source || "") !== "whatsapp_web_extension_sidebar") return false;

  const title = String(row.chat_title || raw.chat_title || "").trim();
  const sender = String(row.sender || raw.sender || "").trim();
  const text = String(row.message_text || raw.text || "").trim();

  if (!title && !sender) return true;
  if (isNoisyMessageText(text)) return true;
  if (title && text && title === text) return true;
  if (sender && text && sender === text) return true;
  if (!sender && text.startsWith("\"")) return true;
  return false;
}

function shouldExposeRow(row) {
  if (String(row.event_type || "") !== "message") return true;
  const raw = parseJsonMaybe(row.raw_json);
  const title = String(row.chat_title || raw.chat_title || "").trim();
  const targetName = String(raw.target_name || "").trim();
  const text = String(row.message_text || raw.text || "").trim();

  if (isNoisyMessageText(text)) return false;
  if (isGenericDisplayName(title) || isGenericDisplayName(targetName)) return false;
  if (isMalformedSidebarRow(row)) return false;
  return true;
}

async function enrichRowsWithResolvedNames(rows) {
  const needPhones = new Set();
  const enrichedRows = rows.map((row) => {
    const raw = parseJsonMaybe(row.raw_json);
    const senderPhone = normalizePhoneCandidate(raw.sender_phone || row.sender || row.chat_title);
    const targetPhone = normalizePhoneCandidate(raw.target_phone || raw.target_name || row.chat_title);
    if (senderPhone) needPhones.add(senderPhone);
    if (targetPhone) needPhones.add(targetPhone);
    return { ...row, raw_json: raw };
  });

  if (!needPhones.size) return enrichedRows;

  const [historyRows] = await pool.execute(`
    SELECT sender, chat_title, raw_json
    FROM wa_messages
    WHERE event_type = 'message'
    ORDER BY id DESC
    LIMIT 5000
  `);

  const phoneToName = new Map();
  historyRows.forEach((historyRow) => {
    const raw = parseJsonMaybe(historyRow.raw_json);
    const senderPhone = normalizePhoneCandidate(raw.sender_phone || historyRow.sender || historyRow.chat_title);
    const targetPhone = normalizePhoneCandidate(raw.target_phone || raw.target_name || historyRow.chat_title);
    const preferredName = chooseBestName([
      raw.sender_resolved_name,
      historyRow.sender,
      raw.target_resolved_name,
      raw.target_name,
      historyRow.chat_title
    ]);

    if (preferredName && senderPhone && !phoneToName.has(senderPhone)) phoneToName.set(senderPhone, preferredName);
    if (preferredName && targetPhone && !phoneToName.has(targetPhone)) phoneToName.set(targetPhone, preferredName);
  });

  return enrichedRows.map((row) => {
    const raw = { ...row.raw_json };
    const senderPhone = normalizePhoneCandidate(raw.sender_phone || row.sender || row.chat_title);
    const targetPhone = normalizePhoneCandidate(raw.target_phone || raw.target_name || row.chat_title);

    if (!raw.sender_resolved_name && senderPhone && phoneToName.has(senderPhone)) {
      raw.sender_resolved_name = phoneToName.get(senderPhone);
    }
    if (!raw.target_resolved_name && targetPhone && phoneToName.has(targetPhone)) {
      raw.target_resolved_name = phoneToName.get(targetPhone);
    }

    return { ...row, raw_json: raw };
  });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "wa-web-agent-server" });
});

app.post("/api/whatsapp-webhook", requireToken, async (req, res) => {
  const msg = req.body || {};
  msg.uid = normalizeUid(msg);

  const capturedAt = msg.captured_at ? new Date(msg.captured_at) : new Date();

  if ((msg.event_type || "") === "message") {
    const [existingRows] = await pool.execute(
      `SELECT id, message_uid
       FROM wa_messages
       WHERE event_type = 'message'
         AND message_uid <> ?
         AND COALESCE(chat_title, '') = COALESCE(?, '')
         AND COALESCE(sender, '') = COALESCE(?, '')
         AND COALESCE(message_text, '') = COALESCE(?, '')
         AND COALESCE(sent_at_text, '') = COALESCE(?, '')
       ORDER BY id DESC
       LIMIT 1`,
      [
        msg.uid,
        msg.chat_title || msg.payload?.title || null,
        msg.sender || null,
        msg.text || msg.payload?.body || null,
        msg.sent_at_text || null
      ]
    );

    if (existingRows.length) {
      return res.json({ ok: true, saved: false, duplicate: true, uid: existingRows[0].message_uid, duplicate_of: existingRows[0].id });
    }
  }

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
  const includeEvents = String(req.query.include_events || "").toLowerCase() === "true";

  let rows;
  if (chat) {
    if (includeEvents) {
      [rows] = await pool.execute(
        `SELECT * FROM wa_messages WHERE chat_title LIKE ? ORDER BY id DESC LIMIT ${limit}`,
        [`%${chat}%`]
      );
    } else {
      [rows] = await pool.execute(
        `SELECT * FROM wa_messages WHERE event_type = 'message' AND chat_title LIKE ? ORDER BY id DESC LIMIT ${limit}`,
        [`%${chat}%`]
      );
    }
  } else {
    if (includeEvents) {
      [rows] = await pool.execute(`SELECT * FROM wa_messages ORDER BY id DESC LIMIT ${limit}`);
    } else {
      [rows] = await pool.execute(`SELECT * FROM wa_messages WHERE event_type = 'message' ORDER BY id DESC LIMIT ${limit}`);
    }
  }

  rows = await enrichRowsWithResolvedNames(rows);
  rows = rows.filter(shouldExposeRow);
  res.json({ ok: true, count: rows.length, messages: rows });
});

app.get("/api/messages/export", requireToken, async (req, res) => {
  const includeEvents = String(req.query.include_events || "").toLowerCase() === "true";
  const chat = String(req.query.chat || "");

  let rows;
  if (chat) {
    if (includeEvents) {
      [rows] = await pool.execute(
        `SELECT * FROM wa_messages WHERE chat_title LIKE ? ORDER BY id DESC`,
        [`%${chat}%`]
      );
    } else {
      [rows] = await pool.execute(
        `SELECT * FROM wa_messages WHERE event_type = 'message' AND chat_title LIKE ? ORDER BY id DESC`,
        [`%${chat}%`]
      );
    }
  } else {
    if (includeEvents) {
      [rows] = await pool.execute(`SELECT * FROM wa_messages ORDER BY id DESC`);
    } else {
      [rows] = await pool.execute(`SELECT * FROM wa_messages WHERE event_type = 'message' ORDER BY id DESC`);
    }
  }

  rows = await enrichRowsWithResolvedNames(rows);
  rows = rows.filter(shouldExposeRow);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=\"wa-messages-${timestamp}.json\"`);
  res.send(JSON.stringify({ ok: true, exported_at: new Date().toISOString(), include_events: includeEvents, count: rows.length, messages: rows }, null, 2));
});

app.delete("/api/messages", requireToken, async (req, res) => {
  const [result] = await pool.execute(`DELETE FROM wa_messages`);
  res.json({ ok: true, deleted: result.affectedRows || 0 });
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
