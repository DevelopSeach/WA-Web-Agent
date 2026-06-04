# WA Web Agent

Chrome Extension + Windows Native Host + Node.js/MySQL + React dashboard for an approved WhatsApp Web automation MVP.

## What it does

- Reads visible WhatsApp Web messages from the DOM.
- Captures best-effort browser notifications from WhatsApp Web.
- Sends every event to a Node.js webhook.
- Stores events in MySQL 8.
- Lets the server queue commands for the Chrome Extension.
- Supports basic actions:
  - focus WhatsApp message box
  - insert/send text
  - click coordinates in the tab
  - press key
  - paste image from Windows path via Native Host
  - paste file from Windows path via Native Host

Use only for accounts, groups, and devices where you have authorization to monitor and automate messages.

---

## Project structure

```text
wa-web-agent/
├─ extension/        Chrome Extension Manifest V3
├─ native-host/      Windows PowerShell Native Messaging host
├─ server/           Node.js API server
├─ client/           React dashboard
├─ sql/              MySQL schema
├─ .env.example
├─ .env.production.example
└─ package.json      Root install/build/start entry points
```

---

## 1. Production install from repo root

The canonical Multidev-compatible flow is:

```bash
cp .env.production.example .env
npm run install:all
npm run db:init
npm run db:seed
npm run build
npm run start
```

Root scripts exposed for install automation:

- `npm run install:all`
- `npm run build`
- `npm run start`
- `npm run dev`
- `npm run prod`
- `npm run db:init`
- `npm run db:migrate`
- `npm run db:seed`
- `pm2 start ecosystem.config.js`

Production runtime behavior:

- The Node server listens on `PORT`
- The React dashboard is built into `client/dist`
- The server serves the dashboard and API from the same process
- The dashboard uses a same-origin API path by default, so production builds do not point at `localhost`

---

## 2. Environment

Create a root `.env` from either `.env.example` or `.env.production.example`.

Important keys:

```env
NODE_ENV='production'
APP_ENV='production'
PORT='your_assigned_port'
CLIENT_DIST_DIR='client/dist'
WEBHOOK_TOKEN='CHANGE_ME_SECRET'
MYSQL_HOST='127.0.0.1'
MYSQL_PORT='3306'
MYSQL_USER='wa_web_agent'
MYSQL_PASSWORD='your_password'
MYSQL_DATABASE='wa_logger'
```

Notes:

- Quote values in shell-sourced env files
- `PORT` is the only public runtime port required by the web app
- `MYSQL_DATABASE` is respected by `db:init`, `db:migrate`, and runtime queries

---

## 3. MySQL setup

```bash
npm run db:init
```

`db:init` is idempotent and will:

- create the configured database if it does not exist
- create the required tables
- use the database name from `MYSQL_DATABASE`

`db:seed` is safe to rerun. It currently inserts a single idempotent verification command row so install automation can confirm DB write access.

---

## 4. Run server

```bash
npm run start
```

Health test:

```bash
curl http://localhost:$PORT/api/health
```

---

## 5. Local development

```bash
cp .env.example .env
npm run install:all
```

Server:

```bash
cd server
npm run dev
```

Dashboard:

```bash
cd client
npm run dev
```

Open:

```text
http://localhost:5173
```

---

## 6. Install Chrome Extension

1. Open Chrome:

```text
chrome://extensions
```

2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Choose the `extension/` folder.
5. Open:

```text
https://web.whatsapp.com
```

6. Open the extension Options page and set, if needed, custom overrides:

```text
Webhook URL: https://your-domain.example/api/whatsapp-webhook
Command URL: https://your-domain.example/api/commands/next
Command Result URL: https://your-domain.example/api/commands/result
API Token: CHANGE_ME_SECRET
```

The extension defaults are generated from the repo `.env` during install/update, so on Multidev the public URLs should already point at the installed domain.

---

## 7. Install Windows Native Host

The Native Host is needed for OS-level actions such as pasting an image/file from a Windows path.

After loading the Chrome Extension, copy its Extension ID from `chrome://extensions`.

Run PowerShell as your normal Windows user:

```powershell
cd native-host
powershell -ExecutionPolicy Bypass -File .\install-native-host.ps1 -ExtensionId "YOUR_EXTENSION_ID"
```

This installs files to:

```text
C:\WAWebAgent\native-host
```

And registers:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.seach.wa_native_host
```

Restart Chrome after installation.

---

## 8. Dashboard usage

After the production app is running, open the public domain and enter the `WEBHOOK_TOKEN` into the dashboard's `API Token` field. The dashboard stores it in browser local storage and uses it for protected command endpoints.

---

## 9. Create commands manually

### Send text

```bash
curl -X POST http://localhost:$PORT/api/commands \
  -H "Content-Type: application/json" \
  -H "x-api-token: CHANGE_ME_SECRET" \
  -d '{"action":"send_text","text":"שלום, זו הודעת בדיקה","enter":true}'
```

### Paste and send image

Windows path must exist on the machine where Chrome is running:

```bash
curl -X POST http://localhost:$PORT/api/commands \
  -H "Content-Type: application/json" \
  -H "x-api-token: CHANGE_ME_SECRET" \
  -d '{"action":"paste_image","filePath":"C:\\\\WA_FILES\\\\image1.png","caption":"מצורפת תמונה","send":true}'
```

### Click inside WhatsApp tab

```bash
curl -X POST http://localhost:$PORT/api/commands \
  -H "Content-Type: application/json" \
  -H "x-api-token: CHANGE_ME_SECRET" \
  -d '{"action":"click","x":500,"y":800}'
```

### Press key

```bash
curl -X POST http://localhost:$PORT/api/commands \
  -H "Content-Type: application/json" \
  -H "x-api-token: CHANGE_ME_SECRET" \
  -d '{"action":"press_key","key":"Enter"}'
```

---

## 10. Notes and limits

- WhatsApp Web has no official browser-side API for group scraping. This is DOM observation and can break when WhatsApp changes the UI.
- Full media download is not guaranteed. The extension logs what the browser exposes: thumbnails, blob URLs, links, metadata, etc.
- Native Host pasting image/file uses the Windows clipboard and the currently focused Chrome/WhatsApp Web window.
- For production, add user authentication to the dashboard and restrict command creation.
- Keep `WEBHOOK_TOKEN` secret.

---

## 11. Suggested next improvements

- Add command target chat search/opening.
- Add command retry and timeout.
- Add command groups/sequences.
- Add file upload to server and local sync folder on the Windows machine.
- Add Extension status page: connected, last event, last command.
- Add per-chat allowlist.
