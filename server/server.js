import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { pool } from "./db.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistDir = path.resolve(__dirname, "..", process.env.CLIENT_DIST_DIR || "client/dist");
const MEDIA_SERVICE_BASE_URL = String(process.env.MEDIA_SERVICE_BASE_URL || "https://cherrywrapper.hinbit.com").replace(/\/$/, "");
const MEDIA_SERVICE_API_KEY = String(
  process.env.MEDIA_SERVICE_API_KEY
  || process.env.MEDIA_SERVICE_TOKEN
  || process.env.CHERRYWRAPPER_API_KEY
  || ""
).trim();

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

function cleanText(value) {
  return String(value || "")
    .replace(/\u200e/g, "")
    .replace(/[\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extensionFromMimeType(mimeType) {
  const mime = String(mimeType || "").trim().toLowerCase();
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/webm") return "webm";
  if (mime === "audio/ogg") return "ogg";
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "audio/mp4") return "m4a";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "txt";
  return "bin";
}

function inferMimeTypeFromMedia(item) {
  const explicit = cleanText(item?.mime_type);
  if (explicit) return explicit;
  const source = String(item?.src || item?.href || item?.original_src || "").trim();
  const dataMatch = source.match(/^data:([^;,]+)[;,]/i);
  if (dataMatch?.[1]) return dataMatch[1].toLowerCase();
  const kind = String(item?.kind || "").trim().toLowerCase();
  if (kind === "image") return "image/jpeg";
  if (kind === "video") return "video/mp4";
  if (kind === "audio") return "audio/mpeg";
  if (kind === "link") return "application/octet-stream";
  return "application/octet-stream";
}

function buildMediaFilename(item, context = {}) {
  const mimeType = inferMimeTypeFromMedia(item);
  const ext = extensionFromMimeType(mimeType);
  const kind = cleanText(item?.kind || "media").toLowerCase() || "media";
  const base = cleanText(item?.filename || "") || `${context.uid || "message"}-${kind}-${context.index ?? 0}`;
  const sanitized = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `${kind}-${context.index ?? 0}`;
  return sanitized.includes(".") ? sanitized : `${sanitized}.${ext}`;
}

function mediaFolderForItem(item) {
  const kind = cleanText(item?.kind).toLowerCase();
  if (kind === "image") return "images";
  if (kind === "video") return "videos";
  if (kind === "audio") return "audio";
  return "documents";
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!match) return null;
  return {
    mimeType: match[1] || "application/octet-stream",
    base64: match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3] || ""), "utf8").toString("base64")
  };
}

function isWebUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isMegaUrl(value) {
  const url = String(value || "").trim().toLowerCase();
  return url.startsWith("https://mega.nz/")
    || url.startsWith("https://mega.co.nz/")
    || url.startsWith("mega://");
}

function selectUploadedMediaUrl(response = {}) {
  const candidates = [
    response.public_url,
    response.location,
    response.url,
    response.download_url,
    response.stored_path
  ].map((value) => String(value || "").trim()).filter(Boolean);

  const megaCandidate = candidates.find((value) => isMegaUrl(value));
  if (megaCandidate) return megaCandidate;

  const webCandidate = candidates.find((value) => isWebUrl(value));
  if (webCandidate) return webCandidate;

  return candidates[0] || null;
}

function normalizeUploadedMediaResponse(payload) {
  const response = payload && typeof payload === "object" ? payload : {};
  const storageType = String(response.storage_type || "").trim().toLowerCase() || null;
  const mediaUrl = selectUploadedMediaUrl(response);
  const megaUrl = [
    response.location,
    response.public_url,
    response.url,
    response.download_url
  ].map((value) => String(value || "").trim()).find((value) => isMegaUrl(value)) || null;

  return {
    storage_type: storageType,
    stored_path: response.stored_path || null,
    public_url: response.public_url || null,
    location: response.location || null,
    url: response.url || null,
    download_url: response.download_url || null,
    mega_url: megaUrl || (storageType === "mega" ? mediaUrl : null),
    media_url: storageType === "mega"
      ? (megaUrl || mediaUrl || null)
      : (mediaUrl || null)
  };
}

async function uploadMediaItem(item, context = {}) {
  if (!MEDIA_SERVICE_API_KEY) {
    return {
      ...item,
      upload_error: "MEDIA_SERVICE_API_KEY is not configured"
    };
  }

  const source = String(item?.src || item?.href || item?.original_src || "").trim();
  if (!source) return item;

  const existingUrl = cleanText(
    item?.uploaded_url
    || item?.mega_url
    || item?.upload?.mega_url
    || item?.upload?.media_url
    || item?.upload?.public_url
    || item?.upload?.download_url
    || item?.upload?.location
  );
  if (existingUrl) return item;

  if (source.startsWith("blob:")) {
    return {
      ...item,
      upload_error: "blob URLs cannot be uploaded from the server without a transferable payload"
    };
  }

  const filename = buildMediaFilename(item, context);
  const mimeType = inferMimeTypeFromMedia(item);
  const folder = mediaFolderForItem(item);
  const body = {
    filename,
    folder,
    mime_type: mimeType
  };

  const dataUrl = parseDataUrl(source);
  if (dataUrl?.base64) {
    body.base64 = dataUrl.base64;
    body.mime_type = dataUrl.mimeType || mimeType;
  } else if (/^https?:\/\//i.test(source)) {
    body.url = source;
  } else {
    return {
      ...item,
      upload_error: "unsupported media source for upload"
    };
  }

  const response = await fetch(`${MEDIA_SERVICE_BASE_URL}/upload_media`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": MEDIA_SERVICE_API_KEY
    },
    body: JSON.stringify(body)
  });

  const payloadText = await response.text();
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    payload = { raw_response: payloadText };
  }

  if (!response.ok) {
    return {
      ...item,
      upload_error: payload?.error || `upload failed with HTTP ${response.status}`,
      upload_response: payload
    };
  }

  const normalized = normalizeUploadedMediaResponse(payload);
  return {
    ...item,
    upload: normalized,
    uploaded_url: normalized.media_url,
    mega_url: normalized.mega_url || null
  };
}

async function enrichMessageMediaForStorage(message) {
  const media = Array.isArray(message?.media) ? message.media : [];
  if (!media.length) return message;

  const uploadedMedia = await Promise.all(media.map((item, index) => uploadMediaItem(item, {
    uid: message.uid,
    index
  })));

  return {
    ...message,
    media: uploadedMedia
  };
}

function normalizeSentAtText(value) {
  const text = cleanText(value);
  if (!text) return "";
  const timeMatch = text.match(/\b(\d{1,2}:\d{2})\b/);
  if (timeMatch) return timeMatch[1];
  return text.toLowerCase();
}

function chooseBestName(candidates) {
  return candidates.find((candidate) => {
    const text = String(candidate || "").trim();
    return text && !isGenericDisplayName(text) && !normalizePhoneCandidate(text);
  }) || null;
}

function hasReplyMetadata(message) {
  const reply = message?.reply_to;
  return !!(reply && (reply.text || reply.snippet || reply.sender));
}

function hasReactionMetadata(message) {
  return Array.isArray(message?.reactions) && message.reactions.length > 0;
}

function normalizeReplyReference(reply) {
  if (!reply) return null;
  const sender = cleanText(reply.sender);
  const stripSender = (value) => {
    const text = cleanText(value);
    if (!text) return "";
    if (sender && text.startsWith(`${sender} `)) return cleanText(text.slice(sender.length));
    return text;
  };

  const text = stripSender(reply.text);
  const snippet = stripSender(reply.snippet || reply.text);
  return {
    ...reply,
    sender: sender || null,
    text: text || null,
    snippet: snippet || text || null,
    original_msg_id: cleanText(reply.original_msg_id) || null,
    original_msg_sender: cleanText(reply.original_msg_sender || sender) || null
  };
}

function stripReplyPrefix(text, replyTo) {
  const sourceText = cleanText(text);
  const normalizedReply = normalizeReplyReference(replyTo);
  if (!sourceText || !normalizedReply) return sourceText;

  const candidates = [
    normalizedReply.text,
    normalizedReply.snippet,
    cleanText([normalizedReply.sender, normalizedReply.text].filter(Boolean).join(" ")),
    cleanText([normalizedReply.sender, normalizedReply.snippet].filter(Boolean).join(" "))
  ].filter(Boolean);

  let current = sourceText;
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (candidate && current.startsWith(`${candidate} `)) {
        current = cleanText(current.slice(candidate.length));
        changed = true;
      }
    }
  }

  return current;
}

function getNormalizedMessageText(messageLike) {
  const replyTo = normalizeReplyReference(messageLike?.reply_to);
  return stripReplyPrefix(
    messageLike?.text
      || messageLike?.message_text
      || messageLike?.payload?.body
      || "",
    replyTo
  );
}

function getComparableMessageShape(messageLike) {
  const raw = parseJsonMaybe(messageLike?.raw_json);
  const merged = { ...raw, ...messageLike };
  const replyTo = normalizeReplyReference(merged.reply_to);
  return {
    chat_title: cleanText(merged.chat_title || merged.payload?.title || ""),
    sender: cleanText(merged.sender || ""),
    sent_at_text: normalizeSentAtText(merged.sent_at_text || ""),
    message_text: getNormalizedMessageText({ ...merged, reply_to: replyTo }),
    reply_to: replyTo,
    source: cleanText(merged.source || "")
  };
}

function findDuplicateCandidate(rows, message) {
  const incoming = getComparableMessageShape(message);
  if (!incoming.chat_title || !incoming.message_text) return null;

  return rows.find((row) => {
    const existing = getComparableMessageShape(row);
    if (existing.chat_title !== incoming.chat_title) return false;
    if (existing.sender !== incoming.sender) return false;
    if (existing.message_text !== incoming.message_text) return false;
    if (existing.sent_at_text && incoming.sent_at_text) {
      return existing.sent_at_text === incoming.sent_at_text;
    }
    return cleanText(row.sent_at_text || "") === cleanText(message.sent_at_text || "");
  }) || null;
}

function buildComparableKey(messageLike) {
  const shape = getComparableMessageShape(messageLike);
  return JSON.stringify({
    chat_title: shape.chat_title,
    sender: shape.sender,
    sent_at_text: shape.sent_at_text,
    message_text: shape.message_text
  });
}

function normalizeIncomingMessage(message) {
  const normalized = { ...message };
  const replyTo = normalizeReplyReference(normalized.reply_to);
  if (replyTo) normalized.reply_to = replyTo;
  normalized.text = getNormalizedMessageText(normalized);
  return normalized;
}

function extractReplyLookupCandidates(replyTo, message = {}) {
  const normalized = normalizeReplyReference(replyTo);
  if (!normalized) return [];

  const values = [
    normalized.text,
    normalized.snippet
  ].filter(Boolean);

  const prefixes = [
    cleanText(normalized.sender),
    cleanText(message.chat_title),
    cleanText(message.sender)
  ].filter(Boolean);

  const candidates = new Set();
  values.map((value) => cleanText(value)).filter(Boolean).forEach((value) => {
    candidates.add(value);
    prefixes.forEach((prefix) => {
      if (prefix && value.startsWith(`${prefix} `)) {
        candidates.add(cleanText(value.slice(prefix.length)));
      }
    });
  });

  return [...candidates];
}

async function resolveReplyReference(message, { beforeId = null } = {}) {
  const replyTo = normalizeReplyReference(message?.reply_to);
  if (!replyTo) return message;
  if (replyTo.original_msg_id && replyTo.original_msg_sender) return message;

  const lookupCandidates = extractReplyLookupCandidates(replyTo, message);
  if (!lookupCandidates.length) return { ...message, reply_to: replyTo };

  const conditions = [
    `event_type = 'message'`,
    `COALESCE(chat_title, '') = COALESCE(?, '')`
  ];
  const params = [message.chat_title || message.payload?.title || null];

  if (beforeId) {
    conditions.push(`id < ?`);
    params.push(beforeId);
  } else if (message.uid) {
    conditions.push(`message_uid <> ?`);
    params.push(message.uid);
  }

  const [rows] = await pool.execute(
    `SELECT id, message_uid, chat_title, sender, message_text, raw_json
     FROM wa_messages
     WHERE ${conditions.join(" AND ")}
     ORDER BY id DESC
     LIMIT 200`,
    params
  );

  const match = rows.find((row) => {
    const normalizedText = getNormalizedMessageText(row);
    return lookupCandidates.includes(normalizedText);
  });

  if (!match) return { ...message, reply_to: replyTo };

  return {
    ...message,
    reply_to: {
      ...replyTo,
      original_msg_id: replyTo.original_msg_id || match.message_uid || null,
      original_msg_sender: replyTo.original_msg_sender || cleanText(match.sender) || null
    }
  };
}

function rowToIncomingMessage(row) {
  const raw = parseJsonMaybe(row.raw_json);
  return normalizeIncomingMessage({
    ...raw,
    uid: row.message_uid,
    event_type: row.event_type,
    source: row.source,
    chat_title: row.chat_title,
    sender: row.sender,
    direction: row.direction,
    sent_at_text: row.sent_at_text,
    captured_at: row.captured_at,
    text: row.message_text
  });
}

function getRowPreferenceScore(row) {
  const raw = parseJsonMaybe(row.raw_json);
  const uid = cleanText(row.message_uid || raw.uid || "");
  const source = cleanText(row.source || raw.source || "");
  const subtype = raw.message_subtype || "plain";
  let score = 0;

  if (uid && !uid.startsWith("synthetic-") && !uid.startsWith("sidebar-")) score += 100;
  if (uid.startsWith("synthetic-")) score += 40;
  if (uid.startsWith("sidebar-")) score += 10;
  if (source === "whatsapp_web_extension_dom") score += 30;
  if (source === "whatsapp_web_extension_sidebar") score += 5;
  score += messageSubtypeRank(subtype) * 20;
  if (hasReplyMetadata(raw)) score += 10;
  if (hasReactionMetadata(raw)) score += 10;
  if (Array.isArray(raw.media) && raw.media.length) score += 5;
  score += Number(row.id || 0) / 1000000;

  return score;
}

function chooseCanonicalRow(rows) {
  return [...rows].sort((a, b) => getRowPreferenceScore(b) - getRowPreferenceScore(a))[0] || null;
}

function mergeRowsIntoCanonical(canonicalRow, duplicateRows) {
  let merged = {
    source: canonicalRow.source,
    chat_title: canonicalRow.chat_title,
    sender: canonicalRow.sender,
    direction: canonicalRow.direction,
    sent_at_text: canonicalRow.sent_at_text,
    captured_at: canonicalRow.captured_at,
    message_text: canonicalRow.message_text,
    media_json: canonicalRow.media_json,
    reactions_json: canonicalRow.reactions_json,
    raw_json: canonicalRow.raw_json
  };

  for (const row of duplicateRows) {
    merged = buildMergedMessage(
      {
        ...canonicalRow,
        ...merged,
        message_uid: canonicalRow.message_uid
      },
      rowToIncomingMessage(row)
    );
  }

  return merged;
}

async function consolidateStoredDuplicates(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = buildComparableKey(row);
    const shape = getComparableMessageShape(row);
    if (!shape.chat_title || !shape.message_text) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  for (const groupRows of groups.values()) {
    if (groupRows.length < 2) continue;

    const canonical = chooseCanonicalRow(groupRows);
    if (!canonical) continue;

    const duplicates = groupRows.filter((row) => row.id !== canonical.id);
    const merged = mergeRowsIntoCanonical(canonical, duplicates);

    await pool.execute(
      `UPDATE wa_messages
       SET source = ?,
           chat_title = ?,
           sender = ?,
           direction = ?,
           sent_at_text = ?,
           captured_at = ?,
           message_text = ?,
           media_json = CAST(? AS JSON),
           reactions_json = CAST(? AS JSON),
           raw_json = CAST(? AS JSON)
       WHERE id = ?`,
      [
        merged.source,
        merged.chat_title,
        merged.sender,
        merged.direction,
        merged.sent_at_text,
        new Date(merged.captured_at),
        merged.message_text,
        merged.media_json,
        merged.reactions_json,
        merged.raw_json,
        canonical.id
      ]
    );

    await pool.execute(
      `DELETE FROM wa_messages WHERE id IN (${duplicates.map(() => "?").join(",")})`,
      duplicates.map((row) => row.id)
    );
  }
}

async function backfillReplyReferences(rows) {
  for (const row of rows) {
    const raw = parseJsonMaybe(row.raw_json);
    if (!hasReplyMetadata(raw)) continue;

    const normalized = await resolveReplyReference({
      ...raw,
      uid: row.message_uid,
      event_type: row.event_type,
      source: row.source,
      chat_title: row.chat_title,
      sender: row.sender,
      direction: row.direction,
      sent_at_text: row.sent_at_text,
      captured_at: row.captured_at,
      text: row.message_text
    }, { beforeId: row.id });

    const replyTo = normalizeReplyReference(normalized.reply_to);
    if (!replyTo) continue;
    if (stableJson(replyTo) === stableJson(normalizeReplyReference(raw.reply_to))) continue;

    const nextRaw = {
      ...raw,
      reply_to: replyTo
    };

    await pool.execute(
      `UPDATE wa_messages
       SET raw_json = CAST(? AS JSON)
       WHERE id = ?`,
      [
        JSON.stringify(nextRaw),
        row.id
      ]
    );
  }
}

function dedupeRowsForDisplay(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = buildComparableKey(row);
    const shape = getComparableMessageShape(row);
    if (!shape.chat_title || !shape.message_text) {
      groups.set(`__row_${row.id}`, [row]);
      return;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  const deduped = [];
  for (const groupRows of groups.values()) {
    if (groupRows.length === 1) {
      deduped.push(groupRows[0]);
      continue;
    }
    const canonical = chooseCanonicalRow(groupRows);
    if (!canonical) continue;
    const duplicates = groupRows.filter((row) => row.id !== canonical.id);
    const merged = mergeRowsIntoCanonical(canonical, duplicates);
    deduped.push({
      ...canonical,
      ...merged
    });
  }

  return deduped.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
}

function messageSubtypeRank(value) {
  const subtype = String(value || "").trim().toLowerCase();
  if (subtype === "reply+reaction") return 3;
  if (subtype === "reaction") return 2;
  if (subtype === "reply") return 1;
  return 0;
}

function isDomSource(value) {
  return String(value || "").trim() === "whatsapp_web_extension_dom";
}

function choosePreferredValue(incomingValue, existingValue, { preferIncoming = false } = {}) {
  const incoming = String(incomingValue || "").trim();
  const existing = String(existingValue || "").trim();
  if (preferIncoming && incoming) return incoming;
  if (incoming && !isGenericDisplayName(incoming)) return incoming;
  if (existing) return existing;
  return incoming || existing || null;
}

function buildMergedMessage(existingRow, incomingMessage) {
  const existingRaw = parseJsonMaybe(existingRow.raw_json);
  const incomingRaw = normalizeIncomingMessage({ ...incomingMessage });
  const incomingSubtype = incomingRaw.message_subtype || "plain";
  const existingSubtype = existingRaw.message_subtype || "plain";
  const preferIncoming = isDomSource(incomingMessage.source) && !isDomSource(existingRow.source);

  const mergedRaw = {
    ...existingRaw,
    ...incomingRaw,
    uid: existingRow.message_uid,
    chat_title: choosePreferredValue(incomingMessage.chat_title, existingRow.chat_title || existingRaw.chat_title, { preferIncoming }),
    sender: choosePreferredValue(incomingMessage.sender, existingRow.sender || existingRaw.sender, { preferIncoming }),
    text: choosePreferredValue(incomingMessage.text, existingRow.message_text || existingRaw.text, { preferIncoming }),
    sent_at_text: choosePreferredValue(incomingRaw.sent_at_text, existingRow.sent_at_text || existingRaw.sent_at_text, { preferIncoming }),
    target_name: choosePreferredValue(incomingMessage.target_name, existingRaw.target_name, { preferIncoming }),
    target_phone: choosePreferredValue(incomingMessage.target_phone, existingRaw.target_phone, { preferIncoming }),
    sender_phone: choosePreferredValue(incomingMessage.sender_phone, existingRaw.sender_phone, { preferIncoming }),
    sender_resolved_name: choosePreferredValue(incomingMessage.sender_resolved_name, existingRaw.sender_resolved_name, { preferIncoming }),
    target_resolved_name: choosePreferredValue(incomingMessage.target_resolved_name, existingRaw.target_resolved_name, { preferIncoming }),
    target_key: choosePreferredValue(incomingMessage.target_key, existingRaw.target_key, { preferIncoming }),
    sender_key: choosePreferredValue(incomingMessage.sender_key, existingRaw.sender_key, { preferIncoming }),
    target_type: choosePreferredValue(incomingMessage.target_type, existingRaw.target_type, { preferIncoming }),
    page_url: choosePreferredValue(incomingMessage.page_url, existingRaw.page_url, { preferIncoming }),
    captured_at: choosePreferredValue(incomingMessage.captured_at, existingRaw.captured_at, { preferIncoming }) || new Date().toISOString(),
    ack: incomingMessage.ack || existingRaw.ack || null,
    reply_to: hasReplyMetadata(incomingRaw) ? incomingRaw.reply_to : (existingRaw.reply_to || null),
    reactions: hasReactionMetadata(incomingRaw) ? incomingRaw.reactions : (existingRaw.reactions || []),
    media: Array.isArray(incomingRaw.media) && incomingRaw.media.length ? incomingRaw.media : (existingRaw.media || []),
    message_subtype: messageSubtypeRank(incomingSubtype) >= messageSubtypeRank(existingSubtype) ? incomingSubtype : existingSubtype,
    source: preferIncoming ? incomingMessage.source : (existingRaw.source || incomingMessage.source || existingRow.source)
  };

  return {
    source: preferIncoming ? incomingMessage.source : (existingRow.source || incomingMessage.source || "whatsapp_web_extension"),
    chat_title: mergedRaw.chat_title || null,
    sender: mergedRaw.sender || null,
    direction: choosePreferredValue(incomingMessage.direction, existingRow.direction || existingRaw.direction, { preferIncoming }) || null,
    sent_at_text: mergedRaw.sent_at_text || null,
    captured_at: mergedRaw.captured_at || new Date().toISOString(),
    message_text: mergedRaw.text || null,
    media_json: JSON.stringify(mergedRaw.media || []),
    reactions_json: JSON.stringify(mergedRaw.reactions || []),
    raw_json: JSON.stringify(mergedRaw)
  };
}

function isNoisyMessageText(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return true;
  if ([
    "online",
    "business account",
    "typing…",
    "typing...",
    "מקליד…",
    "מקליד..."
  ].includes(text)) return true;

  return [
    "updates in status",
    "channels",
    "communities",
    "last seen today",
    "last seen ",
    "messages and calls are end-to-end encrypted",
    " is typing",
    "click here for contact info",
    "click here for group info",
    "changed this group's icon",
    "reacted to:",
    "you deleted this message",
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
  if (isNoisyMessageText(title) || isNoisyMessageText(sender)) return true;
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
  const sender = String(row.sender || raw.sender || "").trim();
  const targetName = String(raw.target_name || "").trim();
  const text = String(row.message_text || raw.text || "").trim();

  if (isNoisyMessageText(title) || isNoisyMessageText(sender)) return false;
  if (isNoisyMessageText(text)) return false;
  if (isGenericDisplayName(title) || isGenericDisplayName(targetName)) return false;
  if (isMalformedSidebarRow(row)) return false;
  return true;
}

function isDebugEventRow(row) {
  const eventType = String(row.event_type || "").trim().toLowerCase();
  const source = String(row.source || "").trim().toLowerCase();
  if (!eventType) return false;
  if (eventType !== "message") return true;
  return source.includes("debug") || source.includes("page_hook") || source.includes("store");
}

function formatDebugRowAsText(row) {
  const raw = parseJsonMaybe(row.raw_json);
  return [
    `#${row.id} ${row.event_type || "-"} ${row.source || "-"}`,
    `created_at: ${row.created_at || "-"}`,
    `captured_at: ${row.captured_at || raw.captured_at || "-"}`,
    `chat_title: ${row.chat_title || raw.chat_title || "-"}`,
    `sender: ${row.sender || raw.sender || "-"}`,
    `text: ${row.message_text || raw.text || "-"}`,
    `payload:`,
    JSON.stringify(raw.payload || raw, null, 2),
    ""
  ].join("\n");
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
  let msg = normalizeIncomingMessage(req.body || {});
  msg.uid = normalizeUid(msg);
  msg = await resolveReplyReference(msg);
  msg = await enrichMessageMediaForStorage(msg);

  const capturedAt = msg.captured_at ? new Date(msg.captured_at) : new Date();

  if ((msg.event_type || "") === "message") {
    const [recentRows] = await pool.execute(
      `SELECT id, message_uid, source, chat_title, sender, direction, sent_at_text, message_text, raw_json
       FROM wa_messages
       WHERE event_type = 'message'
         AND message_uid <> ?
         AND COALESCE(chat_title, '') = COALESCE(?, '')
         AND COALESCE(sender, '') = COALESCE(?, '')
       ORDER BY id DESC
       LIMIT 25`,
      [
        msg.uid,
        msg.chat_title || msg.payload?.title || null,
        msg.sender || null
      ]
    );

    const duplicateRow = findDuplicateCandidate(recentRows, msg);

    if (duplicateRow) {
      const merged = buildMergedMessage(duplicateRow, msg);
      const hasUsefulIncomingUpdate = hasReplyMetadata(msg)
        || hasReactionMetadata(msg)
        || isDomSource(msg.source)
        || String(msg.message_subtype || "").trim().toLowerCase() !== "plain";

      if (!hasUsefulIncomingUpdate) {
        return res.json({ ok: true, saved: false, duplicate: true, uid: duplicateRow.message_uid, duplicate_of: duplicateRow.id });
      }

      await pool.execute(
        `UPDATE wa_messages
         SET source = ?,
             chat_title = ?,
             sender = ?,
             direction = ?,
             sent_at_text = ?,
             captured_at = ?,
             message_text = ?,
             media_json = CAST(? AS JSON),
             reactions_json = CAST(? AS JSON),
             raw_json = CAST(? AS JSON)
         WHERE id = ?`,
        [
          merged.source,
          merged.chat_title,
          merged.sender,
          merged.direction,
          merged.sent_at_text,
          new Date(merged.captured_at),
          merged.message_text,
          merged.media_json,
          merged.reactions_json,
          merged.raw_json,
          duplicateRow.id
        ]
      );

      return res.json({ ok: true, saved: true, updated_existing: true, uid: duplicateRow.message_uid, updated_id: duplicateRow.id });
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

  if ((msg.event_type || "") === "message") {
    const [recentRows] = await pool.execute(
      `SELECT id, message_uid, event_type, source, chat_title, sender, direction, sent_at_text, captured_at, message_text, media_json, reactions_json, raw_json
       FROM wa_messages
       WHERE event_type = 'message'
         AND COALESCE(chat_title, '') = COALESCE(?, '')
         AND COALESCE(sender, '') = COALESCE(?, '')
       ORDER BY id DESC
       LIMIT 25`,
      [
        msg.chat_title || msg.payload?.title || null,
        msg.sender || null
      ]
    );
    await consolidateStoredDuplicates(recentRows);
    await backfillReplyReferences(recentRows);
  }

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
  rows = dedupeRowsForDisplay(rows);
  res.json({ ok: true, count: rows.length, messages: rows });
});

app.get("/api/domdebug", async (req, res) => {
  const parsedLimit = Number(req.query.limit || 100);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 500)) : 100;
  const [rows] = await pool.execute(`SELECT * FROM wa_messages ORDER BY id DESC LIMIT ${limit}`);
  const enriched = await enrichRowsWithResolvedNames(rows);
  const debugRows = enriched.filter(isDebugEventRow);
  res.json({ ok: true, count: debugRows.length, messages: debugRows });
});

app.get("/api/domdebug/export", async (req, res) => {
  const parsedLimit = Number(req.query.limit || 200);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 2000)) : 200;
  const [rows] = await pool.execute(`SELECT * FROM wa_messages ORDER BY id DESC LIMIT ${limit}`);
  const enriched = await enrichRowsWithResolvedNames(rows);
  const debugRows = enriched.filter(isDebugEventRow);
  const output = debugRows.map(formatDebugRowAsText).join("\n====================\n\n");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(output || "No debug rows");
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
