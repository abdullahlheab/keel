# Keel

Keel keeps a small company steady.

A self-hosted workspace for a small company: **projects, expenses with receipts, a company-wide spending summary, a Kanban task board, a discussion room, an activity log, and team accounts** — with everything sensitive encrypted at rest.

Built for two founders who want one place that answers "what are we working on, what did it cost, and who paid?" without handing the data to a third party.

## What's inside

| Area | Highlights |
|---|---|
| **Accounts** | Owner / admin / member roles, one-time invite links, optional two-factor (TOTP + recovery codes), active-session list, "sign out other devices" |
| **Projects** | Status, color, lead, dates, budget vs. actual spend, task progress |
| **Expenses** | Amount, vendor, category, project, who paid, status (pending / paid / reimbursed), recurring tag, notes, encrypted receipt uploads, CSV export |
| **Summary** | Totals by month / project / category / payer / vendor, budget meters, recurring monthly cost, pending reimbursements |
| **Task board** | Backlog → To do → In progress → In review → Done, drag and drop, priorities, labels, due dates, checklists, comments, `KEY-12` task ids, list view |
| **Discussion room** | A forum for the things that do not belong on the board: topics by category (general, announcement, question, idea, decision), threaded replies, mark-the-answer, pin, lock, resolve and archive, optional link to a project, `KEY-D4` topic ids |
| **Multi-select** | Explorer-style: Ctrl/Shift+click or hover checkboxes, Ctrl+A, then right-click (or the floating bar) to move, assign, reprioritise, relabel, duplicate, copy or delete many tasks at once; drag a selection between columns; same for expenses (status, category, project, payer, export, delete) and discussion topics (category, state, project, pin, lock, delete) |
| **Activity** | Who changed what and when, across the whole company |
| **API** | REST API at `/api/v1` with personal API keys (read-only or read & write, optional expiry), OpenAPI document, in-app docs with examples and a key tester |

## Security model

- **Field-level encryption (AES-256-GCM).** Project names and descriptions, expense amounts, vendors, descriptions and notes, task titles, descriptions, labels, checklists and comments, discussion topics and every reply, activity summaries, and receipt files are encrypted before they are written to SQLite. The database file alone is useless without the key.
- **Key separation.** The key lives in `.env` (`ENCRYPTION_KEY`), never in the database. Back it up in a password manager. *If you lose the key, the data is gone.*
- **Passwords** are hashed with scrypt (N=2^15, per-user 32-byte salt). Login is rate-limited and accounts lock for 15 minutes after 10 failures.
- **Sessions** are random 256-bit tokens stored only as SHA-256 hashes, in `HttpOnly` / `SameSite=Lax` cookies (`Secure` when served over HTTPS). Changing your password revokes every other session.
- **Invites** are single-use, expire after 7 days, can be pinned to an email address, and are stored as hashes.
- **CSRF and headers.** Mutating requests require a custom header that cross-origin pages cannot send; a strict Content-Security-Policy, `nosniff`, frame and referrer policies, and HSTS (behind HTTPS) are set on every response.
- **Invite-only.** The very first visitor sets up the workspace and becomes the owner. After that the app offers no way to create a second company — the sign-in page only points newcomers at an invite link, and `/register` says "invite only". `ALLOW_OPEN_SIGNUP=true` reopens the `/api/auth/register` endpoint for scripted setup, but never puts a button back in the UI.
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
| `ALLOW_OPEN_SIGNUP` | `false` | Let `POST /api/auth/register` create another company after the first one exists. For scripted setup and tests; the UI never exposes it |
| `DATA_DIR` | `./data` | Where `tracker.sqlite` and encrypted receipts live |
| `APP_URL` | request origin | Public URL used in invite links |

## API

Everything in the app is available over a REST API at `/api/v1`, so scripts, CI pipelines, Zapier, n8n or a spreadsheet can read and change projects, tasks, discussions and expenses. Anything you can do to company data in the UI, a key can do over HTTPS — that parity is a rule, not a goal.

1. In the app open **API** in the sidebar and create a key. Choose *read only* if the tool never needs to change anything, and an expiry if you can. The key is shown once; only its SHA-256 hash is stored.
2. Send it as a bearer token:

```bash
curl "https://your-keel-host/api/v1/tasks?status=todo" -H "Authorization: Bearer $KEEL_API_KEY"
```

```bash
curl -X POST "https://your-keel-host/api/v1/projects/PROJECT_ID/tasks" \
  -H "Authorization: Bearer $KEEL_API_KEY" -H "Content-Type: application/json" \
  -d '{"title": "Follow up with the agency", "priority": "high", "labels": ["from-api"]}'
```

```bash
curl -X PATCH "https://your-keel-host/api/v1/tasks/ACME-12" \
  -H "Authorization: Bearer $KEEL_API_KEY" -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

The **API** tab has copy-paste examples in curl, PowerShell, JavaScript and Python, a key tester, and a full endpoint reference. The same reference is served as an OpenAPI 3 document at `/api/v1/openapi.json` for Postman, Insomnia or code generators.

### Command line

`scripts/keel.js` is a small client that keeps the key out of your code, shell history and chat windows. It stores the key in `~/.keel/credentials.json` in your user profile and never prints it.

```bash
node scripts/keel.js login                                   # asks for the URL and the key (input hidden), checks it, saves it
node scripts/keel.js whoami
node scripts/keel.js get tasks?status=todo
node scripts/keel.js post tasks '{"title":"Call the bank","priority":"high"}'
node scripts/keel.js patch tasks/ACME-12 '{"status":"done"}'
node scripts/keel.js post discussions '{"title":"Do we still need staging?","category":"decision"}'
node scripts/keel.js logout
```

This is also the safe way to let an AI assistant or another tool on your machine work with Keel: create a dedicated key (so its changes are labelled in the activity log), run `login` yourself, and let the tool call the CLI. It gets the data, never the key. Revoke the key in the app to cut access instantly.

How it is secured:

- A key acts as the person who created it, with their role, inside one company. If they are removed, their keys stop working. Admins can see and revoke everyone's keys; members only their own.
- `/api/v1` accepts API keys only and ignores browser cookies, so it has no CSRF surface. Two things are deliberately out of reach of a key, both about identity rather than data: **creating keys** (that needs your password, so a key can never mint another key) and **adding, removing or re-roling people** (an invite link outlives the key that made it).
- Read-only keys are limited to GET. Each key is rate-limited to 300 requests per minute, and usage (last used, IP, request count) is shown in the app.
- Every change made through a key appears in the activity log marked with the key's name.

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
  routes/          auth, company, projects, expenses, tasks, discussions, activity
public/            Vanilla-JS single-page app (no framework, no bundler)
  app/views/       one module per screen
  app/components/  modal, toast, forms, charts, drag & drop
test/              node:test API suite (encryption, permissions, 2FA, ...)
scripts/           setup (.env) and backup
```

## Roadmap ideas

Recurring-expense automation, per-project time tracking, email notifications for invites and due tasks, and multi-currency conversion are natural next steps — the schema already carries the fields they need.
