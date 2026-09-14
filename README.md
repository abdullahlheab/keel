# Keel

Keel keeps a small company steady.

A self-hosted workspace for a small company: **projects, expenses with receipts, a company-wide spending summary, a Kanban task board, an activity log, and team accounts** — with everything sensitive encrypted at rest.

Built for two founders who want one place that answers "what are we working on, what did it cost, and who paid?" without handing the data to a third party.

## What's inside

| Area | Highlights |
|---|---|
| **Accounts** | Owner / admin / member roles, one-time invite links, optional two-factor (TOTP + recovery codes), active-session list, "sign out other devices" |
| **Projects** | Status, color, lead, dates, budget vs. actual spend, task progress |
| **Expenses** | Amount, vendor, category, project, who paid, status (pending / paid / reimbursed), recurring tag, notes, encrypted receipt uploads, CSV export |
| **Summary** | Totals by month / project / category / payer / vendor, budget meters, recurring monthly cost, pending reimbursements |
| **Task board** | Backlog → To do → In progress → In review → Done, drag and drop, priorities, labels, due dates, checklists, comments, `KEY-12` task ids, list view |
| **Multi-select** | Explorer-style: Ctrl/Shift+click or hover checkboxes, Ctrl+A, then right-click (or the floating bar) to move, assign, reprioritise, relabel, duplicate, copy or delete many tasks at once; drag a selection between columns; same for expenses (status, category, project, payer, export, delete) |
| **Activity** | Who changed what and when, across the whole company |

## Security model

- **Field-level encryption (AES-256-GCM).** Project names and descriptions, expense amounts, vendors, descriptions and notes, task titles, descriptions, labels, checklists and comments, activity summaries, and receipt files are encrypted before they are written to SQLite. The database file alone is useless without the key.
- **Key separation.** The key lives in `.env` (`ENCRYPTION_KEY`), never in the database. Back it up in a password manager. *If you lose the key, the data is gone.*
- **Passwords** are hashed with scrypt (N=2^15, per-user 32-byte salt). Login is rate-limited and accounts lock for 15 minutes after 10 failures.
- **Sessions** are random 256-bit tokens stored only as SHA-256 hashes, in `HttpOnly` / `SameSite=Lax` cookies (`Secure` when served over HTTPS). Changing your password revokes every other session.
- **Invites** are single-use, expire after 7 days, can be pinned to an email address, and are stored as hashes.
- **CSRF and headers.** Mutating requests require a custom header that cross-origin pages cannot send; a strict Content-Security-Policy, `nosniff`, frame and referrer policies, and HSTS (behind HTTPS) are set on every response.
- **Invite-only by default.** After the first account is created, nobody else can self-register; they need an invite link (`ALLOW_OPEN_SIGNUP=true` changes this).
- **Least privilege.** Members can only edit expenses they added or paid; admins/owners can edit everything; only owners can grant the owner role; the last owner cannot leave or be demoted.

## Quick start (local)

Requires Node.js 22.13 or newer (24 recommended). No database server, no build step.

```bash
npm install
npm run setup     # writes .env with a fresh ENCRYPTION_KEY - back it up!
npm start         # http://localhost:3000
```

On Windows you can also double-click `start.cmd` in the project folder. If PowerShell says "running scripts is disabled", use `npm.cmd start` instead of `npm start`, or run the commands from Command Prompt.

Open the URL, create the owner account and your company, then go to **Settings → Members & invites** to create an invite link for your co-founder.

`npm run dev` restarts the server on file changes. `npm test` runs the API test suite.

## Sharing it with your co-founder

Both of you need to reach the same server. Pick one:

1. **A small VPS + Caddy (recommended).** Any $5 box works. Caddy gives you automatic HTTPS:

   ```text
   keel.yourdomain.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Then in `.env`: `HOST=127.0.0.1`, `TRUST_PROXY=true`, `SECURE_COOKIES=true`, `NODE_ENV=production`, `APP_URL=https://keel.yourdomain.com`. Run it with Docker (below) or `pm2`/`systemd`.

2. **Docker anywhere** (Railway, Fly.io, Render, a NAS, a home server):

   ```bash
   npm run setup                # creates .env with ENCRYPTION_KEY
   docker compose up -d --build # data persists in the keel-data volume
   ```

   The container restarts automatically with Docker. `docker compose stop` pauses it, `docker compose logs -f` shows logs, and `docker compose up -d --build` again picks up code changes. Data lives in the `keel-data` volume, not in the project folder; to move an existing local `data` folder in, stop the container, `docker cp ./data/. keel:/data/`, fix ownership with `docker run --rm --user root -v keel-data:/data alpine chown -R 1000:1000 /data`, and start it again. Backups: `docker compose exec keel npm run backup` then `docker cp keel:/data/backups ./backups`.

   Put the same `ENCRYPTION_KEY` in the platform's secret store if it does not read `.env`. Set `SECURE_COOKIES=true` once it is behind HTTPS.

3. **Private network, no public exposure.** Run it on one machine with `HOST=0.0.0.0` and share it over [Tailscale](https://tailscale.com) or a LAN. Simple and never reachable from the internet.

Whatever you choose, **put it behind HTTPS** for anything beyond a private network. Cookies are only marked `Secure` when the server knows it is behind TLS (`SECURE_COOKIES=true` or a proxy that sets `X-Forwarded-Proto`).

## Configuration

All settings live in `.env` (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `ENCRYPTION_KEY` | generated | 32 random bytes, base64. **Required; back it up.** |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Use `HOST=0.0.0.0` to accept connections from other machines or Docker |
| `TRUST_PROXY` | `false` | `true` when behind Caddy / nginx / a PaaS load balancer |
| `SECURE_COOKIES` | `false` | Force the `Secure` cookie flag (set `true` in production) |
| `ALLOW_OPEN_SIGNUP` | `false` | Let anyone create a new company after the first one exists |
| `DATA_DIR` | `./data` | Where `tracker.sqlite` and encrypted receipts live |
| `APP_URL` | request origin | Public URL used in invite links |

## Forgot a password?

Passwords are never stored, so they cannot be recovered, but whoever runs the server can reset one from the terminal:

```bash
npm run reset-password -- you@company.com
```

It prompts for a new password (typed invisibly), signs that user out everywhere, and clears any lockout. Add `--disable-2fa` if the person also lost their authenticator phone.

## Backups

```bash
npm run backup
```

Creates `backups/<timestamp>/` with a consistent snapshot of the database and the encrypted receipts. Store it **together with your `.env` key** — the backup is encrypted the same way as the live data. To restore, stop the server, copy the snapshot back into `DATA_DIR`, and start again.

## Project layout

```text
server/            Express 5 API (ESM, no build step)
  config.js        .env loading, key generation
  crypto.js        AES-256-GCM, scrypt, tokens, TOTP
  db.js            SQLite (node:sqlite) + migrations
  middleware/      sessions, roles, CSRF, rate limits, security headers
  routes/          auth, company, projects, expenses, tasks, activity
public/            Vanilla-JS single-page app (no framework, no bundler)
  app/views/       one module per screen
  app/components/  modal, toast, forms, charts, drag & drop
test/              node:test API suite (encryption, permissions, 2FA, ...)
scripts/           setup (.env) and backup
```

## Roadmap ideas

Recurring-expense automation, per-project time tracking, email notifications for invites and due tasks, and multi-currency conversion are natural next steps — the schema already carries the fields they need.
