(() => {
  if (window.__waAgentContentInstalled) return;
  window.__waAgentContentInstalled = true;

  const seen = new Set();

  injectPageHook();

  function injectPageHook() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("pageHook.js");
    script.onload = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "WA_PAGE_HOOK") return;

    sendToBackground({
      event_type: data.event_type || "page_hook",
      source: "whatsapp_web_extension_page_hook",
      payload: data.payload || {},
      captured_at: new Date().toISOString()
    });
  });

  function cleanText(value) {
    return String(value || "")
      .replace(/\u200e/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getCurrentChatTitle() {
    const header = document.querySelector("header");
    if (!header) return "";
    const titleNode = header.querySelector("span[title]");
    if (titleNode) return titleNode.getAttribute("title") || "";
    return cleanText(header.innerText);
  }

  function parsePrePlainText(value) {
    const result = { sent_at_text: "", sender: "" };
    if (!value) return result;
    const match = value.match(/^\[(.*?)\]\s*(.*?):\s*$/);
    if (match) {
      result.sent_at_text = match[1] || "";
      result.sender = match[2] || "";
    }
    return result;
  }

  function detectDirection(el) {
    if (el.closest(".message-in")) return "incoming";
    if (el.closest(".message-out")) return "outgoing";
    const classes = String(el.className || "");
    if (classes.includes("message-in")) return "incoming";
    if (classes.includes("message-out")) return "outgoing";
    return "unknown";
  }

  function extractMedia(el) {
    const media = [];
    el.querySelectorAll("img").forEach((img) => {
      media.push({
        kind: "image",
        src: img.currentSrc || img.src || "",
        alt: img.alt || "",
        width: img.naturalWidth || img.width || null,
        height: img.naturalHeight || img.height || null
      });
    });
    el.querySelectorAll("video").forEach((video) => {
      media.push({
        kind: "video",
        src: video.currentSrc || video.src || "",
        duration: Number.isFinite(video.duration) ? video.duration : null
      });
    });
    el.querySelectorAll("audio").forEach((audio) => {
      media.push({
        kind: "audio",
        src: audio.currentSrc || audio.src || "",
        duration: Number.isFinite(audio.duration) ? audio.duration : null
      });
    });
    el.querySelectorAll("a[href]").forEach((a) => {
      media.push({ kind: "link", href: a.href, text: cleanText(a.innerText) });
    });
    return media;
  }

  function extractReactions(el) {
    const reactions = [];
    const nodes = [
      ...el.querySelectorAll("[aria-label*='reaction' i]"),
      ...el.querySelectorAll("[aria-label*='תגובה' i]"),
      ...el.querySelectorAll("button[aria-label]")
    ];
    nodes.forEach((node) => {
      const text = cleanText(node.innerText || node.getAttribute("aria-label") || "");
      if (!text) return;
      const emojis = text.match(/\p{Extended_Pictographic}/gu);
      if (!emojis || !emojis.length) return;

      const actors = [];
      const byMatch = text.match(/(?:by|from)\s+(.+)$/i);
      if (byMatch?.[1]) actors.push(...byMatch[1].split(/,|&/).map((value) => cleanText(value)).filter(Boolean));

      const hebrewMatch = text.match(/(?:מאת|על ידי)\s+(.+)$/i);
      if (hebrewMatch?.[1]) actors.push(...hebrewMatch[1].split(/,|&|ו/).map((value) => cleanText(value)).filter(Boolean));

      reactions.push({
        text,
        emojis,
        actors: [...new Set(actors)]
      });
    });
    return reactions;
  }

  function extractAck(messageEl) {
    const iconNames = [
      "msg-check",
      "msg-dblcheck",
      "msg-dblcheck-ack",
      "msg-time",
      "msg-error"
    ];

    for (const iconName of iconNames) {
      if (messageEl.querySelector(`[data-icon='${iconName}']`)) {
        if (iconName === "msg-check") return { code: "sent", label: "sent" };
        if (iconName === "msg-dblcheck") return { code: "delivered", label: "delivered" };
        if (iconName === "msg-dblcheck-ack") return { code: "read", label: "read" };
        if (iconName === "msg-time") return { code: "pending", label: "pending" };
        if (iconName === "msg-error") return { code: "error", label: "error" };
      }
    }

    const statusNode = messageEl.querySelector("[aria-label*='read' i], [aria-label*='delivered' i], [aria-label*='sent' i], [aria-label*='נקראה' i], [aria-label*='נמסרה' i], [aria-label*='נשלחה' i]");
    if (!statusNode) return null;

    const label = cleanText(statusNode.getAttribute("aria-label") || statusNode.innerText);
    const lower = label.toLowerCase();
    if (lower.includes("read") || label.includes("נקרא")) return { code: "read", label };
    if (lower.includes("delivered") || label.includes("נמסר")) return { code: "delivered", label };
    if (lower.includes("sent") || label.includes("נשלח")) return { code: "sent", label };
    return { code: "unknown", label };
  }

  function extractReplyContext(messageEl) {
    const candidates = [
      ...messageEl.querySelectorAll("[data-testid*='quoted' i]"),
      ...messageEl.querySelectorAll("[data-testid*='reply' i]"),
      ...messageEl.querySelectorAll("[aria-label*='quoted' i]"),
      ...messageEl.querySelectorAll("[aria-label*='reply' i]"),
      ...messageEl.querySelectorAll("[aria-label*='תגובה' i]")
    ];

    const quotedNode = candidates.find((node) => cleanText(node.innerText || node.getAttribute("aria-label") || "").length > 0);
    if (!quotedNode) return null;

    const text = cleanText(quotedNode.innerText || quotedNode.getAttribute("aria-label") || "");
    if (!text) return null;

    const lines = text.split("\n").map((value) => cleanText(value)).filter(Boolean);
    return {
      text,
      sender: lines.length > 1 ? lines[0] : null,
      snippet: lines.length > 1 ? lines.slice(1).join(" ") : text
    };
  }

  function extractMessage(el) {
    const messageEl = el.closest("[data-id]") || el;
    if (!messageEl || !messageEl.getAttribute) return null;
    const uid = messageEl.getAttribute("data-id");
    if (!uid || seen.has(uid)) return null;

    const copyable = messageEl.querySelector("[data-pre-plain-text]");
    const prePlainText = copyable ? copyable.getAttribute("data-pre-plain-text") : "";
    const parsed = parsePrePlainText(prePlainText);
    const textNode = messageEl.querySelector(".copyable-text") || messageEl;

    const record = {
      event_type: "message",
      source: "whatsapp_web_extension_dom",
      uid,
      chat_title: getCurrentChatTitle(),
      sender: parsed.sender,
      sent_at_text: parsed.sent_at_text,
      direction: detectDirection(messageEl),
      text: cleanText(textNode.innerText),
      ack: extractAck(messageEl),
      reply_to: extractReplyContext(messageEl),
      media: extractMedia(messageEl),
      reactions: extractReactions(messageEl),
      page_url: location.href,
      captured_at: new Date().toISOString()
    };

    seen.add(uid);
    return record;
  }

  function scan(root) {
    const nodes = [];
    if (root?.matches?.("[data-id]")) nodes.push(root);
    if (root?.querySelectorAll) root.querySelectorAll("[data-id]").forEach((n) => nodes.push(n));
    nodes.forEach((node) => {
      const msg = extractMessage(node);
      if (msg) sendToBackground(msg);
    });
  }

  function sendToBackground(payload) {
    chrome.runtime.sendMessage({ type: "WA_EVENT", payload });
  }

  function findMessageBox() {
    const boxes = [...document.querySelectorAll("div[contenteditable='true'][role='textbox']")];
    return boxes[boxes.length - 1] || null;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "WA_CONTENT_COMMAND") return;

    try {
      if (message.command?.action === "focus_message_box") {
        const box = findMessageBox();
        if (!box) throw new Error("Message box not found");
        box.focus();
        sendResponse({ ok: true });
        return true;
      }

      if (message.command?.action === "get_state") {
        sendResponse({ ok: true, chat_title: getCurrentChatTitle(), url: location.href });
        return true;
      }

      sendResponse({ ok: false, error: "Unknown content command" });
      return true;
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
      return true;
    }
  });

  const start = () => {
    scan(document.body);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) scan(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    sendToBackground({ event_type: "extension_started", source: "whatsapp_web_extension", page_url: location.href, captured_at: new Date().toISOString() });
  };

  if (document.body) start();
  else window.addEventListener("DOMContentLoaded", start, { once: true });
})();
