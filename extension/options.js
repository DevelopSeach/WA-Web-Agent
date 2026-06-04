const defaults = {
  webhookUrl: "http://localhost:3001/api/whatsapp-webhook",
  commandUrl: "http://localhost:3001/api/commands/next",
  commandResultUrl: "http://localhost:3001/api/commands/result",
  apiToken: "CHANGE_ME_SECRET",
  enabled: true,
  pollCommands: true
};

const ids = Object.keys(defaults);
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const statusEl = document.getElementById("status");

document.getElementById("save").addEventListener("click", async () => {
  const data = {};
  for (const id of ids) data[id] = els[id].type === "checkbox" ? els[id].checked : els[id].value.trim();
  await chrome.storage.local.set(data);
  statusEl.textContent = "נשמר בהצלחה";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});

(async function load() {
  const cfg = { ...defaults, ...(await chrome.storage.local.get(ids)) };
  for (const id of ids) {
    if (els[id].type === "checkbox") els[id].checked = cfg[id] !== false;
    else els[id].value = cfg[id];
  }
})();
