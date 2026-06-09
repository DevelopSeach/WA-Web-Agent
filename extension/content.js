(() => {
  if (window.__waAgentContentInstalled) return;
  window.__waAgentContentInstalled = true;

  const seen = new Map();
  const signatureOwners = new Map();
  const resolvingIdentity = new Set();
  let periodicScanHandle = null;
  let periodicDomDebugHandle = null;

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

    if (data.event_type === "store_message" && data.payload) {
      const payload = {
        ...data.payload,
        event_type: "message",
        source: data.payload.source || "whatsapp_web_extension_store",
        captured_at: data.payload.captured_at || new Date().toISOString()
      };
      if (shouldEmitRecord(payload)) sendToBackground(payload);
      return;
    }

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

  function collectRoots(root = document) {
    const roots = [];
    const queue = [root];
    const visited = new Set();

    while (queue.length) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      roots.push(current);

      let elements = [];
      if (current.querySelectorAll) {
        elements = [...current.querySelectorAll("*")];
      } else if (current.children) {
        elements = [...current.children];
      }

      elements.forEach((element) => {
        if (element?.shadowRoot) queue.push(element.shadowRoot);
      });
    }

    return roots;
  }

  function deepQueryAll(selectors, root = document) {
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];
    const results = [];
    const seenNodes = new Set();

    collectRoots(root).forEach((currentRoot) => {
      selectorList.forEach((selector) => {
        if (!selector || !currentRoot.querySelectorAll) return;
        currentRoot.querySelectorAll(selector).forEach((node) => {
          if (seenNodes.has(node)) return;
          seenNodes.add(node);
          results.push(node);
        });
      });
    });

    return results;
  }

  function stableJson(value) {
    try {
      return JSON.stringify(value || null);
    } catch {
      return "";
    }
  }

  function buildMessageSubtype(record) {
    const hasReply = !!cleanText(record?.reply_to?.text || record?.reply_to?.snippet || "");
    const hasReactions = Array.isArray(record?.reactions) && record.reactions.length > 0;
    if (hasReply && hasReactions) return "reply+reaction";
    if (hasReactions) return "reaction";
    if (hasReply) return "reply";
    return "plain";
  }

  function buildRecordSignature(record) {
    return stableJson({
      event_type: record?.event_type || "",
      message_subtype: record?.message_subtype || "",
      source: record?.source || "",
      chat_title: record?.chat_title || "",
      target_name: record?.target_name || "",
      target_phone: record?.target_phone || "",
      target_key: record?.target_key || "",
      target_type: record?.target_type || "",
      sender: record?.sender || "",
      sender_phone: record?.sender_phone || "",
      sender_key: record?.sender_key || "",
      sender_resolved_name: record?.sender_resolved_name || "",
      target_resolved_name: record?.target_resolved_name || "",
      sent_at_text: record?.sent_at_text || "",
      direction: record?.direction || "",
      text: record?.text || "",
      ack: record?.ack || null,
      reply_to: record?.reply_to || null,
      reactions: record?.reactions || [],
      media: Array.isArray(record?.media) ? record.media.map((item) => ({
        kind: item?.kind || "",
        src: item?.src || item?.href || "",
        text: item?.text || ""
      })) : []
    });
  }

  function shouldEmitRecord(record) {
    const uid = cleanText(record?.uid);
    if (!uid) return false;
    const signature = buildRecordSignature(record);
    const existingOwner = signatureOwners.get(signature);
    const isSynthetic = uid.startsWith("synthetic-");
    const ownerIsSynthetic = existingOwner ? existingOwner.startsWith("synthetic-") : false;

    if (existingOwner && existingOwner !== uid) {
      if (isSynthetic && !ownerIsSynthetic) return false;
      if (!isSynthetic && ownerIsSynthetic) {
        seen.delete(existingOwner);
      } else if (!isSynthetic && !ownerIsSynthetic) {
        return false;
      }
    }
    if (seen.get(uid) === signature) return false;
    seen.set(uid, signature);
    signatureOwners.set(signature, uid);
    return true;
  }

  function getCurrentChatTitle() {
    const composeTarget = extractComposeTargetName();
    if (composeTarget) return composeTarget;
    const header = deepQueryAll("header")[0];
    if (!header) return "";
    const titledNodes = [...header.querySelectorAll("span[title], [title], [aria-label]")];
    const preferred = titledNodes
      .map((node) => cleanText(node.getAttribute("title") || node.getAttribute("aria-label") || node.textContent || ""))
      .find((value) => value && !isGenericTargetName(value));
    if (preferred) return preferred;
    const fallback = cleanText(header.innerText);
    return isGenericTargetName(fallback) ? "" : fallback;
  }

  function getHeaderText() {
    const header = deepQueryAll("header")[0];
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

    const header = deepQueryAll("header")[0];
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
    const exact = [
      "tools",
      "chats",
      "channels",
      "channel",
      "updates in status",
      "status",
      "search",
      "חיפוש",
      "עדכונים",
      "סטטוס"
    ];
    if (exact.includes(text)) return true;
    return (
      text.includes("updates in status") ||
      text.includes("whatsapp business") ||
      text.includes("tools") ||
      text.includes("communities") ||
      text.includes("archived") ||
      text.includes("favorites") ||
      text.includes("groups") ||
      text.includes("all unread")
    );
  }

  function hasConversationLikeMessages(root) {
    if (!root) return false;
    return deepQueryAll("[data-pre-plain-text], .message-in, .message-out, [data-testid*='msg-container']", root).length > 0;
  }

  function isOpenConversationContext() {
    const currentChatTitle = getCurrentChatTitle();
    const headerText = getHeaderText();
    const messageBox = findMessageBox();
    const roots = getChatRoots();
    const hasConversationMessages = roots.some((root) => hasConversationLikeMessages(root));

    if (!messageBox) return false;
    if (!currentChatTitle && isGenericTargetName(headerText)) return false;
    if (isGenericTargetName(currentChatTitle || headerText)) return false;
    return hasConversationMessages;
  }

  function extractTargetName() {
    const composeTarget = extractComposeTargetName();
    if (composeTarget) return composeTarget;
    const header = deepQueryAll("header")[0];
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

  function extractComposeTargetName() {
    const box = findMessageBox();
    if (!box) return "";
    const samples = [
      box.getAttribute("aria-label"),
      box.getAttribute("title"),
      box.getAttribute("placeholder")
    ]
      .map((value) => cleanText(value))
      .filter(Boolean);

    const patterns = [
      /type a message to\s+(.+)$/i,
      /send a message to\s+(.+)$/i,
      /message\s+(.+)$/i,
      /כתוב הודעה אל\s+(.+)$/i,
      /הקלד הודעה אל\s+(.+)$/i
    ];

    for (const sample of samples) {
      for (const pattern of patterns) {
        const match = sample.match(pattern);
        if (!match?.[1]) continue;
        const value = cleanText(match[1]);
        if (value && !isGenericTargetName(value)) return value;
      }
    }

    return "";
  }

  function isSavedContactName(value) {
    const text = cleanText(value);
    if (!text) return false;
    const lower = text.toLowerCase();
    if ([
      "whatsapp business on web",
      "business account",
      "contact info",
      "group info",
      "communities",
      "channels"
    ].includes(lower)) return false;
    return !normalizePhoneCandidate(text) && !isGenericTargetName(text) && hasLetters(text);
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
    const candidates = [
      ...deepQueryAll("#main"),
      ...deepQueryAll("main"),
      ...deepQueryAll("[data-testid='conversation-panel-body']"),
      ...deepQueryAll("[data-testid='conversation-panel-messages']"),
      ...deepQueryAll("[data-testid*='conversation-panel']"),
      ...deepQueryAll("[data-testid*='conversation']"),
      ...deepQueryAll("[aria-label*='Message list' i]"),
      document.body
    ].filter(Boolean);

    const unique = new Map();
    candidates.forEach((node) => {
      const key = node === document.body
        ? "body"
        : node.id || node.getAttribute?.("data-testid") || node.tagName;
      if (!unique.has(key)) unique.set(key, node);
    });

    return [...unique.values()];
  }

  function isInSidebar(node) {
    if (!node || !node.closest) return false;
    const sidebar = getSidebarRoot();
    return !!(sidebar && sidebar.contains(node));
  }

  function isInConversationPanel(node) {
    if (!node || !node.closest) return false;
    if (isInSidebar(node)) return false;

    if (node.closest("#main")) return true;
    if (node.closest("main")) return true;
    if (node.closest("[data-testid='conversation-panel-body']")) return true;
    if (node.closest("[data-testid='conversation-panel-messages']")) return true;
    if (node.closest("[data-testid*='conversation-panel']")) return true;
    if (node.closest("[data-testid*='conversation']")) return true;
    if (node.closest("[aria-label*='Message list' i]")) return true;

    if (node.matches?.("[data-id], [data-pre-plain-text], .copyable-text, [data-testid*='msg']")) {
      return !node.closest("#pane-side, #side, [data-testid='chat-list'], [role='listitem'], [role='row']");
    }

    return false;
  }

  function getSidebarRoot() {
    return deepQueryAll("#pane-side")[0]
      || deepQueryAll("#side")[0]
      || deepQueryAll("[data-testid='chat-list']")[0]
      || deepQueryAll("[aria-label*='Chat list' i]")[0];
  }

  function isSidebarGenericTitle(value) {
    const text = cleanText(value).toLowerCase();
    return [
      "",
      "chats",
      "channels",
      "channel",
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

  function isNoisySystemText(value) {
    const text = cleanText(value).toLowerCase();
    if (!text) return true;
    if ([
      "online",
      "unread",
      "photo",
      "video",
      "business account",
      "typing…",
      "typing...",
      "מקליד…",
      "מקליד...",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
      "שי, you"
    ].includes(text)) return true;

    return [
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

  function findMessageElement(el) {
    if (!el || !el.closest) return null;
    return el.closest(".message-in, .message-out")
      || el.closest("[data-testid*='msg-container']")
      || el.closest("[data-id]")
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

  function stripReplyPrefix(rawText, replyTo) {
    const text = cleanText(rawText);
    if (!text || !replyTo) return text;

    const candidates = [
      cleanText(replyTo.text),
      cleanText(replyTo.snippet),
      cleanText([replyTo.sender, replyTo.snippet].filter(Boolean).join(" "))
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (text === candidate) return text;
      if (text.startsWith(`${candidate} `)) {
        return cleanText(text.slice(candidate.length));
      }
    }

    return text;
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
    const descendantId = messageEl.querySelector?.("[data-id]")?.getAttribute?.("data-id") || "";
    const uid = messageEl.getAttribute("data-id") || descendantId || buildSyntheticUid(messageEl, prePlainText, rawText, inferredDirection);
    if (!uid) return null;
    if (!rawText && !prePlainText && !messageEl.querySelector("img, video, audio, a[href], [data-icon]")) return null;
    if (isNoisySystemText(rawText)) return null;

    const targetType = detectTargetType();
    const senderPhone = extractSenderPhone(messageEl, parsed.sender, prePlainText);
    const extractedTargetName = extractTargetName();
    const extractedTargetPhone = extractTargetPhone();
    const currentChatTitle = getCurrentChatTitle();
    if (isGenericTargetName(currentChatTitle)) return null;
    const fallbackName = parsed.sender || inferredMeta.sender || "";
    const effectiveChatTitle = isGenericTargetName(currentChatTitle) ? fallbackName : currentChatTitle;
    const effectiveTargetName = targetType === "direct"
      ? (extractedTargetName || fallbackName)
      : (extractedTargetName || effectiveChatTitle || currentChatTitle);
    if (isGenericTargetName(currentChatTitle) && !fallbackName && !extractedTargetName) return null;

    const replyTo = extractReplyContext(messageEl);
    const bodyText = stripReplyPrefix(inferredMeta.body || rawText, replyTo);

    const record = {
      event_type: "message",
      source: "whatsapp_web_extension_dom",
      uid,
      chat_title: effectiveChatTitle || currentChatTitle,
      target_name: targetType === "direct"
        ? (effectiveTargetName || (inferredDirection === "incoming" ? fallbackName : ""))
        : (effectiveTargetName || effectiveChatTitle || currentChatTitle),
      target_phone: targetType === "direct"
        ? (extractedTargetPhone || (inferredDirection === "incoming" ? senderPhone : null))
        : extractedTargetPhone,
      target_key: targetType === "direct"
        ? (extractedTargetPhone || buildParticipantKey("target", [effectiveTargetName || effectiveChatTitle || currentChatTitle, targetType]))
        : buildParticipantKey("target", [effectiveTargetName || effectiveChatTitle || currentChatTitle, targetType]),
      target_type: targetType,
      sender: parsed.sender || inferredMeta.sender || null,
      sender_phone: senderPhone,
      sender_key: senderPhone || buildParticipantKey("sender", [fallbackName || effectiveChatTitle || currentChatTitle, targetType]),
      sent_at_text: parsed.sent_at_text || inferredMeta.sent_at_text,
      direction: inferredDirection,
      text: bodyText,
      ack: extractAck(messageEl),
      reply_to: replyTo,
      media: extractMedia(messageEl),
      reactions: extractReactions(messageEl),
      message_subtype: "",
      page_url: location.href,
      captured_at: new Date().toISOString()
    };

    record.message_subtype = buildMessageSubtype(record);

    return record;
  }

  function scan(root) {
    if (root !== document.body && !isInConversationPanel(root)) return;
    const nodes = [];
    const scanSelectors = "[data-id], [data-pre-plain-text], .copyable-text, [data-testid*='msg'], [data-testid*='msg-container'], .message-in, .message-out";
    if (root?.matches?.(scanSelectors)) nodes.push(root);
    deepQueryAll(scanSelectors, root).forEach((n) => nodes.push(n));
    nodes.forEach((node) => {
      const msg = extractMessage(node);
      if (msg && shouldEmitRecord(msg)) sendToBackground(msg);
    });
  }

  function collectSidebarRows() {
    const side = getSidebarRoot();
    if (!side) return [];
    const rawNodes = [
      ...side.querySelectorAll("[role='listitem']"),
      ...side.querySelectorAll("[role='row']"),
      ...side.querySelectorAll("div[data-testid*='cell-frame']"),
      ...side.querySelectorAll("div[data-testid*='chat-list-item']"),
      ...side.querySelectorAll("div[data-testid*='cell-frame-container']"),
      ...side.querySelectorAll("[aria-selected]")
    ];

    const unique = new Map();
    rawNodes.forEach((node) => {
      const container = node.closest?.("[role='listitem'], [role='row'], div[data-testid*='cell-frame-container'], div[data-testid*='chat-list-item'], div[data-testid*='cell-frame']")
        || node;
      if (!side.contains(container)) return;
      const key = container.getAttribute?.("data-id")
        || container.getAttribute?.("data-testid")
        || `${container.tagName}:${cleanText(container.innerText || "").slice(0, 120)}`;
      if (!unique.has(key)) unique.set(key, container);
    });

    return [...unique.values()];
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

    const unreadGroupDate = text.match(/^\d+\s+unread\s+messages?\s+(.+?)\s+(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})\s+(.+?)\s*:\s*(.+?)\s+\d+$/i);
    if (unreadGroupDate) {
      return {
        title: cleanText(unreadGroupDate[1]),
        time: cleanText(unreadGroupDate[2]),
        sender: cleanText(unreadGroupDate[3]),
        body: cleanText(unreadGroupDate[4])
      };
    }

    const unreadDirectDate = text.match(/^\d+\s+unread\s+messages?\s+(.+?)\s+(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})\s+(.+?)\s+\d+$/i);
    if (unreadDirectDate) {
      return {
        title: cleanText(unreadDirectDate[1]),
        time: cleanText(unreadDirectDate[2]),
        body: cleanText(unreadDirectDate[3])
      };
    }

    const unreadGroup = text.match(/^\d+\s+unread\s+messages?\s+(.+?)\s+(\d{1,2}:\d{2})\s+(.+?)\s*:\s*(.+?)\s+\d+$/i);
    if (unreadGroup) {
      return {
        title: cleanText(unreadGroup[1]),
        time: cleanText(unreadGroup[2]),
        sender: cleanText(unreadGroup[3]),
        body: cleanText(unreadGroup[4])
      };
    }

    const unreadDirect = text.match(/^\d+\s+unread\s+messages?\s+(.+?)\s+(\d{1,2}:\d{2})\s+(.+?)\s+\d+$/i);
    if (unreadDirect) {
      return {
        title: cleanText(unreadDirect[1]),
        time: cleanText(unreadDirect[2]),
        body: cleanText(unreadDirect[3])
      };
    }

    const groupDate = text.match(/^(.+?)\s+(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})\s+(.+?)\s*:\s*(.+)$/);
    if (groupDate) {
      return {
        title: cleanText(groupDate[1]),
        time: cleanText(groupDate[2]),
        sender: cleanText(groupDate[3]),
        body: cleanText(groupDate[4])
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

    const directDate = text.match(/^(.+?)\s+(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})\s+(.+)$/);
    if (directDate) {
      return {
        title: cleanText(directDate[1]),
        time: cleanText(directDate[2]),
        body: cleanText(directDate[3])
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
    if (isNoisySystemText(title)) return null;

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
    if (!timeCandidate && body.length <= 2 && isMostlyNumeric(body) && !isMostlyNumeric(title) && hasLetters(title)) return null;
    if (isNoisySystemText(body)) return null;
    if (singleLineMeta?.sender && isNoisySystemText(singleLineMeta.sender)) return null;
    if (!rawTitle && !singleLineMeta?.time && !timeCandidate) return null;
    if (!isSavedContactName(title) && !normalizePhoneCandidate(title) && body.startsWith("\"")) return null;
    if (cleanText(title) === cleanText(body)) return null;

    const isGroup = /,/.test(title) || /group|קבוצה/i.test(allText);
    const senderCandidate = singleLineMeta?.sender || meta.sender || null;
    if (isGroup) {
      const lowerBody = cleanText(body).toLowerCase();
      if (!senderCandidate && /:\s*$/.test(body)) return null;
      if (!senderCandidate && /\bis\s…?$/.test(lowerBody)) return null;
      if (senderCandidate && cleanText(body) === `${cleanText(senderCandidate)} :`) return null;
      if (senderCandidate && cleanText(body) === `${cleanText(senderCandidate)} is …`) return null;
    }

    const uid = buildStringHash("sidebar", [title, body, timeCandidate, unreadText]);
    if (!uid) return null;

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
      sender: isGroup ? senderCandidate : title,
      sender_phone: resolvedPhone,
      sender_key: isGroup
        ? buildParticipantKey("sender", [senderCandidate || title, title, "group"])
        : (resolvedPhone || buildParticipantKey("sender", [title, "direct"])),
      sent_at_text: timeCandidate,
      direction: "incoming",
      text: body,
      ack: null,
      reply_to: null,
      media: [],
      reactions: [],
      message_subtype: "plain",
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

      const groupKey = buildStringHash("sidebar-group", [
        msg.chat_title,
        msg.sent_at_text,
        msg.sender || "",
        msg.text || ""
      ]);
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
        if (candidate.target_type === "group" && candidate.sender) score += 4;
        if (candidate.target_type === "group" && candidate.text && !candidate.text.endsWith(":")) score += 2;
        if (candidate.text && /\bis\s…?$/.test(candidate.text.toLowerCase())) score -= 5;
        if (candidate.text && /:\s*$/.test(candidate.text)) score -= 5;
        return score;
      };
      const currentScore = bodyScore(current);
      const nextScore = bodyScore(msg);
      if (nextScore > currentScore) {
        grouped.set(groupKey, msg);
      }
    });

    grouped.forEach((msg) => {
      if (shouldEmitRecord(msg)) {
        sendToBackground(msg);
        const shouldResolveIdentity = msg.target_type === "direct"
          && (
            normalizePhoneCandidate(msg.sender || msg.chat_title)
            || (isSavedContactName(msg.sender || msg.chat_title) && !normalizePhoneCandidate(msg.sender_phone))
          );
        if (shouldResolveIdentity) {
          const matchedRow = collectSidebarRows().find((row) => cleanText(row.innerText || row.textContent || "").includes(cleanText(msg.chat_title || msg.sender || "")));
          if (matchedRow) resolveSidebarMessageIdentity(matchedRow, msg);
        }
      }
    });
  }

  function emitCaptureDebug() {
    try {
      const sidebarRows = collectSidebarRows();
      const sidebarSamples = sidebarRows.slice(0, 5).map((row) => cleanText(row.innerText || row.textContent || "")).filter(Boolean);
      const chatRoots = getChatRoots();
      const mainCandidates = chatRoots.reduce((total, root) => {
        return total + deepQueryAll("[data-id], [data-pre-plain-text], .copyable-text, [data-testid*='msg'], [data-testid*='msg-container'], .message-in, .message-out, [role='row']", root).length;
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

  function emitDomDebugSnapshot(reason = "manual") {
    try {
      const chatRoots = getChatRoots();
      const openConversation = isOpenConversationContext();
      const mainTextSample = (openConversation ? chatRoots : [])
        .map((root) => cleanText(root.innerText || root.textContent || ""))
        .filter(Boolean)
        .join("\n---\n")
        .slice(0, 8000);
      const conversationSamples = (openConversation
        ? chatRoots.flatMap((root) => deepQueryAll("[data-id], [data-pre-plain-text], .copyable-text, [data-testid*='msg'], [data-testid*='msg-container'], .message-in, .message-out", root))
        : [])
        .slice(0, 15)
        .map((node) => cleanText(node.innerText || node.textContent || ""))
        .filter(Boolean)
        .slice(0, 8);
      const sidebarSamples = collectSidebarRows()
        .slice(0, 8)
        .map((row) => cleanText(row.innerText || row.textContent || ""))
        .filter(Boolean);
      const activeElement = document.activeElement;

      sendToBackground({
        event_type: "dom_debug",
        source: "whatsapp_web_extension_debug",
        text: `dom_debug reason=${reason} chat_roots=${chatRoots.length} conversation_samples=${conversationSamples.length} sidebar_rows=${sidebarSamples.length}`,
        payload: {
          reason,
          url: location.href,
          title: document.title,
          current_chat_title: getCurrentChatTitle(),
          header_text: getHeaderText(),
          open_chat_detected: openConversation,
          message_box_found: !!findMessageBox(),
          body_text_sample: cleanText(document.body?.innerText || "").slice(0, 12000),
          main_text_sample: mainTextSample,
          chat_roots_found: chatRoots.length,
          sidebar_root_found: !!getSidebarRoot(),
          conversation_samples: conversationSamples,
          sidebar_samples: sidebarSamples,
          active_element: activeElement ? {
            tag: activeElement.tagName,
            title: cleanText(activeElement.getAttribute?.("title") || ""),
            aria_label: cleanText(activeElement.getAttribute?.("aria-label") || ""),
            data_testid: cleanText(activeElement.getAttribute?.("data-testid") || "")
          } : null
        },
        captured_at: new Date().toISOString()
      });
    } catch (error) {
      sendToBackground({
        event_type: "dom_debug_error",
        source: "whatsapp_web_extension_debug",
        text: String(error?.message || error),
        captured_at: new Date().toISOString()
      });
    }
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

  function findHeaderInfoTrigger() {
    const header = deepQueryAll("header")[0];
    if (!header) return null;
    const candidates = [
      ...header.querySelectorAll("[role='button']"),
      ...header.querySelectorAll("[title]"),
      ...header.querySelectorAll("[aria-label]"),
      header
    ];
    return candidates.find((node) => {
      const text = cleanText(`${node.innerText || ""} ${node.getAttribute?.("title") || ""} ${node.getAttribute?.("aria-label") || ""}`).toLowerCase();
      return !text.includes("search") && !text.includes("חיפוש");
    }) || header;
  }

  function findProfilePanel() {
    const panels = [
      ...deepQueryAll("[role='dialog']"),
      ...deepQueryAll("[data-testid*='drawer']"),
      ...deepQueryAll("[data-testid*='panel']"),
      ...deepQueryAll("aside")
    ];

    return panels.find((panel) => {
      const text = cleanText(panel.innerText || "").toLowerCase();
      return text.length > 0 && (
        text.includes("contact info") ||
        text.includes("group info") ||
        text.includes("business account") ||
        text.includes("media, links, and docs") ||
        text.includes("about") ||
        text.includes("mute notifications")
      );
    }) || null;
  }

  function extractResolvedProfile(panel) {
    if (!panel) return { name: "", phone: "" };
    const candidates = [
      ...panel.querySelectorAll("span[title]"),
      ...panel.querySelectorAll("[title]"),
      ...panel.querySelectorAll("[aria-label]"),
      ...panel.querySelectorAll("h1, h2, h3")
    ].map((node) => cleanText(node.getAttribute?.("title") || node.getAttribute?.("aria-label") || node.textContent || "")).filter(Boolean);

    const name = candidates.find((value) => value.startsWith("~") && isSavedContactName(value))
      || candidates.find((value) => isSavedContactName(value))
      || "";
    const phone = candidates.map((value) => normalizePhoneCandidate(value)).find(Boolean) || normalizePhoneCandidate(panel.innerText || "") || "";
    return { name, phone };
  }

  async function closeProfilePanel() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    await wait(250);
  }

  async function resolveCurrentChatProfile() {
    const trigger = findHeaderInfoTrigger();
    if (!trigger) return { ok: false, error: "Header info trigger not found" };
    clickNode(trigger);

    const startedAt = Date.now();
    let panel = findProfilePanel();
    while (!panel && Date.now() - startedAt < 5000) {
      await wait(250);
      panel = findProfilePanel();
    }
    if (!panel) return { ok: false, error: "Profile panel not found" };

    const resolved = extractResolvedProfile(panel);
    await closeProfilePanel();
    if (!resolved.name && !resolved.phone) return { ok: false, error: "Profile identity not found" };
    return { ok: true, ...resolved };
  }

  async function resolveSidebarMessageIdentity(row, msg) {
    const phone = normalizePhoneCandidate(msg.sender_phone || msg.sender || msg.chat_title);
    const currentName = cleanText(msg.sender || msg.chat_title || "");
    if ((!phone && !isSavedContactName(currentName)) || resolvingIdentity.has(msg.uid)) return;

    resolvingIdentity.add(msg.uid);
    try {
      clickNode(row);
      await wait(1200);
      const resolved = await resolveCurrentChatProfile();
      if (!resolved?.ok) return;

      const resolvedName = isSavedContactName(resolved.name) ? resolved.name : currentName;
      const resolvedPhone = normalizePhoneCandidate(resolved.phone || phone) || phone;
      if (!resolvedName && !resolvedPhone) return;

      sendToBackground({
        ...msg,
        chat_title: resolvedName || msg.chat_title,
        target_name: resolvedName || msg.target_name,
        target_phone: resolvedPhone || msg.target_phone || null,
        target_key: resolvedPhone || msg.target_key,
        sender: resolvedName || msg.sender,
        sender_phone: resolvedPhone || msg.sender_phone || null,
        sender_key: resolvedPhone || msg.sender_key,
        sender_resolved_name: resolvedName || msg.sender_resolved_name,
        target_resolved_name: resolvedName || msg.target_resolved_name
      });
    } catch {}
    finally {
      resolvingIdentity.delete(msg.uid);
    }
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
          if (shouldEmitRecord(message)) sendToBackground(message);
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
    emitDomDebugSnapshot("startup_0s");
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
    periodicDomDebugHandle = window.setInterval(() => {
      emitDomDebugSnapshot(isOpenConversationContext() ? "heartbeat_open_chat" : "heartbeat_overview");
    }, 15000);
    window.setTimeout(emitCaptureDebug, 3000);
    window.setTimeout(emitCaptureDebug, 8000);
    window.setTimeout(() => emitDomDebugSnapshot("startup_3s"), 3000);
    window.setTimeout(() => emitDomDebugSnapshot("startup_8s"), 8000);
    sendToBackground({ event_type: "extension_started", source: "whatsapp_web_extension", page_url: location.href, captured_at: new Date().toISOString() });
  };

  if (document.body) start();
  else window.addEventListener("DOMContentLoaded", start, { once: true });
})();
