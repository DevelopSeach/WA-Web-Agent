const FALLBACKS = {
  webhookUrl: "",
  commandUrl: "",
  commandResultUrl: "",
  apiToken: "CHANGE_ME_SECRET",
  enabled: true,
  pollCommands: true
};

const ids = Object.keys(FALLBACKS);
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const statusEl = document.getElementById("status");

function sanitizeUrl(value) {
  return String(value || "").trim().replace(/^url:\s*/i, "").trim();
}

async function loadRuntimeDefaults() {
  try {
    const res = await fetch(chrome.runtime.getURL("runtime-config.json"));
    if (!res.ok) return {};
    const runtime = await res.json();
    return {
      webhookUrl: sanitizeUrl(runtime.webhookUrl || FALLBACKS.webhookUrl),
      commandUrl: sanitizeUrl(runtime.commandUrl || FALLBACKS.commandUrl),
      commandResultUrl: sanitizeUrl(runtime.commandResultUrl || FALLBACKS.commandResultUrl),
      apiToken: runtime.apiToken || FALLBACKS.apiToken,
      enabled: runtime.enabled !== false,
      pollCommands: runtime.pollCommands !== false
    };
  } catch {
    return { ...FALLBACKS };
  }
}

function applyConfig(cfg) {
  for (const id of ids) {
    if (els[id].type === "checkbox") els[id].checked = cfg[id] !== false;
    else els[id].value = cfg[id] || "";
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const data = {};
  for (const id of ids) data[id] = els[id].type === "checkbox" ? els[id].checked : sanitizeUrl(els[id].value);
  await chrome.storage.local.set(data);
  statusEl.textContent = "נשמר בהצלחה";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});

(async function load() {
  const defaults = await loadRuntimeDefaults();
  const cfg = { ...defaults, ...(await chrome.storage.local.get(ids)) };
  applyConfig(cfg);
})();
