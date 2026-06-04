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
└─ sql/              MySQL schema
```

---

## 1. MySQL setup

```bash
mysql -u root -p < sql/schema.sql
```

Or from server folder:

```bash
cd server
cp .env.example .env
npm install
npm run init-db
```

Edit `server/.env`:

```env
PORT=3001
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=wa_logger
WEBHOOK_TOKEN=CHANGE_ME_SECRET
```

---

## 2. Run server

```bash
cd server
npm install
npm run dev
```

Health test:

```bash
curl http://localhost:3001/api/health
```

---

## 3. Run dashboard

```bash
cd client
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

---

## 4. Install Chrome Extension

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

6. Open the extension Options page and set:

```text
Webhook URL: http://localhost:3001/api/whatsapp-webhook
Command URL: http://localhost:3001/api/commands/next
Command Result URL: http://localhost:3001/api/commands/result
API Token: CHANGE_ME_SECRET
```

---

## 5. Install Windows Native Host

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

## 6. Create commands manually

### Send text

```bash
curl -X POST http://localhost:3001/api/commands \
  -H "Content-Type: application/json" \
  -H "x-api-token: CHANGE_ME_SECRET" \
  -d '{"action":"send_text","text":"שלום, זו הודעת בדיקה","enter":true}'
```

### Paste and send image

Windows path must exist on the machine where Chrome is running:

```bash
curl -X POST http://localhost:3001/api/commands \
  -H "Content-Type: application/json" \
  -H "x-api-token: CHANGE_ME_SECRET" \
  -d '{"action":"paste_image","filePath":"C:\\\\WA_FILES\\\\image1.png","caption":"מצורפת תמונה","send":true}'
```

### Click inside WhatsApp tab

```bash
curl -X POST http://localhost:3001/api/commands \
  -H "Content-Type: application/json" \
  -H "x-api-token: CHANGE_ME_SECRET" \
  -d '{"action":"click","x":500,"y":800}'
```

### Press key

```bash
curl -X POST http://localhost:3001/api/commands \
  -H "Content-Type: application/json" \
  -H "x-api-token: CHANGE_ME_SECRET" \
  -d '{"action":"press_key","key":"Enter"}'
```

---

## 7. Notes and limits

- WhatsApp Web has no official browser-side API for group scraping. This is DOM observation and can break when WhatsApp changes the UI.
- Full media download is not guaranteed. The extension logs what the browser exposes: thumbnails, blob URLs, links, metadata, etc.
- Native Host pasting image/file uses the Windows clipboard and the currently focused Chrome/WhatsApp Web window.
- For production, add user authentication to the dashboard and restrict command creation.
- Keep `WEBHOOK_TOKEN` secret.

---

## 8. Suggested next improvements

- Add command target chat search/opening.
- Add command retry and timeout.
- Add command groups/sequences.
- Add file upload to server and local sync folder on the Windows machine.
- Add Extension status page: connected, last event, last command.
- Add per-chat allowlist.
