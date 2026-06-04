import React, { useEffect, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "/").replace(/\/$/, "");

export default function App() {
  const [messages, setMessages] = useState([]);
  const [commands, setCommands] = useState([]);
  const [chatFilter, setChatFilter] = useState("");
  const [apiToken, setApiToken] = useState(() => window.localStorage.getItem("wa-web-agent-api-token") || "");
  const [text, setText] = useState("שלום, זו הודעת בדיקה");
  const [imagePath, setImagePath] = useState("C:\\WA_FILES\\image1.png");
  const [caption, setCaption] = useState("מצורפת תמונה");

  async function load() {
    const msgUrl = new URL(`${API_BASE}/api/messages`);
    msgUrl.searchParams.set("limit", "100");
    if (chatFilter.trim()) msgUrl.searchParams.set("chat", chatFilter.trim());
    const m = await fetch(msgUrl).then((r) => r.json());
    setMessages(m.messages || []);

    const c = await fetch(`${API_BASE}/api/commands`, { headers: { "x-api-token": apiToken } }).then((r) => r.json());
    setCommands(c.commands || []);
  }

  async function createCommand(command) {
    await fetch(`${API_BASE}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-token": apiToken },
      body: JSON.stringify(command)
    });
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

  return (
    <div style={styles.page}>
      <h1>WA Web Agent</h1>

      <section style={styles.panel}>
        <h2>שליחת פקודות ל־WhatsApp Web</h2>
        <div style={styles.grid}>
          <label>API Token</label>
          <input value={apiToken} onChange={(e) => updateApiToken(e.target.value)} style={styles.input} />
          <label>טקסט לשליחה</label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} style={styles.textarea} />
          <button style={styles.button} onClick={() => createCommand({ action: "send_text", text })}>שלח טקסט</button>

          <label>נתיב תמונה ב־Windows</label>
          <input value={imagePath} onChange={(e) => setImagePath(e.target.value)} style={styles.input} />
          <label>Caption</label>
          <input value={caption} onChange={(e) => setCaption(e.target.value)} style={styles.input} />
          <button style={styles.button} onClick={() => createCommand({ action: "paste_image", filePath: imagePath, caption, send: true })}>הדבק ושלח תמונה</button>

          <button style={styles.button} onClick={() => createCommand({ action: "focus_message_box" })}>פוקוס לתיבת הודעה</button>
          <button style={styles.button} onClick={() => createCommand({ action: "get_state" })}>בדיקת מצב</button>
        </div>
      </section>

      <section style={styles.panel}>
        <h2>הודעות שנקלטו</h2>
        <div style={styles.toolbar}>
          <input placeholder="סינון לפי צ׳אט" value={chatFilter} onChange={(e) => setChatFilter(e.target.value)} style={styles.input} />
          <button onClick={load} style={styles.button}>רענון</button>
        </div>
        <div style={styles.list}>
          {messages.map((m) => (
            <div key={m.id} style={styles.card}>
              <div style={styles.meta}><b>{m.chat_title || "ללא שם"}</b><span>{new Date(m.created_at).toLocaleString("he-IL")}</span></div>
              <div><b>שולח:</b> {m.sender || "-"}</div>
              <div><b>סוג:</b> {m.event_type || "-"}</div>
              <p style={styles.text}>{m.message_text}</p>
              <details><summary>Raw</summary><pre style={styles.pre}>{JSON.stringify(m.raw_json, null, 2)}</pre></details>
            </div>
          ))}
        </div>
      </section>

      <section style={styles.panel}>
        <h2>פקודות אחרונות</h2>
        <div style={styles.list}>
          {commands.map((c) => (
            <div key={c.id} style={styles.card}>
              <div style={styles.meta}><b>#{c.id} {c.action}</b><span>{c.status}</span></div>
              <pre style={styles.pre}>{JSON.stringify({ command: c.command_json, result: c.result_json, error: c.error_text }, null, 2)}</pre>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const styles = {
  page: { fontFamily: "Arial, sans-serif", padding: 24, background: "#f5f5f5", minHeight: "100vh", direction: "rtl" },
  panel: { background: "#fff", padding: 18, borderRadius: 12, marginBottom: 18, boxShadow: "0 2px 8px rgba(0,0,0,.08)" },
  toolbar: { display: "flex", gap: 8, marginBottom: 12 },
  grid: { display: "grid", gap: 10 },
  input: { padding: 10, fontSize: 15, width: "100%", boxSizing: "border-box" },
  textarea: { padding: 10, fontSize: 15, minHeight: 70, width: "100%", boxSizing: "border-box" },
  button: { padding: "10px 16px", fontSize: 15, cursor: "pointer" },
  list: { display: "grid", gap: 12 },
  card: { border: "1px solid #ddd", borderRadius: 10, padding: 12, background: "#fafafa" },
  meta: { display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 },
  text: { whiteSpace: "pre-wrap" },
  pre: { direction: "ltr", textAlign: "left", background: "#111", color: "#0f0", padding: 10, overflow: "auto", borderRadius: 8 }
};
