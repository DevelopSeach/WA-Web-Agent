const DEFAULT_CONFIG = {
  webhookUrl: "",
  commandUrl: "",
  commandResultUrl: "",
  apiToken: "CHANGE_ME_SECRET",
  enabled: true,
  pollCommands: true,
  pollSeconds: 3
};

async function loadRuntimeDefaults() {
  try {
    const res = await fetch(chrome.runtime.getURL("runtime-config.json"));
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

function mergeConfig(runtime = {}) {
  return {
    ...DEFAULT_CONFIG,
    webhookUrl: runtime.webhookUrl || DEFAULT_CONFIG.webhookUrl,
    commandUrl: runtime.commandUrl || DEFAULT_CONFIG.commandUrl,
    commandResultUrl: runtime.commandResultUrl || DEFAULT_CONFIG.commandResultUrl,
    apiToken: runtime.apiToken || DEFAULT_CONFIG.apiToken,
    enabled: runtime.enabled !== false,
    pollCommands: runtime.pollCommands !== false,
    pollSeconds: Number(runtime.pollSeconds || DEFAULT_CONFIG.pollSeconds)
  };
}

const runtimeDefaultsPromise = loadRuntimeDefaults().then(mergeConfig);

chrome.runtime.onInstalled.addListener(async () => {
  const defaults = await runtimeDefaultsPromise;
  const existing = await chrome.storage.local.get(Object.keys(defaults));
  await chrome.storage.local.set({ ...defaults, ...existing });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "WA_EVENT") return;
  handleWaEvent(message.payload, sender)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

async function config() {
  const defaults = await runtimeDefaultsPromise;
  const cfg = await chrome.storage.local.get(Object.keys(defaults));
  return { ...defaults, ...cfg };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await sleep(250);
  }
  throw new Error("Timed out waiting for WhatsApp Web tab to load");
}

function normalizePhone(rawPhone) {
  const phone = String(rawPhone || "").trim();
  const normalized = phone.startsWith("+")
    ? `+${phone.slice(1).replace(/\D/g, "")}`
    : phone.replace(/\D/g, "");
  if (!normalized || normalized === "+") throw new Error("Missing phone number");
  return normalized.startsWith("+") ? normalized.slice(1) : normalized;
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

async function captureRecentMessages(tabId, iterations = 5, waitMs = 400) {
  try {
    return await sendContentCommand(tabId, { action: "capture_recent_messages", iterations, waitMs });
  } catch {
    return { ok: false };
  }
}

async function validateCurrentChat(tabId, expected = {}) {
  const result = await sendContentCommand(tabId, { action: "validate_current_chat", expected });
  if (!result?.ok) {
    throw new Error(result?.error || "Chat validation failed");
  }
  return result;
}

async function openChatByPhone(tabId, phone) {
  const normalizedPhone = normalizePhone(phone);
  const params = new URLSearchParams({ phone: normalizedPhone });
  await chrome.tabs.update(tabId, {
    url: `https://web.whatsapp.com/send?${params.toString()}`
  });
  await waitForTabComplete(tabId);
  await sleep(3000);
  await validateCurrentChat(tabId, { phone: normalizedPhone });
  return { ok: true, phone: normalizedPhone };
}

async function openChatByName(tabId, chatName) {
  return await openChatByNameWithOptions(tabId, chatName, { includeArchived: false });
}

async function openChatByNameWithOptions(tabId, chatName, options = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith("https://web.whatsapp.com/")) {
    await chrome.tabs.update(tabId, { url: "https://web.whatsapp.com/" });
    await waitForTabComplete(tabId);
    await sleep(2500);
  }

  const result = await sendContentCommand(tabId, {
    action: "open_chat_by_name",
    chatName,
    includeArchived: options.includeArchived === true
  });
  if (!result?.ok) throw new Error(result?.error || `Chat not found: ${chatName}`);
  await validateCurrentChat(tabId, { chatName });
  return result;
}

async function tryUnarchiveCurrentChat(tabId) {
  return await sendContentCommand(tabId, { action: "unarchive_current_chat" });
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
      await sleep(1200);
      await captureRecentMessages(tabId);
      return { ok: true };

    case "open_chat":
      return await openChatByPhone(tabId, command.phone);

    case "open_group":
      return await openChatByName(tabId, command.chatName || command.groupName || "");

    case "open_archived_chat":
      return await openChatByNameWithOptions(tabId, command.chatName || command.groupName || "", { includeArchived: true });

    case "send_text_to_phone":
      await openChatByPhone(tabId, command.phone);
      await sendContentCommand(tabId, { action: "focus_message_box" });
      await sleep(300);
      await insertText(tabId, command.text || "");
      if (command.send !== false) {
        await pressKey(tabId, "Enter");
      }
      await sleep(1200);
      await captureRecentMessages(tabId);
      return { ok: true, phone: normalizePhone(command.phone) };

    case "send_text_to_archived_phone": {
      await openChatByPhone(tabId, command.phone);
      await sendContentCommand(tabId, { action: "focus_message_box" });
      await sleep(300);
      await insertText(tabId, command.text || "");
      if (command.send !== false) {
        await pressKey(tabId, "Enter");
      }
      await sleep(1200);
      await captureRecentMessages(tabId);
      const unarchiveResult = command.makeVisible === true ? await tryUnarchiveCurrentChat(tabId) : null;
      return { ok: true, phone: normalizePhone(command.phone), unarchive: unarchiveResult };
    }

    case "send_text_to_group":
      await openChatByName(tabId, command.chatName || command.groupName || "");
      await sendContentCommand(tabId, { action: "focus_message_box" });
      await sleep(300);
      await insertText(tabId, command.text || "");
      if (command.send !== false) {
        await pressKey(tabId, "Enter");
      }
      await sleep(1200);
      await captureRecentMessages(tabId);
      return { ok: true, chat_name: command.chatName || command.groupName || "" };

    case "send_text_to_archived_group": {
      await openChatByNameWithOptions(tabId, command.chatName || command.groupName || "", { includeArchived: true });
      await sendContentCommand(tabId, { action: "focus_message_box" });
      await sleep(300);
      await insertText(tabId, command.text || "");
      if (command.send !== false) {
        await pressKey(tabId, "Enter");
      }
      await sleep(1200);
      await captureRecentMessages(tabId);
      const unarchiveResult = command.makeVisible === true ? await tryUnarchiveCurrentChat(tabId) : null;
      return {
        ok: true,
        chat_name: command.chatName || command.groupName || "",
        unarchive: unarchiveResult
      };
    }

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
