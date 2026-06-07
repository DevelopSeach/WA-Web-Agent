import React, { useEffect, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "/").replace(/\/$/, "");

export default function App() {
  const [messages, setMessages] = useState([]);
  const [commands, setCommands] = useState([]);
  const [chatFilter, setChatFilter] = useState("");
  const [apiToken, setApiToken] = useState(() => window.localStorage.getItem("wa-web-agent-api-token") || "");
  const [text, setText] = useState("שלום, זו הודעת בדיקה");
  const [phoneNumber, setPhoneNumber] = useState("972544506093");
  const [imagePath, setImagePath] = useState("C:\\WA_FILES\\image1.png");
  const [caption, setCaption] = useState("מצורפת תמונה");
  const [status, setStatus] = useState({ type: "idle", message: "" });

  const incomingCount = messages.filter((message) => message.direction === "incoming").length;
  const outgoingCount = messages.filter((message) => message.direction === "outgoing").length;
  const latestMessage = messages[0] || null;

  async function load() {
    try {
      const msgUrl = new URL(`${API_BASE}/api/messages`);
      msgUrl.searchParams.set("limit", "100");
      if (chatFilter.trim()) msgUrl.searchParams.set("chat", chatFilter.trim());

      const [messagesResponse, commandsResponse] = await Promise.all([
        fetch(msgUrl),
        fetch(`${API_BASE}/api/commands`, { headers: { "x-api-token": apiToken } })
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
    const response = await fetch(`${API_BASE}/api/commands`, {
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

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [apiToken]);

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
            <p style={styles.panelDescription}>הפקודות נשלחות להרחבה בכרום. לצורך שליחה למספר, כתוב מספר בפורמט בינלאומי, למשל `972544506093`.</p>
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

          <label style={{ ...styles.field, gridColumn: "1 / -1" }}>
            <span style={styles.fieldLabel}>טקסט לשליחה</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} style={styles.textarea} />
          </label>

          <div style={styles.actionsRow}>
            <button style={styles.button} onClick={() => handleCommand({ action: "send_text_to_phone", phone: phoneNumber, text, send: true })}>
              שלח הודעת בדיקה למספר
            </button>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "open_chat", phone: phoneNumber, text })}>
              פתח צ׳אט למספר
            </button>
            <button style={styles.secondaryButton} onClick={() => handleCommand({ action: "send_text", text })}>
              שלח לצ׳אט הפתוח
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
              {latestMessage ? `ההודעה האחרונה התקבלה ב־${formatTime(latestMessage.created_at)}` : "עדיין לא נקלטו הודעות. אם שלחת webhook ידני בלבד, תראה כאן הודעות רק אחרי שההרחבה תשלח אירועי WhatsApp Web."}
            </p>
          </div>
        </div>
        <div style={styles.toolbar}>
          <input placeholder="סינון לפי צ׳אט" value={chatFilter} onChange={(e) => setChatFilter(e.target.value)} style={styles.input} />
          <button onClick={load} style={styles.secondaryButton}>רענון</button>
        </div>
        <div style={styles.messageList}>
          {messages.length === 0 ? (
            <div style={styles.emptyState}>אין עדיין הודעות. ברגע שההרחבה תקלוט הודעה נכנסת או יוצאת, היא תופיע כאן.</div>
          ) : messages.map((message) => (
            <article key={message.id} style={styles.messageCard}>
              <div style={styles.metaRow}>
                <div>
                  <div style={styles.chatTitle}>{message.chat_title || "ללא שם"}</div>
                  <div style={styles.subtleText}>מאת: {message.sender || "לא ידוע"}</div>
                </div>
                <div style={styles.alignEnd}>
                  <span style={{ ...styles.directionBadge, background: getDirectionColor(message.direction) }}>
                    {getDirectionLabel(message.direction)}
                  </span>
                  <span style={styles.timestamp}>{formatTime(message.created_at)}</span>
                </div>
              </div>
              <div style={styles.messageBody}>{message.message_text || "(ללא טקסט)"}</div>
              <div style={styles.metaChips}>
                <span style={styles.chip}>סוג: {message.event_type || "-"}</span>
                <span style={styles.chip}>UID: {message.message_uid}</span>
                {message.raw_json?.ack?.label ? <span style={styles.chip}>סטטוס: {message.raw_json.ack.label}</span> : null}
                {message.media_json?.length ? <span style={styles.chip}>מדיה: {message.media_json.length}</span> : null}
              </div>
              {message.raw_json?.reply_to ? (
                <div style={styles.replyCard}>
                  <div style={styles.replyLabel}>תגובה להודעה</div>
                  <div style={styles.replyText}>
                    {message.raw_json.reply_to.sender ? `${message.raw_json.reply_to.sender}: ` : ""}
                    {message.raw_json.reply_to.snippet || message.raw_json.reply_to.text}
                  </div>
                </div>
              ) : null}
              {Array.isArray(message.reactions_json) && message.reactions_json.length > 0 ? (
                <div style={styles.reactionList}>
                  {message.reactions_json.map((reaction, index) => (
                    <div key={`${message.id}-reaction-${index}`} style={styles.reactionItem}>
                      <span style={styles.reactionEmoji}>{Array.isArray(reaction.emojis) ? reaction.emojis.join(" ") : reaction.text}</span>
                      <span style={styles.reactionText}>
                        {Array.isArray(reaction.actors) && reaction.actors.length ? reaction.actors.join(", ") : reaction.text}
                      </span>
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

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("he-IL");
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
  toolbar: { display: "flex", gap: 8, marginBottom: 16 },
  input: { padding: 12, fontSize: 15, width: "100%", boxSizing: "border-box", border: "1px solid #d1d5db", borderRadius: 12, background: "#fff" },
  textarea: { padding: 12, fontSize: 15, minHeight: 100, width: "100%", boxSizing: "border-box", border: "1px solid #d1d5db", borderRadius: 12, background: "#fff" },
  actionsRow: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", gridColumn: "1 / -1" },
  button: { padding: "12px 18px", fontSize: 15, cursor: "pointer", borderRadius: 999, border: "none", background: "#111827", color: "#fff", fontWeight: 700 },
  secondaryButton: { padding: "12px 18px", fontSize: 15, cursor: "pointer", borderRadius: 999, border: "1px solid #d1d5db", background: "#fff", color: "#111827", fontWeight: 700 },
  list: { display: "grid", gap: 12 },
  messageList: { display: "grid", gap: 12 },
  emptyState: { border: "1px dashed #d1d5db", borderRadius: 14, padding: 24, color: "#6b7280", textAlign: "center", background: "#f9fafb" },
  messageCard: { border: "1px solid #e5e7eb", borderRadius: 16, padding: 14, background: "#fcfcfd" },
  commandCard: { border: "1px solid #e5e7eb", borderRadius: 16, padding: 14, background: "#f9fafb" },
  metaRow: { display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 10, alignItems: "flex-start" },
  alignEnd: { display: "grid", gap: 8, justifyItems: "end" },
  chatTitle: { fontWeight: 800, fontSize: 18, marginBottom: 4 },
  subtleText: { color: "#6b7280", fontSize: 14 },
  directionBadge: { padding: "6px 10px", borderRadius: 999, fontSize: 13, fontWeight: 800, color: "#111827" },
  timestamp: { color: "#6b7280", fontSize: 13 },
  messageBody: { whiteSpace: "pre-wrap", fontSize: 16, lineHeight: 1.7, marginBottom: 10 },
  metaChips: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 },
  chip: { background: "#f3f4f6", borderRadius: 999, padding: "6px 10px", fontSize: 13, color: "#374151" },
  commandStatus: { padding: "6px 10px", borderRadius: 999, fontSize: 13, fontWeight: 800, color: "#111827" },
  replyCard: { background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 12, padding: 10, marginBottom: 10 },
  replyLabel: { color: "#9a3412", fontSize: 12, fontWeight: 800, marginBottom: 4 },
  replyText: { color: "#7c2d12", lineHeight: 1.5 },
  reactionList: { display: "grid", gap: 8, marginBottom: 10 },
  reactionItem: { display: "flex", gap: 10, alignItems: "center", background: "#f3f4f6", borderRadius: 999, padding: "8px 12px", width: "fit-content", maxWidth: "100%" },
  reactionEmoji: { fontSize: 18 },
  reactionText: { color: "#374151", fontSize: 14 },
  rawSummary: { cursor: "pointer", color: "#9a3412", fontWeight: 700, marginBottom: 8 },
  pre: { direction: "ltr", textAlign: "left", background: "#111827", color: "#d1fae5", padding: 12, overflow: "auto", borderRadius: 12, fontSize: 12 }
};
