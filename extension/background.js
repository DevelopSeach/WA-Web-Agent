const DEFAULT_CONFIG = {
  webhookUrl: "http://localhost:3001/api/whatsapp-webhook",
  commandUrl: "http://localhost:3001/api/commands/next",
  commandResultUrl: "http://localhost:3001/api/commands/result",
  apiToken: "CHANGE_ME_SECRET",
  enabled: true,
  pollCommands: true,
  pollSeconds: 3
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_CONFIG));
  await chrome.storage.local.set({ ...DEFAULT_CONFIG, ...existing });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "WA_EVENT") return;
  handleWaEvent(message.payload, sender)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

async function config() {
  const cfg = await chrome.storage.local.get(Object.keys(DEFAULT_CONFIG));
  return { ...DEFAULT_CONFIG, ...cfg };
}

async function getWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  return tabs[0] || null;
}

async function handleWaEvent(payload, sender) {
  const cfg = await config();
  if (cfg.enabled === false) return { ok: false, skipped: true, reason: "disabled" };

  const body = {
    ...payload,
    extension: {
      id: chrome.runtime.id,
      tab_id: sender?.tab?.id || null,
      tab_url: sender?.tab?.url || null
    }
  };

  const response = await fetch(cfg.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-token": cfg.apiToken },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Webhook failed ${response.status}: ${text}`);
  return { ok: true, status: response.status };
}

async function ensureDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    if (!String(err?.message || err).includes("Another debugger")) throw err;
  }
}

async function debuggerCommand(tabId, method, params = {}) {
  await ensureDebugger(tabId);
  return await chrome.debugger.sendCommand({ tabId }, method, params);
}

async function clickAt(tabId, x, y) {
  await debuggerCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await debuggerCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function insertText(tabId, text) {
  await debuggerCommand(tabId, "Input.insertText", { text: String(text || "") });
}

async function pressKey(tabId, key) {
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key });
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key });
}

async function sendToNative(command) {
  return await chrome.runtime.sendNativeMessage("com.seach.wa_native_host", command);
}

async function sendContentCommand(tabId, command) {
  return await chrome.tabs.sendMessage(tabId, { type: "WA_CONTENT_COMMAND", command });
}

async function executeCommand(command) {
  const tab = await getWhatsAppTab();
  if (!tab) throw new Error("WhatsApp Web tab not found");
  const tabId = tab.id;

  switch (command.action) {
    case "get_state":
      return await sendContentCommand(tabId, { action: "get_state" });

    case "focus_message_box":
      return await sendContentCommand(tabId, { action: "focus_message_box" });

    case "insert_text":
      await sendContentCommand(tabId, { action: "focus_message_box" });
      await insertText(tabId, command.text || "");
      return { ok: true };

    case "send_text":
      await sendContentCommand(tabId, { action: "focus_message_box" });
      await insertText(tabId, command.text || "");
      if (command.enter !== false) await pressKey(tabId, "Enter");
      return { ok: true };

    case "click":
      await clickAt(tabId, Number(command.x), Number(command.y));
      return { ok: true };

    case "press_key":
      await pressKey(tabId, command.key || "Enter");
      return { ok: true };

    case "paste_image":
      await sendContentCommand(tabId, { action: "focus_message_box" });
      return await sendToNative({ action: "paste_image", filePath: command.filePath, caption: command.caption || "", send: command.send !== false });

    case "paste_file":
      await sendContentCommand(tabId, { action: "focus_message_box" });
      return await sendToNative({ action: "paste_file", filePath: command.filePath, caption: command.caption || "", send: command.send !== false });

    case "native":
      return await sendToNative(command.payload || {});

    default:
      throw new Error(`Unknown command action: ${command.action}`);
  }
}

async function reportCommandResult(commandId, result) {
  const cfg = await config();
  await fetch(cfg.commandResultUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-token": cfg.apiToken },
    body: JSON.stringify({ command_id: commandId, result })
  });
}

async function pollCommands() {
  const cfg = await config();
  if (!cfg.enabled || !cfg.pollCommands) return;

  try {
    const res = await fetch(cfg.commandUrl, { headers: { "x-api-token": cfg.apiToken } });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.command) return;

    let result;
    try {
      result = await executeCommand(data.command);
    } catch (err) {
      result = { ok: false, error: String(err?.message || err) };
    }
    await reportCommandResult(data.command.id, result);
  } catch (err) {
    console.warn("Command poll failed", err);
  }
}

setInterval(pollCommands, 3000);
