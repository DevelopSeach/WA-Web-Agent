(() => {
  if (window.__waAgentContentInstalled) return;
  window.__waAgentContentInstalled = true;

  const seen = new Set();
  let periodicScanHandle = null;

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
      .replace(/[\u200f\u202a-\u202e\u2066-\u2069]/g, "")
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

  function getHeaderText() {
    const header = document.querySelector("header");
    return header ? cleanText(header.innerText) : "";
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

  function inferMessageMetaFromText(value) {
    const text = cleanText(value);
    const result = { sent_at_text: "", sender: "", body: text };
    if (!text) return result;

    const patterns = [
      /^(?<sender>.+?)\s+(?<date>\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?<body>.+)$/u,
      /^(?<sender>.+?)\s+(?<date>\d{1,2}\.\d{1,2}\.\d{2,4})\s+(?<body>.+)$/u,
      /^(?<sender>.+?)\s+(?<time>\d{1,2}:\d{2})\s+(?<body>.+)$/u
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match?.groups) continue;
      result.sender = cleanText(match.groups.sender || "");
      result.sent_at_text = cleanText(match.groups.date || match.groups.time || "");
      result.body = cleanText(match.groups.body || text);
      if (result.sender || result.sent_at_text) return result;
    }

    return result;
  }

  function stripUnreadNoise(value) {
    return cleanText(String(value || "")
      .replace(/\b\d+\s+unread\s+messages?\b/gi, "")
      .replace(/\b\d+\s+unread\b/gi, "")
      .replace(/\bunread\s+messages?\b/gi, "")
      .replace(/\btyping…?\b/gi, "")
      .replace(/\btyping\.\.\.\b/gi, "")
      .replace(/\s+\d+\s*$/g, "")
    );
  }

  function isTypingValue(value) {
    const text = cleanText(value).toLowerCase();
    return text === "typing…" || text === "typing..." || text === "מקליד…";
  }

  function isWeakSidebarBody(body, title, timeCandidate) {
    const text = cleanText(body);
    const titleText = cleanText(title);
    const joined = cleanText(`${titleText} ${timeCandidate || ""}`);
    if (!text) return true;
    if (isTypingValue(titleText)) return true;
    if (isTypingValue(text)) return true;
    if (text === "…" || text === "...") return true;
    if (text === titleText) return true;
    if (joined && text === joined) return true;
    if (isMostlyNumeric(titleText) && isMostlyNumeric(text) && text.length <= 2) return true;
    if (isMostlyNumeric(titleText) && !timeCandidate && isMostlyNumeric(text) && text.length <= 2) return true;
    return false;
  }

  function extractSidebarPhone(title, allText) {
    const titlePhone = normalizePhoneCandidate(title);
    if (titlePhone && titlePhone.length >= 8) return titlePhone;

    const candidates = String(allText || "").match(/(?:\+\d[\d\s\-().]{6,}\d|\d{8,15})/g) || [];
    for (const candidate of candidates) {
      const normalized = normalizePhoneCandidate(candidate);
      if (normalized && normalized.length >= 8) return normalized;
    }
    return null;
  }

  function splitTrailingTime(value) {
    const text = cleanText(value);
    const match = text.match(/^(.*?)(\d{1,2}:\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4})$/);
    if (!match) return { text, time: "" };
    return {
      text: cleanText(match[1]),
      time: cleanText(match[2])
    };
  }

  function hasLetters(value) {
    return /[A-Za-z\u0590-\u05FF]/.test(String(value || ""));
  }

  function isMostlyNumeric(value) {
    const text = cleanText(value).replace(/[+\-\s().]/g, "");
    return !!text && /^\d+$/.test(text);
  }

  function normalizePhoneCandidate(value) {
    const text = String(value || "").trim();
    const hasPlus = text.startsWith("+");
    const digits = text.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return null;
    return hasPlus ? `+${digits}` : digits;
  }

  function extractPhoneCandidates(value) {
    const matches = String(value || "").match(/(?:\+?\d[\d\s\-().]{6,}\d)/g) || [];
    return matches
      .map((match) => normalizePhoneCandidate(match))
      .filter(Boolean);
  }

  function extractSenderPhone(messageEl, parsedSender, prePlainText) {
    const candidates = new Set();

    extractPhoneCandidates(parsedSender).forEach((phone) => candidates.add(phone));
    extractPhoneCandidates(prePlainText).forEach((phone) => candidates.add(phone));

    const selectors = [
      "[data-pre-plain-text]",
      "[aria-label]",
      "[title]"
    ];

    for (const selector of selectors) {
      messageEl.querySelectorAll(selector).forEach((node) => {
        extractPhoneCandidates(node.getAttribute("aria-label") || "").forEach((phone) => candidates.add(phone));
        extractPhoneCandidates(node.getAttribute("title") || "").forEach((phone) => candidates.add(phone));
        extractPhoneCandidates(node.textContent || "").forEach((phone) => candidates.add(phone));
      });
    }

    return [...candidates][0] || null;
  }

  function detectTargetType() {
    const href = String(location.href || "");
    if (href.includes("@g.us") || href.includes("%40g.us")) return "group";
    const headerText = getHeaderText().toLowerCase();
    if (headerText.includes("group") || headerText.includes("קבוצה")) return "group";
    return "direct";
  }

  function extractTargetPhone() {
    const candidates = new Set();
    extractPhoneCandidates(location.href).forEach((phone) => candidates.add(phone));

    const header = document.querySelector("header");
    if (header) {
      extractPhoneCandidates(header.innerText || "").forEach((phone) => candidates.add(phone));
      header.querySelectorAll("[title], [aria-label]").forEach((node) => {
        extractPhoneCandidates(node.getAttribute("title") || "").forEach((phone) => candidates.add(phone));
        extractPhoneCandidates(node.getAttribute("aria-label") || "").forEach((phone) => candidates.add(phone));
      });
    }

    return [...candidates][0] || null;
  }

  function isGenericTargetName(value) {
    const text = cleanText(value).toLowerCase();
    if (!text) return true;
    return [
      "chats",
      "updates in status",
      "status",
      "search",
      "חיפוש",
      "עדכונים",
      "סטטוס"
    ].includes(text);
  }

  function extractTargetName() {
    const header = document.querySelector("header");
    if (!header) return "";

    const titleCandidates = [
      ...header.querySelectorAll("span[title]"),
      ...header.querySelectorAll("[title]"),
      ...header.querySelectorAll("[aria-label]")
    ]
      .map((node) => cleanText(node.getAttribute("title") || node.getAttribute("aria-label") || node.textContent || ""))
      .filter(Boolean);

    const preferred = titleCandidates.find((candidate) => !isGenericTargetName(candidate) && !normalizePhoneCandidate(candidate));
    if (preferred) return preferred;

    const title = getCurrentChatTitle();
    return isGenericTargetName(title) ? "" : title;
  }

  function detectDirection(el) {
    if (extractAck(el)?.code) return "outgoing";
    if (el.closest(".message-in")) return "incoming";
    if (el.closest(".message-out")) return "outgoing";
    const classes = String(el.className || "");
    if (classes.includes("message-in")) return "incoming";
    if (classes.includes("message-out")) return "outgoing";
    const attrs = cleanText([
      el.getAttribute?.("data-testid"),
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("class")
    ].join(" ")).toLowerCase();
    if (attrs.includes("out") || attrs.includes("sent")) return "outgoing";
    if (attrs.includes("in") || attrs.includes("received")) return "incoming";
    return "unknown";
  }

  function getChatRoots() {
    return [
      document.querySelector("#main"),
      document.querySelector("[data-testid='conversation-panel-body']"),
      document.querySelector("[data-testid='conversation-panel-messages']"),
      document.querySelector("[aria-label*='Message list' i]")
    ].filter(Boolean);
  }

  function isInConversationPanel(node) {
    if (!node || !node.closest) return false;
    return !!node.closest("#main");
  }

  function getSidebarRoot() {
    return document.querySelector("#pane-side")
      || document.querySelector("#side")
      || document.querySelector("[data-testid='chat-list']")
      || document.querySelector("[aria-label*='Chat list' i]");
  }

  function isSidebarGenericTitle(value) {
    const text = cleanText(value).toLowerCase();
    return [
      "",
      "chats",
      "archived",
      "archive",
      "status",
      "updates",
      "updates in status",
      "communities",
      "starred",
      "search",
      "חיפוש",
      "עדכונים",
      "ארכיון",
      "קהילות"
    ].includes(text);
  }

  function findMessageElement(el) {
    if (!el || !el.closest) return null;
    return el.closest("[data-id]")
      || el.closest("[data-pre-plain-text]")
      || el.closest("[data-testid*='msg']")
      || el.closest(".copyable-text")
      || el;
  }

  function buildSyntheticUid(messageEl, prePlainText, text, direction) {
    const base = [
      cleanText(prePlainText),
      cleanText(text),
      cleanText(direction),
      cleanText(getCurrentChatTitle())
    ].join("|");
    if (!base.replace(/\|/g, "").trim()) return "";
    let hash = 0;
    for (let index = 0; index < base.length; index += 1) {
      hash = ((hash << 5) - hash) + base.charCodeAt(index);
      hash |= 0;
    }
    return `synthetic-${Math.abs(hash)}`;
  }

  function buildStringHash(prefix, parts) {
    const base = [prefix, ...parts.map((part) => cleanText(part))].join("|");
    let hash = 0;
    for (let index = 0; index < base.length; index += 1) {
      hash = ((hash << 5) - hash) + base.charCodeAt(index);
      hash |= 0;
    }
    return `${prefix}-${Math.abs(hash)}`;
  }

  function buildParticipantKey(prefix, parts) {
    return buildStringHash(prefix, parts).replace(`${prefix}-`, `${prefix}_`);
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
    const messageEl = findMessageElement(el);
    if (!messageEl || !messageEl.getAttribute) return null;
    if (!isInConversationPanel(messageEl)) return null;

    const copyable = messageEl.querySelector("[data-pre-plain-text]");
    const prePlainText = copyable ? copyable.getAttribute("data-pre-plain-text") : "";
    const parsed = parsePrePlainText(prePlainText);
    const textNode = messageEl.querySelector(".copyable-text") || messageEl;
    const rawText = cleanText(textNode.innerText || textNode.textContent || "");
    const inferredMeta = inferMessageMetaFromText(rawText);
    const direction = detectDirection(messageEl);
    const inferredDirection = direction === "unknown"
      ? ((parsed.sender || inferredMeta.sender) ? "incoming" : "unknown")
      : direction;
    const uid = messageEl.getAttribute("data-id") || buildSyntheticUid(messageEl, prePlainText, rawText, inferredDirection);
    if (!uid || seen.has(uid)) return null;
    if (!rawText && !prePlainText && !messageEl.querySelector("img, video, audio, a[href], [data-icon]")) return null;

    const targetType = detectTargetType();
    const senderPhone = extractSenderPhone(messageEl, parsed.sender, prePlainText);
    const extractedTargetName = extractTargetName();
    const extractedTargetPhone = extractTargetPhone();

    const record = {
      event_type: "message",
      source: "whatsapp_web_extension_dom",
      uid,
      chat_title: getCurrentChatTitle(),
      target_name: targetType === "direct"
        ? (extractedTargetName || (inferredDirection === "incoming" ? (parsed.sender || inferredMeta.sender) : ""))
        : (extractedTargetName || getCurrentChatTitle()),
      target_phone: targetType === "direct"
        ? (extractedTargetPhone || (inferredDirection === "incoming" ? senderPhone : null))
        : extractedTargetPhone,
      target_key: targetType === "direct"
        ? (extractedTargetPhone || buildParticipantKey("target", [extractedTargetName || getCurrentChatTitle(), targetType]))
        : buildParticipantKey("target", [extractedTargetName || getCurrentChatTitle(), targetType]),
      target_type: targetType,
      sender: parsed.sender || inferredMeta.sender || null,
      sender_phone: senderPhone,
      sender_key: senderPhone || buildParticipantKey("sender", [parsed.sender || inferredMeta.sender || getCurrentChatTitle(), targetType]),
      sent_at_text: parsed.sent_at_text || inferredMeta.sent_at_text,
      direction: inferredDirection,
      text: inferredMeta.body || rawText,
      ack: extractAck(messageEl),
      reply_to: extractReplyContext(messageEl),
      media: extractMedia(messageEl),
      reactions: extractReactions(messageEl),
      page_url: location.href,
      captured_at: new Date().toISOString()
    };

    return record;
  }

  function scan(root) {
    if (!isInConversationPanel(root) && root !== document.body) return;
    const nodes = [];
    if (root?.matches?.("[data-id], [data-pre-plain-text], .copyable-text, [data-testid*='msg']")) nodes.push(root);
    if (root?.querySelectorAll) {
      root.querySelectorAll("[data-id], [data-pre-plain-text], .copyable-text, [data-testid*='msg']").forEach((n) => nodes.push(n));
    }
    nodes.forEach((node) => {
      const msg = extractMessage(node);
      if (msg) sendToBackground(msg);
    });
  }

  function collectSidebarRows() {
    const side = getSidebarRoot();
    if (!side) return [];
    return [
      ...side.querySelectorAll("[role='listitem']"),
      ...side.querySelectorAll("[role='gridcell']"),
      ...side.querySelectorAll("[role='row']"),
      ...side.querySelectorAll("div[data-testid*='cell-frame']"),
      ...side.querySelectorAll("div[data-testid*='chat-list-item']"),
      ...side.querySelectorAll("div[data-testid*='cell-frame-container']"),
      ...side.querySelectorAll("[aria-selected]"),
      ...side.querySelectorAll("[data-testid*='cell-frame-title']")
    ];
  }

  function inferSidebarTitle(lines) {
    return lines
      .map((line) => splitTrailingTime(stripUnreadNoise(line)).text)
      .find((line) => line && !isSidebarGenericTitle(line) && !isTypingValue(line) && !/^\d+$/.test(line))
      || "";
  }

  function parseSidebarSingleLine(allText) {
    const text = cleanText(allText);
    if (!text) return null;

    const unreadDirect = text.match(/^\d+\s+unread\s+messages?\s+(.+?)\s+(\d{1,2}:\d{2})\s+(.+?)\s+\d+$/i);
    if (unreadDirect) {
      return {
        title: cleanText(unreadDirect[1]),
        time: cleanText(unreadDirect[2]),
        body: cleanText(unreadDirect[3])
      };
    }

    const direct = text.match(/^(.+?)\s+(\d{1,2}:\d{2})\s+(.+)$/);
    if (direct) {
      return {
        title: cleanText(direct[1]),
        time: cleanText(direct[2]),
        body: cleanText(direct[3])
      };
    }

    const group = text.match(/^(.+?)\s+(\d{1,2}:\d{2})\s+(.+?)\s*:\s*(.+)$/);
    if (group) {
      return {
        title: cleanText(group[1]),
        time: cleanText(group[2]),
        sender: cleanText(group[3]),
        body: cleanText(group[4])
      };
    }

    return null;
  }

  function extractSidebarRowMessage(row) {
    if (!row || !getSidebarRoot()?.contains(row)) return null;

    const rawSidebarText = String(row.innerText || row.textContent || "");
    const allText = cleanText(rawSidebarText);
    if (!allText) return null;
    const singleLineMeta = parseSidebarSingleLine(allText);

    const lines = rawSidebarText
      .split("\n")
      .map((value) => cleanText(value))
      .filter(Boolean);
    if (!lines.length) return null;

    const titleNode = row.querySelector("span[title], div[title]");
    const rawTitle = cleanText(titleNode?.getAttribute("title") || titleNode?.textContent || "");
    const splitTitle = splitTrailingTime(rawTitle);
    const title = splitTitle.text || singleLineMeta?.title || inferSidebarTitle(lines) || rawTitle;
    if (isSidebarGenericTitle(title)) return null;
    if (isTypingValue(title)) return null;

    const timeCandidate = lines.find((line) => /^(\d{1,2}:\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4})$/.test(line)) || splitTitle.time || singleLineMeta?.time || "";
    const unreadNode = row.querySelector("[aria-label*='unread' i], [data-testid*='icon-unread'], [data-testid*='alert']");
    const unreadText = cleanText(unreadNode?.getAttribute("aria-label") || unreadNode?.textContent || "");
    const cleanedLines = lines
      .map((line) => splitTrailingTime(stripUnreadNoise(line)).text)
      .filter((line) => line && line !== title && line !== unreadText && line !== timeCandidate && !isTypingValue(line));

    const snippetCandidate = singleLineMeta?.body || cleanedLines[cleanedLines.length - 1] || "";
    const meta = inferMessageMetaFromText(snippetCandidate || allText);
    const rowPhone = extractSidebarPhone(title, allText);

    const fallbackBody = stripUnreadNoise(
      cleanedLines.find((line) => line !== title && !isTypingValue(line)) || ""
    );
    const body = stripUnreadNoise(meta.body || snippetCandidate || fallbackBody || "");
    if (isWeakSidebarBody(body, title, timeCandidate)) return null;
    if (isMostlyNumeric(title) && !timeCandidate && isMostlyNumeric(body) && body.length <= 2) return null;

    const uid = buildStringHash("sidebar", [title, body, timeCandidate, unreadText]);
    if (!uid || seen.has(uid)) return null;

    const isGroup = /,/.test(title) || /group|קבוצה/i.test(allText);
    const resolvedPhone = rowPhone || null;
    const record = {
      event_type: "message",
      source: "whatsapp_web_extension_sidebar",
      uid,
      chat_title: title,
      target_name: title,
      target_phone: isGroup ? null : resolvedPhone,
      target_key: isGroup
        ? buildParticipantKey("target", [title, "group"])
        : (resolvedPhone || buildParticipantKey("target", [title, "direct"])),
      target_type: isGroup ? "group" : "direct",
      sender: isGroup ? (singleLineMeta?.sender || meta.sender || null) : title,
      sender_phone: resolvedPhone,
      sender_key: isGroup
        ? buildParticipantKey("sender", [singleLineMeta?.sender || meta.sender || title, title, "group"])
        : (resolvedPhone || buildParticipantKey("sender", [title, "direct"])),
      sent_at_text: timeCandidate,
      direction: "incoming",
      text: body,
      ack: null,
      reply_to: null,
      media: [],
      reactions: [],
      page_url: location.href,
      captured_at: new Date().toISOString()
    };

    return record;
  }

  function scanSidebar() {
    const grouped = new Map();
    collectSidebarRows().forEach((row) => {
      const msg = extractSidebarRowMessage(row);
      if (!msg) return;

      const groupKey = buildStringHash("sidebar-group", [msg.chat_title, msg.sent_at_text]);
      const current = grouped.get(groupKey);
      if (!current) {
        grouped.set(groupKey, msg);
        return;
      }

      const bodyScore = (candidate) => {
        let score = 0;
        if (!isWeakSidebarBody(candidate.text, candidate.chat_title, candidate.sent_at_text)) score += 5;
        if (hasLetters(candidate.chat_title)) score += 2;
        if (!isMostlyNumeric(candidate.chat_title)) score += 1;
        if (candidate.target_phone || candidate.sender_phone) score += 1;
        return score;
      };
      const currentScore = bodyScore(current);
      const nextScore = bodyScore(msg);
      if (nextScore > currentScore) {
        grouped.set(groupKey, msg);
      }
    });

    grouped.forEach((msg) => {
      if (!seen.has(msg.uid)) {
        seen.add(msg.uid);
        sendToBackground(msg);
      }
    });
  }

  function emitCaptureDebug() {
    try {
      const sidebarRows = collectSidebarRows();
      const sidebarSamples = sidebarRows.slice(0, 5).map((row) => cleanText(row.innerText || row.textContent || "")).filter(Boolean);
      const chatRoots = getChatRoots();
      const mainCandidates = chatRoots.reduce((total, root) => {
        return total + root.querySelectorAll("[data-id], [data-pre-plain-text], .copyable-text, [data-testid*='msg'], [role='row']").length;
      }, 0);

      sendToBackground({
        event_type: "capture_debug",
        source: "whatsapp_web_extension_debug",
        text: `sidebar_rows=${sidebarRows.length} main_candidates=${mainCandidates}`,
        payload: {
          sidebar_rows: sidebarRows.length,
          main_candidates: mainCandidates,
          sidebar_samples: sidebarSamples,
          sidebar_root_found: !!getSidebarRoot(),
          chat_roots_found: chatRoots.length
        },
        captured_at: new Date().toISOString()
      });
    } catch {}
  }

  function sendToBackground(payload) {
    chrome.runtime.sendMessage({ type: "WA_EVENT", payload });
  }

  function findMessageBox() {
    const boxes = [...document.querySelectorAll("div[contenteditable='true'][role='textbox']")];
    return boxes[boxes.length - 1] || null;
  }

  function hasActiveOverlay() {
    const active = document.activeElement;
    if (!active) return false;
    const activeText = cleanText([
      active.getAttribute?.("title"),
      active.getAttribute?.("aria-label"),
      active.getAttribute?.("placeholder"),
      active.getAttribute?.("data-testid"),
      active.textContent
    ].join(" ")).toLowerCase();
    return activeText.includes("search") || activeText.includes("חיפוש") || activeText.includes("find");
  }

  function detectOpenChatError() {
    const text = cleanText(document.body?.innerText || "").toLowerCase();
    const patterns = [
      "phone number shared via url is invalid",
      "this phone number isn't on whatsapp",
      "this phone number is not on whatsapp",
      "couldn't find that chat",
      "לא נמצא צ׳אט",
      "לא נמצא צ'אט",
      "המספר הזה לא נמצא ב-whatsapp",
      "מספר הטלפון ששותף דרך כתובת ה-url אינו חוקי",
      "number shared via url is invalid"
    ];

    const matched = patterns.find((pattern) => text.includes(pattern));
    if (matched) return matched;
    return "";
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findSearchBox() {
    const candidates = [
      ...document.querySelectorAll("div[contenteditable='true'][role='textbox']"),
      ...document.querySelectorAll("div[contenteditable='true']"),
      ...document.querySelectorAll("input[type='text']"),
      ...document.querySelectorAll("input"),
      ...document.querySelectorAll("textarea")
    ];
    if (!candidates.length) return null;

    const sidebar = document.querySelector("#side");
    const isSearchCandidate = (node) => {
      if (!node || node.closest("footer")) return false;

      const text = cleanText([
        node.getAttribute("title"),
        node.getAttribute("aria-label"),
        node.getAttribute("placeholder"),
        node.getAttribute("type"),
        node.getAttribute("data-testid"),
        node.getAttribute("data-lexical-editor"),
        node.textContent
      ].join(" "));
      const lower = text.toLowerCase();

      if (lower.includes("search") || lower.includes("חיפוש") || lower.includes("find")) return true;
      if (sidebar && sidebar.contains(node)) return true;
      return false;
    };

    const preferred = candidates.find((node) => {
      if (!isSearchCandidate(node)) return false;
      if (sidebar && !sidebar.contains(node)) return false;
      return true;
    });
    if (preferred) return preferred;

    return candidates.find(isSearchCandidate) || null;
  }

  function findSearchTrigger() {
    const nodes = [
      ...document.querySelectorAll("[role='button']"),
      ...document.querySelectorAll("button"),
      ...document.querySelectorAll("[aria-label]"),
      ...document.querySelectorAll("[title]")
    ];

    return nodes.find((node) => {
      if (node.closest("footer")) return false;
      const text = cleanText([
        node.innerText,
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        node.getAttribute("data-testid")
      ].join(" ")).toLowerCase();
      return text.includes("search") || text.includes("חיפוש") || text.includes("find chat");
    }) || null;
  }

  function findArchiveEntry() {
    const nodes = [
      ...document.querySelectorAll("[role='button']"),
      ...document.querySelectorAll("[role='gridcell']"),
      ...document.querySelectorAll("[role='listitem']"),
      ...document.querySelectorAll("[title]"),
      ...document.querySelectorAll("[aria-label]")
    ];

    return nodes.find((node) => {
      const text = cleanText(`${node.innerText || ""} ${node.getAttribute("title") || ""} ${node.getAttribute("aria-label") || ""}`).toLowerCase();
      return text.includes("archived") || text.includes("archive") || text.includes("ארכיון");
    }) || null;
  }

  async function typeIntoEditable(node, value) {
    node.focus();
    if (typeof node.select === "function") {
      node.select();
    } else {
      document.execCommand("selectAll", false, null);
    }

    if ("value" in node) {
      node.value = "";
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      document.execCommand("delete", false, null);
      node.textContent = "";
      const eventOptions = { bubbles: true };
      node.dispatchEvent(new InputEvent("beforeinput", { data: value, inputType: "insertText", ...eventOptions }));
      document.execCommand("insertText", false, value);
      node.dispatchEvent(new Event("input", eventOptions));
    }
    await wait(500);
  }

  function collectChatCandidates() {
    return [
      ...document.querySelectorAll("[role='gridcell']"),
      ...document.querySelectorAll("[role='listitem']"),
      ...document.querySelectorAll("div[data-testid*='cell-frame']"),
      ...document.querySelectorAll("div[data-testid*='chat-list-item']"),
      ...document.querySelectorAll("div[data-testid*='cell-frame-container']")
    ];
  }

  function findChatRowByName(chatName) {
    const normalizedChatName = cleanText(chatName).toLowerCase();
    const candidates = collectChatCandidates();
    const exact = candidates.find((node) => {
      const text = cleanText(node.innerText).toLowerCase();
      return text === normalizedChatName || text.split("\n")[0] === normalizedChatName;
    });
    if (exact) return exact;
    const partial = candidates.find((node) => cleanText(node.innerText).toLowerCase().includes(normalizedChatName));
    if (partial) return partial;

    const titleNode = [...document.querySelectorAll("span[title], div[title]")].find((node) => {
      return cleanText(node.getAttribute("title") || node.textContent).toLowerCase().includes(normalizedChatName);
    });
    return titleNode?.closest("[role='gridcell'], [role='listitem'], div[data-testid*='cell-frame'], div[data-testid*='chat-list-item']") || null;
  }

  function clickNode(node) {
    if (!node) return false;
    const target = node.closest("[role='gridcell'], [role='listitem'], button, a, div[data-testid*='cell-frame'], div[data-testid*='chat-list-item']") || node;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }

  async function openArchiveView() {
    const archiveEntry = findArchiveEntry();
    if (!archiveEntry) throw new Error("Archive entry not found");
    archiveEntry.click();
    await wait(1200);
    return { ok: true };
  }

  async function openChatByNameFlow(chatName, includeArchived = false) {
    const normalizedChatName = cleanText(chatName || "");
    if (!normalizedChatName) throw new Error("Missing chat name");

    if (includeArchived) {
      await openArchiveView();
    }

    let searchBox = findSearchBox();
    if (!searchBox) {
      const trigger = findSearchTrigger();
      if (trigger) {
        clickNode(trigger);
        await wait(700);
        searchBox = findSearchBox();
      }
    }
    if (!searchBox) throw new Error("Search box not found");

    await typeIntoEditable(searchBox, normalizedChatName);

    const startedAt = Date.now();
    let row = findChatRowByName(normalizedChatName);
    while (!row && Date.now() - startedAt < 10000) {
      await wait(250);
      row = findChatRowByName(normalizedChatName);
    }
    if (!row) throw new Error(`Chat not found: ${normalizedChatName}`);

    clickNode(row);
    await wait(1200);
    const openedTitle = cleanText(getCurrentChatTitle());
    const hasMessageBox = !!findMessageBox();
    if (!openedTitle && !hasMessageBox) {
      throw new Error(`Chat not found: ${normalizedChatName}`);
    }
    return {
      ok: true,
      chat_title: openedTitle,
      searched: normalizedChatName,
      archived: includeArchived,
      matched_row_text: cleanText(row.innerText)
    };
  }

  async function captureRecentMessages(iterations = 5, waitMs = 400) {
    for (let index = 0; index < iterations; index += 1) {
      getChatRoots().forEach((root) => scan(root));
      await wait(waitMs);
    }
    return { ok: true };
  }

  async function captureOutgoingMessageByText(text, timeoutMs = 5000) {
    const expectedText = cleanText(text);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const nodes = [
        ...document.querySelectorAll(".message-out[data-id]"),
        ...document.querySelectorAll(".message-out [data-id]"),
        ...document.querySelectorAll(".message-out [data-pre-plain-text]"),
        ...document.querySelectorAll("#main [data-pre-plain-text]"),
        ...document.querySelectorAll("#main .copyable-text")
      ];

      for (const node of nodes.reverse()) {
        const message = extractMessage(node);
        if (!message) continue;
        if (!expectedText || cleanText(message.text).includes(expectedText)) {
          sendToBackground(message);
          return { ok: true, uid: message.uid };
        }
      }

      getChatRoots().forEach((root) => scan(root));
      await wait(350);
    }

    return { ok: false, error: "Outgoing message not captured yet" };
  }

  async function validateCurrentChat(expected = {}) {
    const explicitError = detectOpenChatError();
    if (explicitError) {
      throw new Error(expected.phone
        ? `Phone not found on WhatsApp: ${expected.phone}`
        : `Chat not found: ${expected.chatName || "unknown"}`);
    }

    const messageBox = findMessageBox();
    if (!messageBox) {
      if (expected.phone) throw new Error(`Phone not found on WhatsApp: ${expected.phone}`);
      throw new Error(`Chat not found: ${expected.chatName || "unknown"}`);
    }

    const currentTitle = cleanText(getCurrentChatTitle());
    if (expected.chatName && !currentTitle && !messageBox) {
      throw new Error(`Chat not found: ${expected.chatName}`);
    }

    return { ok: true, chat_title: currentTitle };
  }

  async function prepareCurrentChatForSend() {
    if (hasActiveOverlay()) {
      document.activeElement?.blur?.();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      await wait(250);
    }

    const startedAt = Date.now();
    let box = findMessageBox();
    while (!box && Date.now() - startedAt < 8000) {
      await wait(250);
      box = findMessageBox();
    }
    if (!box) throw new Error("Message box not found");

    box.focus();
    box.click();
    await wait(200);
    return { ok: true };
  }

  async function sendTextInCurrentChat(text, send = true) {
    const prepared = await prepareCurrentChatForSend();
    if (!prepared?.ok) throw new Error("Message box not found");

    const box = findMessageBox();
    if (!box) throw new Error("Message box not found");

    const value = String(text || "");
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    box.textContent = "";

    if ("value" in box) {
      box.value = value;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      document.execCommand("insertText", false, value);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }

    await wait(250);

    if (send !== false) {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true }));
      box.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true }));
      box.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true }));
      await wait(250);
      await captureOutgoingMessageByText(value, 6000);
    }

    return { ok: true };
  }

  async function tryUnarchiveCurrentChat() {
    const buttons = [
      ...document.querySelectorAll("[aria-label]"),
      ...document.querySelectorAll("[title]"),
      ...document.querySelectorAll("[role='button']")
    ];

    const directButton = buttons.find((node) => {
      const text = cleanText(`${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""} ${node.innerText || ""}`).toLowerCase();
      return text.includes("unarchive") || text.includes("הוצא מהארכיון") || text.includes("בטל ארכוב");
    });

    if (directButton) {
      directButton.click();
      await wait(500);
      return { ok: true, method: "direct_button" };
    }

    const menuButton = buttons.find((node) => {
      const text = cleanText(`${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`);
      return text.includes("Menu") || text.includes("תפריט");
    });

    if (menuButton) {
      menuButton.click();
      await wait(400);
      const menuItem = [...document.querySelectorAll("[role='button'], [role='menuitem'], [aria-label], [title]")].find((node) => {
        const text = cleanText(`${node.innerText || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`).toLowerCase();
        return text.includes("unarchive") || text.includes("הוצא מהארכיון") || text.includes("בטל ארכוב");
      });
      if (menuItem) {
        menuItem.click();
        await wait(500);
        return { ok: true, method: "menu_item" };
      }
    }

    return { ok: false, error: "Unarchive action not found" };
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

      if (message.command?.action === "open_chat_by_name") {
        openChatByNameFlow(message.command.chatName || "", message.command.includeArchived === true)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
        return true;
      }

      if (message.command?.action === "capture_recent_messages") {
        captureRecentMessages(Number(message.command.iterations) || 5, Number(message.command.waitMs) || 400)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
        return true;
      }

      if (message.command?.action === "validate_current_chat") {
        validateCurrentChat(message.command.expected || {})
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
        return true;
      }

      if (message.command?.action === "prepare_current_chat_for_send") {
        prepareCurrentChatForSend()
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
        return true;
      }

      if (message.command?.action === "send_text_in_current_chat") {
        sendTextInCurrentChat(message.command.text || "", message.command.send !== false)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
        return true;
      }

      if (message.command?.action === "unarchive_current_chat") {
        tryUnarchiveCurrentChat()
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
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
    getChatRoots().forEach((root) => scan(root));
    scanSidebar();
    emitCaptureDebug();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && isInConversationPanel(node)) scan(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    periodicScanHandle = window.setInterval(() => {
      getChatRoots().forEach((root) => scan(root));
      scanSidebar();
    }, 2000);
    window.setTimeout(emitCaptureDebug, 3000);
    window.setTimeout(emitCaptureDebug, 8000);
    sendToBackground({ event_type: "extension_started", source: "whatsapp_web_extension", page_url: location.href, captured_at: new Date().toISOString() });
  };

  if (document.body) start();
  else window.addEventListener("DOMContentLoaded", start, { once: true });
})();
