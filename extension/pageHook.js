(() => {
  if (window.__waPageHookInstalled) return;
  window.__waPageHookInstalled = true;

  const installedMessageListeners = new WeakSet();
  let storeHookInstalled = false;

  function post(event_type, payload) {
    window.postMessage({ source: "WA_PAGE_HOOK", event_type, payload }, "*");
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u200e/g, "")
      .replace(/[\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stableUidFromModel(model) {
    const id = model?.id || model?.__x_id || model?.attributes?.id || null;
    if (!id) return "";
    if (typeof id === "string") return id;
    return cleanText(id?._serialized || id?.id || id?.toString?.() || "");
  }

  function pickName(...values) {
    return values.map((value) => cleanText(value)).find(Boolean) || null;
  }

  function serializeReply(reply) {
    if (!reply) return null;
    const snippet = pickName(
      reply?.body,
      reply?.caption,
      reply?.msgChunk,
      reply?.text,
      reply?.__x_body,
      reply?.__x_caption
    );
    const sender = pickName(
      reply?.notifyName,
      reply?.senderObj?.formattedName,
      reply?.contact?.formattedName,
      reply?.author?.user,
      reply?.from?.user,
      reply?.id?.participant?.user
    );
    if (!snippet && !sender) return null;
    return {
      text: snippet,
      sender,
      snippet
    };
  }

  function serializeReactions(model) {
    const container = model?.reactions || model?.reaction || model?.reactionTable || model?.__x_reactions;
    const list = Array.isArray(container)
      ? container
      : Array.isArray(container?.models)
        ? container.models
        : [];

    return list
      .map((entry) => {
        const emoji = pickName(entry?.reactionText, entry?.emoji, entry?.reaction, entry?.__x_reactionText);
        const actor = pickName(
          entry?.senderUserJid,
          entry?.sender?.user,
          entry?.author?.user,
          entry?.msgKey?.participant?.user,
          entry?.contact?.formattedName
        );
        if (!emoji && !actor) return null;
        return {
          text: cleanText([emoji, actor].filter(Boolean).join(" ")),
          emojis: emoji ? [emoji] : [],
          actors: actor ? [actor] : []
        };
      })
      .filter(Boolean);
  }

  function deriveDirection(model) {
    if (model?.id?.fromMe || model?.fromMe || model?.__x_id?.fromMe) return "outgoing";
    return "incoming";
  }

  function deriveTargetType(model) {
    const remote = model?.id?.remote || model?.to || model?.from || model?.__x_id?.remote;
    const serialized = cleanText(remote?._serialized || remote?.toString?.() || "");
    return serialized.includes("@g.us") ? "group" : "direct";
  }

  function serializeMessageModel(model) {
    const uid = stableUidFromModel(model);
    if (!uid) return null;

    const text = pickName(
      model?.body,
      model?.caption,
      model?.text,
      model?.__x_body,
      model?.__x_caption
    );

    const sender = pickName(
      model?.notifyName,
      model?.senderObj?.formattedName,
      model?.contact?.formattedName,
      model?.author?.formattedName,
      model?.author?.user,
      model?.id?.participant?.user,
      model?.from?.user
    );

    const targetName = pickName(
      model?.chat?.name,
      model?.chat?.formattedTitle,
      model?.chat?.contact?.formattedName,
      model?.to?.user,
      model?.from?.user
    );

    const targetType = deriveTargetType(model);
    const reply = serializeReply(model?.quotedMsg || model?.quotedMsgObj || model?.quotedStanzaObj || model?.__x_quotedMsg);
    const reactions = serializeReactions(model);
    const sentAt = model?.t ? new Date(model.t * 1000).toISOString() : new Date().toISOString();

    return {
      uid,
      event_type: "message",
      source: "whatsapp_web_extension_store",
      chat_title: targetType === "group" ? (targetName || sender || "Unknown chat") : (targetName || sender || "Unknown chat"),
      sender: sender || null,
      target_name: targetName || sender || null,
      target_type: targetType,
      direction: deriveDirection(model),
      sent_at_text: "",
      text: text || "",
      reply_to: reply,
      reactions,
      message_subtype: reply && reactions.length ? "reply+reaction" : reply ? "reply" : reactions.length ? "reaction" : "plain",
      page_url: location.href,
      captured_at: sentAt,
      payload_source: "store_hook"
    };
  }

  function emitModel(model, reason) {
    try {
      const payload = serializeMessageModel(model);
      if (!payload) return;
      payload.store_reason = reason;
      post("store_message", payload);
    } catch (error) {
      post("store_hook_error", { error: String(error?.message || error), at: new Date().toISOString() });
    }
  }

  function installModelListeners(model) {
    if (!model || installedMessageListeners.has(model) || typeof model.on !== "function") return;
    installedMessageListeners.add(model);
    model.on("change", () => emitModel(model, "change"));
    model.on("change:reactions", () => emitModel(model, "change:reactions"));
    model.on("change:quotedMsg", () => emitModel(model, "change:quotedMsg"));
    model.on("change:body", () => emitModel(model, "change:body"));
  }

  function findWebpackRequire() {
    const chunkKey = Object.keys(window).find((key) => /^webpackChunk/i.test(key));
    const chunk = chunkKey ? window[chunkKey] : null;
    if (!chunk || typeof chunk.push !== "function") return null;

    let webpackRequire = null;
    try {
      chunk.push([
        ["wa-agent-probe"],
        {},
        (require) => {
          webpackRequire = require;
        }
      ]);
    } catch (error) {
      post("store_hook_error", { error: `webpack probe failed: ${String(error?.message || error)}` });
    }
    return webpackRequire;
  }

  function findMsgStore(require) {
    if (!require?.c) return null;

    for (const cached of Object.values(require.c)) {
      const exports = cached?.exports;
      const candidates = [exports, exports?.default].filter(Boolean);
      for (const candidate of candidates) {
        if (candidate?.Msg && typeof candidate.Msg.on === "function") return candidate.Msg;
        if (candidate?.MsgStore && typeof candidate.MsgStore.on === "function") return candidate.MsgStore;
        if (candidate?.default?.Msg && typeof candidate.default.Msg.on === "function") return candidate.default.Msg;
      }
    }

    return null;
  }

  function installStoreHook() {
    if (storeHookInstalled) return;
    const require = findWebpackRequire();
    if (!require) {
      post("store_hook_debug", { ok: false, reason: "webpack_require_not_found", at: new Date().toISOString() });
      return;
    }

    const msgStore = findMsgStore(require);
    if (!msgStore) {
      post("store_hook_debug", { ok: false, reason: "msg_store_not_found", module_count: Object.keys(require.c || {}).length, at: new Date().toISOString() });
      return;
    }

    storeHookInstalled = true;
    post("store_hook_debug", {
      ok: true,
      reason: "msg_store_found",
      module_count: Object.keys(require.c || {}).length,
      store_keys: Object.keys(msgStore || {}).slice(0, 20),
      at: new Date().toISOString()
    });

    if (typeof msgStore.on === "function") {
      msgStore.on("add", (model) => {
        installModelListeners(model);
        emitModel(model, "add");
      });
      msgStore.on("change", (model) => {
        installModelListeners(model);
        emitModel(model, "change");
      });
    }

    const models = Array.isArray(msgStore.models) ? msgStore.models.slice(-50) : [];
    models.forEach((model) => installModelListeners(model));
  }

  post("page_hook_loaded", { url: location.href, at: new Date().toISOString() });
  setTimeout(installStoreHook, 1500);
  setTimeout(installStoreHook, 5000);
  setTimeout(installStoreHook, 10000);

  const NativeNotification = window.Notification;
  if (typeof NativeNotification === "function") {
    function WrappedNotification(title, options = {}) {
      try {
        post("notification", {
          title: String(title || ""),
          body: String(options.body || ""),
          icon: String(options.icon || ""),
          image: String(options.image || ""),
          badge: String(options.badge || ""),
          tag: String(options.tag || ""),
          data: options.data || null,
          at: new Date().toISOString()
        });
      } catch (err) {}
      return new NativeNotification(title, options);
    }
    WrappedNotification.permission = NativeNotification.permission;
    WrappedNotification.requestPermission = NativeNotification.requestPermission.bind(NativeNotification);
    WrappedNotification.prototype = NativeNotification.prototype;
    try { window.Notification = WrappedNotification; } catch (err) {
      post("notification_hook_error", { error: String(err?.message || err) });
    }
  }
})();
