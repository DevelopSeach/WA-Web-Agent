import React, { useEffect, useState } from "react";

const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE_URL || "/");

export default function App() {
  const [messages, setMessages] = useState([]);
  const [commands, setCommands] = useState([]);
  const [chatFilter, setChatFilter] = useState("");
  const [apiToken, setApiToken] = useState(() => window.localStorage.getItem("wa-web-agent-api-token") || "");
  const [text, setText] = useState("שלום, זו הודעת בדיקה");
  const [phoneNumber, setPhoneNumber] = useState("972544506093");
  const [groupName, setGroupName] = useState("");
  const [makeArchivedVisible, setMakeArchivedVisible] = useState(false);
  const [showTechnicalEvents, setShowTechnicalEvents] = useState(false);
  const [imagePath, setImagePath] = useState("C:\\WA_FILES\\image1.png");
  const [caption, setCaption] = useState("מצורפת תמונה");
  const [status, setStatus] = useState({ type: "idle", message: "" });

  const sortedMessages = [...messages].sort(compareMessagesByWhatsAppTime);
  const incomingCount = sortedMessages.filter((message) => message.direction === "incoming").length;
  const outgoingCount = sortedMessages.filter((message) => message.direction === "outgoing").length;
  const latestMessage = sortedMessages[0] || null;

  async function load() {
    try {
      const msgUrl = new URL("/api/messages", API_BASE);
      msgUrl.searchParams.set("limit", "100");
      if (chatFilter.trim()) msgUrl.searchParams.set("chat", chatFilter.trim());
      if (showTechnicalEvents) msgUrl.searchParams.set("include_events", "true");

      const [messagesResponse, commandsResponse] = await Promise.all([
        fetch(msgUrl),
        fetch(new URL("/api/commands", API_BASE), { headers: { "x-api-token": apiToken } })
      ]);

      const messagePayload = await messagesResponse.json();
      const commandPayload = await commandsResponse.json();

      setMessages(messagePayload.messages || []);
      setCommands(commandPayload.commands || []);
      setStatus({ type: "ok", message: "החיבור לשרת תקין" });
    } catch (error) {
      setStatus({ type: "error", message: String(error?.message || error) });
    }
  }

  async function createCommand(command) {
    setStatus({ type: "working", message: "שולח פקודה..." });
    const response = await fetch(new URL("/api/commands", API_BASE), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-token": apiToken },
      body: JSON.stringify(command)
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    setStatus({ type: "ok", message: "הפקודה נשמרה ונשלחה להמתנה" });
    await load();
  }

  async function clearMessages() {
    setStatus({ type: "working", message: "מנקה הודעות..." });
    const response = await fetch(new URL("/api/messages", API_BASE), {
      method: "DELETE",
      headers: { "x-api-token": apiToken }
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    setStatus({ type: "ok", message: `נמחקו ${payload.deleted || 0} הודעות` });
    await load();
  }

  async function downloadMessages() {
    setStatus({ type: "working", message: "מכין קובץ לוג..." });
    const exportUrl = new URL("/api/messages/export", API_BASE);
    if (chatFilter.trim()) exportUrl.searchParams.set("chat", chatFilter.trim());
    if (showTechnicalEvents) exportUrl.searchParams.set("include_events", "true");

    const response = await fetch(exportUrl, {
      headers: { "x-api-token": apiToken }
    });
    if (!response.ok) {
      let payload = {};
      try {
        payload = await response.json();
      } catch {}
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `wa-messages-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
    setStatus({ type: "ok", message: "קובץ הלוג ירד" });
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [apiToken, showTechnicalEvents]);

  function updateApiToken(value) {
    setApiToken(value);
    window.localStorage.setItem("wa-web-agent-api-token", value);
  }

  async function handleCommand(command) {
    try {
      await createCommand(command);
    } catch (error) {
      setStatus({ type: "error", message: String(error?.message || error) });
    }
  }

  async function handleClearMessages() {
    try {
      await clearMessages();
    } catch (error) {
      setStatus({ type: "error", message: String(error?.message || error) });
    }
  }

  async function handleDownloadMessages() {
    try {
      await downloadMessages();
    } catch (error) {
      setStatus({ type: "error", message: String(error?.message || error) });
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.hero}>
        <div>
          <div style={styles.eyebrow}>WA Web Agent</div>
          <h1 style={styles.title}>לוח בקרה להודעות, פקודות, ובדיקות חיבור</h1>
          <p style={styles.subtitle}>כאן תראה הודעות שנקלטו ב־WhatsApp Web, תשלח פקודות לדפדפן המרוחק, ותבדוק מיד אם החיבור עובד.</p>
        </div>
        <div style={styles.statusCard}>
          <div style={styles.statusLabel}>סטטוס שרת</div>
          <div style={{ ...styles.statusValue, color: status.type === "error" ? "#991b1b" : "#123524" }}>
            {status.type === "error" ? "שגיאה" : status.type === "working" ? "עובד" : "מחובר"}
          </div>
          <div style={styles.statusMessage}>{status.message || "ממתין לפעולה"}</div>
        </div>
      </header>

      <section style={styles.statsGrid}>
        <div style={styles.statCard}>
          <span style={styles.statValue}>{messages.length}</span>
          <span style={styles.statLabel}>הודעות נטענו</span>
        </div>
        <div style={styles.statCard}>
          <span style={styles.statValue}>{incomingCount}</span>
          <span style={styles.statLabel}>נכנסות</span>
        </div>
        <div style={styles.statCard}>
          <span style={styles.statValue}>{outgoingCount}</span>
          <span style={styles.statLabel}>יוצאות</span>
        </div>
        <div style={styles.statCard}>
          <span style={styles.statValue}>{commands.length}</span>
          <span style={styles.statLabel}>פקודות אחרונות</span>
        </div>
      </section>

      <section style={styles.panel}>
        <div style={styles.panelHeader}>
          <div>
            <h2 style={styles.panelTitle}>שליחת פקודות ל־WhatsApp Web</h2>
            <p style={styles.panelDescription}>הפקודות נשלחות להרחבה בכרום. אפשר לשלוח למספר, לקבוצה פתוחה, או לחפש קבוצה לפי שם דרך WhatsApp Web.</p>
          </div>
          <button onClick={load} style={styles.secondaryButton}>רענון עכשיו</button>
        </div>

        <div style={styles.formGrid}>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>API Token</span>
            <input value={apiToken} onChange={(e) => updateApiToken(e.target.value)} style={styles.input} />
          </label>

          <label style={styles.field}>
            <span style={styles.fieldLabel}>מספר יעד</span>
            <input value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} style={styles.input} placeholder="972544506093" />
          </label>

          <label style={styles.field}>
            <span style={styles.fieldLabel}>שם קבוצה / צ׳אט</span>
            <input value={groupName} onChange={(e) => setGroupName(e.target.value)} style={styles.input} placeholder="שם הקבוצה כפי שמופיע ב־WhatsApp Web" />
          </label>

          <label style={{ ...styles.field, gridColumn: "1 / -1" }}>
            <span style={styles.fieldLabel}>טקסט לשליחה</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} style={styles.textarea} />
          </label>

          <div style={styles.actionsRow}>
            <button style={styles.button} onClick={() => handleCommand({ action: "send_text_to_phone", phone: phoneNumber, text, send: true })}>
              שלח הודעת בדיקה למספר
            </button>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "send_text_to_archived_phone", phone: phoneNumber, text, send: true, makeVisible: makeArchivedVisible })}>
              שלח למשתמש בארכיון
            </button>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "open_chat", phone: phoneNumber, text })}>
              פתח צ׳אט למספר
            </button>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "send_text", text })}>
              שלח לצ׳אט הפתוח
            </button>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "send_text_to_group", chatName: groupName, text, send: true })}>
              שלח לקבוצה לפי שם
            </button>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "send_text_to_archived_group", chatName: groupName, text, send: true, makeVisible: makeArchivedVisible })}>
              שלח לקבוצה בארכיון
            </button>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "open_group", chatName: groupName })}>
              פתח קבוצה לפי שם
            </button>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "open_archived_chat", chatName: groupName })}>
              פתח צ׳אט בארכיון
            </button>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "focus_message_box" })}>
              פוקוס לתיבת הודעה
            </button>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "get_state" })}>
              בדיקת מצב
            </button>
          </div>

          <label style={styles.field}>
            <span style={styles.fieldLabel}>נתיב תמונה ב־Windows</span>
            <input value={imagePath} onChange={(e) => setImagePath(e.target.value)} style={styles.input} />
          </label>

          <label style={styles.field}>
            <span style={styles.fieldLabel}>Caption</span>
              <input value={caption} onChange={(e) => setCaption(e.target.value)} style={styles.input} />
          </label>

          <label style={{ ...styles.field, alignSelf: "end" }}>
            <span style={styles.checkboxRow}>
              <input type="checkbox" checked={makeArchivedVisible} onChange={(e) => setMakeArchivedVisible(e.target.checked)} />
              <span>להפוך צ׳אטים מהארכיון לגלויים אחרי פעולה</span>
            </span>
          </label>

          <div style={styles.actionsRow}>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "paste_image", filePath: imagePath, caption, send: true })}>
              הדבק ושלח תמונה
            </button>
          </div>
        </div>
      </section>

      <section style={styles.panel}>
        <div style={styles.panelHeader}>
          <div>
            <h2 style={styles.panelTitle}>הודעות שנקלטו</h2>
            <p style={styles.panelDescription}>
              {latestMessage
                ? `ההודעה האחרונה התקבלה ב־${formatTime(latestMessage.created_at)}`
                : showTechnicalEvents
                  ? "אין עדיין אירועים שמורים."
                  : "אין כרגע הודעות message. אם תרצה, אפשר לסמן הצגת אירועים טכניים כדי לראות extension/page events."}
            </p>
          </div>
        </div>
        <div style={styles.toolbar}>
          <input placeholder="סינון לפי צ׳אט" value={chatFilter} onChange={(e) => setChatFilter(e.target.value)} style={styles.input} />
          <label style={styles.inlineCheckbox}>
            <input type="checkbox" checked={showTechnicalEvents} onChange={(e) => setShowTechnicalEvents(e.target.checked)} />
            <span>הצג גם אירועים טכניים</span>
          </label>
          <button onClick={load} style={styles.secondaryButton}>רענון</button>
          <button onClick={handleDownloadMessages} style={styles.secondaryButton}>הורד לוג מלא</button>
          <button onClick={handleClearMessages} style={styles.dangerButton}>נקה את כל ההודעות</button>
        </div>
        <div style={styles.messageList}>
          {messages.length === 0 ? (
            <div style={styles.emptyState}>אין עדיין הודעות. ברגע שההרחבה תקלוט הודעה נכנסת או יוצאת, היא תופיע כאן.</div>
          ) : sortedMessages.map((message) => (
            <article key={message.id} style={styles.messageCard}>
              <div style={{ ...styles.metaRow, ...(isTechnicalEvent(message) ? styles.technicalHeader : {}) }}>
                <div>
                  <div style={styles.chatTitle}>{message.chat_title || "ללא שם"}</div>
                  <div style={styles.subtleText}>
                    מאת: {formatSender(message)}
                    {message.raw_json?.sender_phone ? ` (${message.raw_json.sender_phone})` : ""}
                    {!message.raw_json?.sender_phone && message.raw_json?.sender_key ? ` [ID: ${message.raw_json.sender_key}]` : ""}
                  </div>
                  <div style={styles.subtleText}>
                    יעד: {formatTarget(message)}
                  </div>
                  <div style={styles.subtleText}>
                    זמן הודעה: {formatWhatsAppTime(message)}
                  </div>
                </div>
                <div style={styles.alignEnd}>
                  <span style={{ ...styles.directionBadge, background: getDirectionColor(message.direction) }}>
                    {getDirectionLabel(message.direction)}
                  </span>
                  <span style={styles.timestamp}>{formatTime(message.captured_at || message.created_at)}</span>
                </div>
              </div>
              <div style={styles.messageBody}>{message.message_text || "(ללא טקסט)"}</div>
              {getRenderableMedia(message).length ? (
                <div style={styles.mediaStrip}>
                  {getRenderableMedia(message).map((media, index) => (
                    media.kind === "image" ? (
                      <a
                        key={`${message.id}-media-${index}`}
                        href={media.src}
                        target="_blank"
                        rel="noreferrer"
                        style={styles.mediaLink}
                      >
                        <img src={media.src} alt={media.alt || "media"} style={styles.mediaThumb} loading="lazy" />
                      </a>
                    ) : (
                      <a
                        key={`${message.id}-media-${index}`}
                        href={media.src}
                        target="_blank"
                        rel="noreferrer"
                        style={styles.mediaFallback}
                      >
                        {getMediaLabel(media, index)}
                      </a>
                    )
                  ))}
                </div>
              ) : null}
              <div style={styles.metaChips}>
                <span style={styles.chip}>סוג: {message.event_type || "-"}</span>
                {message.raw_json?.message_subtype && message.raw_json.message_subtype !== "plain" ? (
                  <span style={styles.chip}>עדכון: {formatMessageSubtype(message.raw_json.message_subtype)}</span>
                ) : null}
                <span style={styles.chip}>UID: {message.message_uid}</span>
                {message.raw_json?.ack?.label ? <span style={styles.chip}>סטטוס: {message.raw_json.ack.label}</span> : null}
                {message.media_json?.length ? <span style={styles.chip}>מדיה: {message.media_json.length}</span> : null}
              </div>
              {getOpenableMediaTargets(message).length ? (
                <div style={styles.mediaActions}>
                  {getOpenableMediaTargets(message).map((target, index) => (
                    <a
                      key={`${message.id}-open-media-${index}`}
                      href={target.url}
                      target="_blank"
                      rel="noreferrer"
                      style={styles.mediaActionButton}
                    >
                      {target.label}
                    </a>
                  ))}
                </div>
              ) : null}
              {message.raw_json?.reply_to ? (
                <div style={styles.replyCard}>
                  <div style={styles.replyLabel}>תגובה להודעה</div>
                  <div style={styles.replyText}>
                    {message.raw_json.reply_to.sender ? `${message.raw_json.reply_to.sender}: ` : ""}
                    {message.raw_json.reply_to.snippet || message.raw_json.reply_to.text}
                  </div>
                  {message.raw_json.reply_to.original_msg_id || message.raw_json.reply_to.original_msg_sender ? (
                    <div style={styles.replyMeta}>
                      {message.raw_json.reply_to.original_msg_sender ? `שולח מקורי: ${message.raw_json.reply_to.original_msg_sender}` : ""}
                      {message.raw_json.reply_to.original_msg_sender && message.raw_json.reply_to.original_msg_id ? " | " : ""}
                      {message.raw_json.reply_to.original_msg_id ? `מזהה הודעה מקורית: ${message.raw_json.reply_to.original_msg_id}` : ""}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {Array.isArray(message.reactions_json) && message.reactions_json.length > 0 ? (
                <div style={styles.reactionList}>
                  {message.reactions_json.map((reaction, index) => (
                    <div key={`${message.id}-reaction-${index}`} style={styles.reactionItem}>
                      <span style={styles.reactionEmoji}>{Array.isArray(reaction.emojis) ? reaction.emojis.join(" ") : reaction.text}</span>
                      <span style={styles.reactionText}>
                        {Array.isArray(reaction.actors) && reaction.actors.length
                          ? reaction.actors.join(", ")
                          : reaction.sender_name || reaction.text}
                      </span>
                      {(reaction.sender_id || reaction.response_time) ? (
                        <span style={styles.reactionMeta}>
                          {reaction.sender_name ? `מאת: ${reaction.sender_name}` : ""}
                          {reaction.sender_name && reaction.sender_id ? " | " : ""}
                          {reaction.sender_id ? `ID: ${reaction.sender_id}` : ""}
                          {(reaction.sender_name || reaction.sender_id) && reaction.response_time ? " | " : ""}
                          {reaction.response_time ? `זמן: ${reaction.response_time}` : ""}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              <details>
                <summary style={styles.rawSummary}>Raw</summary>
                <pre style={styles.pre}>{JSON.stringify(message.raw_json, null, 2)}</pre>
              </details>
            </article>
          ))}
        </div>
      </section>

      <section style={styles.panel}>
        <div style={styles.panelHeader}>
          <div>
            <h2 style={styles.panelTitle}>פקודות אחרונות</h2>
            <p style={styles.panelDescription}>כאן תראה אם ההרחבה אספה את הפקודה וביצעה אותה.</p>
          </div>
        </div>
        <div style={styles.list}>
          {commands.map((command) => (
            <div key={command.id} style={styles.commandCard}>
              <div style={styles.metaRow}>
                <b>#{command.id} {command.action}</b>
                <span style={{ ...styles.commandStatus, background: getCommandStatusColor(command.status) }}>{command.status}</span>
              </div>
              <pre style={styles.pre}>{JSON.stringify({ command: command.command_json, result: command.result_json, error: command.error_text }, null, 2)}</pre>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function resolveApiBase(rawBase) {
  const base = String(rawBase || "/").trim();
  if (/^https?:\/\//i.test(base)) return base.replace(/\/$/, "");
  if (typeof window !== "undefined") return new URL(base, window.location.origin).toString().replace(/\/$/, "");
  return "http://localhost";
}

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("he-IL");
}

function parseWhatsAppTime(message) {
  const raw = String(message.sent_at_text || "").trim();
  const candidates = [
    raw,
    raw.replace(",", ""),
    raw.replace(/\./g, "/")
  ];

  for (const candidate of candidates) {
    const direct = Date.parse(candidate);
    if (Number.isFinite(direct)) return direct;

    const dmYHm = candidate.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4}).*?(\d{1,2}):(\d{2})/);
    if (dmYHm) {
      const [, d, m, y, hh, mm] = dmYHm;
      const year = y.length === 2 ? `20${y}` : y;
      return new Date(Number(year), Number(m) - 1, Number(d), Number(hh), Number(mm)).getTime();
    }

    const hm = candidate.match(/^(\d{1,2}):(\d{2})$/);
    if (hm) {
      const base = new Date(message.captured_at || message.created_at || Date.now());
      base.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
      return base.getTime();
    }
  }

  const fallback = Date.parse(message.captured_at || message.created_at || "");
  return Number.isFinite(fallback) ? fallback : 0;
}

function compareMessagesByWhatsAppTime(a, b) {
  return parseWhatsAppTime(b) - parseWhatsAppTime(a);
}

function formatWhatsAppTime(message) {
  if (message.sent_at_text) return message.sent_at_text;
  return formatTime(message.captured_at || message.created_at);
}

function formatSender(message) {
  const resolved = String(message.raw_json?.sender_resolved_name || "").trim();
  if (resolved) return resolved;
  return message.sender || "לא ידוע";
}

function formatMessageSubtype(value) {
  const subtype = String(value || "").trim().toLowerCase();
  if (subtype === "reaction") return "תגובה באימוג'י";
  if (subtype === "reply") return "תגובה להודעה";
  if (subtype === "reply+reaction") return "תגובה להודעה + אימוג'י";
  return subtype || "-";
}

function isTechnicalEvent(message) {
  return String(message?.event_type || "").trim() !== "message";
}

function isGenericDisplayName(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["", "chats", "channels", "channel", "communities", "updates in status", "status", "search", "business account", "whatsapp business on web", "חיפוש", "לא ידוע"].includes(text);
}

function formatTarget(message) {
  const rawName = message.raw_json?.target_resolved_name || message.raw_json?.target_name || message.chat_title || "";
  const senderName = String(message.sender || message.raw_json?.sender || "").trim();
  const name = isGenericDisplayName(rawName)
    ? (message.raw_json?.sender || message.raw_json?.sender_phone || "לא ידוע")
    : rawName;
  const type = message.raw_json?.target_type;
  const phone = message.raw_json?.target_phone;
  const key = message.raw_json?.target_key;
  if (type === "group") return name;
  if (senderName && name === senderName) {
    return phone && phone !== message.raw_json?.sender_phone
      ? `${name} יעד (${phone})`
      : key
        ? `החשבון המחובר [ID: ${key}]`
        : "החשבון המחובר";
  }
  if (phone) return `${name} (${phone})`;
  return key ? `${name} [ID: ${key}]` : name;
}

function getDirectionLabel(direction) {
  if (direction === "incoming") return "נכנסת";
  if (direction === "outgoing") return "יוצאת";
  return "לא ידוע";
}

function getDirectionColor(direction) {
  if (direction === "incoming") return "#d1fae5";
  if (direction === "outgoing") return "#dbeafe";
  return "#ede9fe";
}

function getCommandStatusColor(status) {
  if (status === "done") return "#d1fae5";
  if (status === "failed") return "#fee2e2";
  if (status === "running") return "#fde68a";
  return "#e5e7eb";
}

function getRenderableMedia(message) {
  const media = Array.isArray(message?.media_json) ? message.media_json : [];
  const filtered = media.filter((item) => {
    const kind = String(item?.kind || "").trim().toLowerCase();
    const src = String(item?.src || item?.href || "").trim();
    if (!src) return false;
    if (kind === "image") {
      const width = Number(item?.width || 0);
      const height = Number(item?.height || 0);
      if (width > 0 && width <= 4 && height > 0 && height <= 4) return false;
      return src.startsWith("data:image/") || src.startsWith("blob:") || /^https?:\/\//i.test(src);
    }
    return kind === "video" || kind === "audio" || kind === "link";
  });

  const seen = new Set();
  return filtered
    .slice()
    .sort((a, b) => getMediaPriority(b) - getMediaPriority(a))
    .filter((item) => {
      const key = JSON.stringify({
        kind: item?.kind || "",
        alt: item?.alt || "",
        width: Number(item?.width || 0),
        height: Number(item?.height || 0),
        src: String(item?.src || "").slice(0, 120)
      });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getMediaLabel(media, index) {
  const kind = String(media?.kind || "").trim().toLowerCase();
  if (kind === "video") return `וידאו ${index + 1}`;
  if (kind === "audio") return `אודיו ${index + 1}`;
  if (kind === "link") return media.text || media.src || `קישור ${index + 1}`;
  return media.text || media.src || `מדיה ${index + 1}`;
}

function getMediaPriority(media) {
  const kind = String(media?.kind || "").trim().toLowerCase();
  if (kind !== "image") return 0;
  const width = Number(media?.width || 0);
  const height = Number(media?.height || 0);
  const area = width * height;
  const src = String(media?.src || "").trim();
  const sourceBonus = src.startsWith("data:image/") ? 1_000_000_000 : 0;
  return sourceBonus + area;
}

function getOpenableMediaTargets(message) {
  const media = Array.isArray(message?.raw_json?.media)
    ? message.raw_json.media
    : Array.isArray(message?.media_json)
      ? message.media_json
      : [];

  const seen = new Set();
  return media.flatMap((item, index) => {
    const uploadedUrl = cleanMediaUrl(
      item?.mega_url
      || item?.uploaded_url
      || item?.upload?.mega_url
      || item?.upload?.media_url
      || item?.upload?.public_url
      || item?.upload?.download_url
      || item?.upload?.location
    );
    const fallbackUrl = cleanHttpMediaUrl(item?.src || item?.href || item?.original_src);
    const targetUrl = uploadedUrl || fallbackUrl;
    if (!targetUrl) return [];
    if (seen.has(targetUrl)) return [];
    seen.add(targetUrl);
    return [{
      url: targetUrl,
      label: uploadedUrl ? `פתח מדיה ${index + 1}` : `פתח מקור מדיה ${index + 1}`
    }];
  });
}

function cleanMediaUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return "";
}

function cleanHttpMediaUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : "";
}

const styles = {
  page: {
    fontFamily: "'Segoe UI', sans-serif",
    padding: 24,
    background: "linear-gradient(180deg, #f3f4f6 0%, #fff7ed 100%)",
    minHeight: "100vh",
    direction: "rtl",
    color: "#111827"
  },
  hero: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 280px",
    gap: 18,
    alignItems: "stretch",
    marginBottom: 18
  },
  eyebrow: { fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#9a3412" },
  title: { margin: "8px 0 10px", fontSize: 34, lineHeight: 1.05 },
  subtitle: { margin: 0, maxWidth: 760, color: "#4b5563", fontSize: 16, lineHeight: 1.6 },
  statusCard: { background: "#fff", borderRadius: 18, padding: 18, boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)", border: "1px solid #fed7aa" },
  statusLabel: { color: "#9a3412", fontSize: 13, fontWeight: 700, marginBottom: 8 },
  statusValue: { fontSize: 26, fontWeight: 800, marginBottom: 8 },
  statusMessage: { color: "#4b5563", lineHeight: 1.5 },
  statsGrid: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 18 },
  statCard: { background: "#fff", padding: 18, borderRadius: 16, border: "1px solid #e5e7eb", boxShadow: "0 8px 20px rgba(15, 23, 42, 0.06)" },
  statValue: { display: "block", fontSize: 28, fontWeight: 800, marginBottom: 6 },
  statLabel: { color: "#6b7280" },
  panel: { background: "#fff", padding: 18, borderRadius: 18, marginBottom: 18, boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)" },
  panelHeader: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 16 },
  panelTitle: { margin: "0 0 6px", fontSize: 24 },
  panelDescription: { margin: 0, color: "#6b7280", lineHeight: 1.6 },
  formGrid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14 },
  field: { display: "grid", gap: 8 },
  fieldLabel: { fontSize: 14, fontWeight: 700, color: "#374151" },
  checkboxRow: { display: "flex", gap: 8, alignItems: "center", fontWeight: 700, color: "#374151" },
  inlineCheckbox: { display: "flex", gap: 8, alignItems: "center", fontWeight: 700, color: "#374151", whiteSpace: "nowrap" },
  toolbar: { display: "flex", gap: 8, marginBottom: 16 },
  input: { padding: 12, fontSize: 15, width: "100%", boxSizing: "border-box", border: "1px solid #d1d5db", borderRadius: 12, background: "#fff" },
  textarea: { padding: 12, fontSize: 15, minHeight: 100, width: "100%", boxSizing: "border-box", border: "1px solid #d1d5db", borderRadius: 12, background: "#fff" },
  actionsRow: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", gridColumn: "1 / -1" },
  button: { padding: "12px 18px", fontSize: 15, cursor: "pointer", borderRadius: 999, border: "none", background: "#111827", color: "#fff", fontWeight: 700 },
  secondaryButton: { padding: "12px 18px", fontSize: 15, cursor: "pointer", borderRadius: 999, border: "1px solid #d1d5db", background: "#fff", color: "#111827", fontWeight: 700 },
  dangerButton: { padding: "12px 18px", fontSize: 15, cursor: "pointer", borderRadius: 999, border: "1px solid #fecaca", background: "#fff1f2", color: "#991b1b", fontWeight: 800 },
  list: { display: "grid", gap: 12 },
  messageList: { display: "grid", gap: 12 },
  emptyState: { border: "1px dashed #d1d5db", borderRadius: 14, padding: 24, color: "#6b7280", textAlign: "center", background: "#f9fafb" },
  messageCard: { border: "1px solid #e5e7eb", borderRadius: 16, padding: 14, background: "#fcfcfd" },
  commandCard: { border: "1px solid #e5e7eb", borderRadius: 16, padding: 14, background: "#f9fafb" },
  metaRow: { display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 10, alignItems: "flex-start" },
  technicalHeader: { background: "#dcfce7", border: "1px solid #86efac", borderRadius: 12, padding: 10 },
  alignEnd: { display: "grid", gap: 8, justifyItems: "end" },
  chatTitle: { fontWeight: 800, fontSize: 18, marginBottom: 4 },
  subtleText: { color: "#6b7280", fontSize: 14 },
  directionBadge: { padding: "6px 10px", borderRadius: 999, fontSize: 13, fontWeight: 800, color: "#111827" },
  timestamp: { color: "#6b7280", fontSize: 13 },
  messageBody: { whiteSpace: "pre-wrap", fontSize: 16, lineHeight: 1.7, marginBottom: 10 },
  mediaStrip: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 },
  mediaLink: { display: "inline-flex", textDecoration: "none" },
  mediaThumb: { width: 220, height: 220, objectFit: "contain", borderRadius: 12, border: "1px solid #d1d5db", background: "#f3f4f6" },
  mediaFallback: {
    display: "inline-flex",
    alignItems: "center",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid #d1d5db",
    background: "#f9fafb",
    color: "#1d4ed8",
    textDecoration: "none",
    fontSize: 13
  },
  mediaActions: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 },
  mediaActionButton: {
    display: "inline-flex",
    alignItems: "center",
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid #bfdbfe",
    background: "#eff6ff",
    color: "#1d4ed8",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 700
  },
  metaChips: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 },
  chip: { background: "#f3f4f6", borderRadius: 999, padding: "6px 10px", fontSize: 13, color: "#374151" },
  commandStatus: { padding: "6px 10px", borderRadius: 999, fontSize: 13, fontWeight: 800, color: "#111827" },
  replyCard: { background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 12, padding: 10, marginBottom: 10 },
  replyLabel: { color: "#9a3412", fontSize: 12, fontWeight: 800, marginBottom: 4 },
  replyText: { color: "#7c2d12", lineHeight: 1.5 },
  replyMeta: { color: "#7c2d12", lineHeight: 1.4, fontSize: 12, marginTop: 6, opacity: 0.85 },
  reactionList: { display: "grid", gap: 8, marginBottom: 10 },
  reactionItem: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", background: "#f3f4f6", borderRadius: 999, padding: "8px 12px", width: "fit-content", maxWidth: "100%" },
  reactionEmoji: { fontSize: 18 },
  reactionText: { color: "#374151", fontSize: 14 },
  reactionMeta: { color: "#6b7280", fontSize: 12 },
  rawSummary: { cursor: "pointer", color: "#9a3412", fontWeight: 700, marginBottom: 8 },
  pre: { direction: "ltr", textAlign: "left", background: "#111827", color: "#d1fae5", padding: 12, overflow: "auto", borderRadius: 12, fontSize: 12 }
};
