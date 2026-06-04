import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outPath = path.join(rootDir, 'extension', 'runtime-config.json');
const envFiles = ['.env.production', '.env'];

function parseEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const out = {};
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (!key) continue;
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch (err) {
    if (err && err.code === 'EACCES') return {};
    throw err;
  }
}

function loadEnv() {
  return envFiles.reduce((acc, relPath) => Object.assign(acc, parseEnvFile(path.join(rootDir, relPath))), {});
}

function normalizeBaseUrl(env) {
  const candidates = [env.APP_URL, env.PUBLIC_URL, env.SERVER_URL, env.API_BASE_URL];
  for (const candidate of candidates) {
    if (candidate && String(candidate).trim()) {
      return String(candidate).trim().replace(/\/$/, '');
    }
  }
  if (env.APP_DOMAIN) {
    return `https://${String(env.APP_DOMAIN).trim()}`;
  }
  return '';
}

const env = loadEnv();
const baseUrl = normalizeBaseUrl(env);
const config = {
  baseUrl,
  webhookUrl: baseUrl ? `${baseUrl}/api/whatsapp-webhook` : '',
  commandUrl: baseUrl ? `${baseUrl}/api/commands/next` : '',
  commandResultUrl: baseUrl ? `${baseUrl}/api/commands/result` : '',
  apiToken: env.WEBHOOK_TOKEN || 'CHANGE_ME_SECRET',
  enabled: true,
  pollCommands: true,
  pollSeconds: 3
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`[render-extension-config] wrote ${path.relative(rootDir, outPath)} (${baseUrl || 'no baseUrl'})`);
