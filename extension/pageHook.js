(() => {
  if (window.__waPageHookInstalled) return;
  window.__waPageHookInstalled = true;

  function post(event_type, payload) {
    window.postMessage({ source: "WA_PAGE_HOOK", event_type, payload }, "*");
  }

  post("page_hook_loaded", { url: location.href, at: new Date().toISOString() });

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
