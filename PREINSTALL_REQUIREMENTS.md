# Preinstall Requirements

- Node.js 18+ and npm
- MySQL 8+ or a compatible remote MySQL server
- A writable `.env` file at the repo root based on `.env.production.example`

The root install flow is:

```bash
npm run install:all
npm run db:init
npm run db:seed
npm run build
npm run start
```

The app reads its production port from `PORT` and serves both the API and built dashboard from the same process.

The Chrome extension runtime config is generated from `.env` during install/update, so its webhook and command URLs follow the installed domain automatically.
