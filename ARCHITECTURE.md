# ZeusHire — Architecture

CTI Group's video-interview portal. Two Cloudflare Workers + Microsoft 365 + two AI APIs.

## High-level map

```
                 Candidates                         Recruiters / Admin
                     │                                     │
            take.html / book.html                      admin.html
            library.html / share.html                      │
                     │                                     │
        ┌────────────┴──────────────┐         ┌────────────┴───────────┐
        │  STATIC SITE WORKER         │         │  (same static worker     │
        │  name: interview-portal     │◀────────│   serves admin.html)     │
        │  serves all .html/.js/.css  │         └──────────────────────────┘
        │  workers.dev, git-deployed  │
        └─────────────┬───────────────┘
                      │ fetch() XHR (CORS)
                      ▼
        ┌─────────────────────────────────────────────┐
        │  API WORKER   name: interview-api             │
        │  single file: worker.js (service-worker fmt)  │
        │  fetch + scheduled (hourly cron) handlers     │
        └───┬─────────────┬──────────────┬─────────────┘
            │             │              │
            ▼             ▼              ▼
   KV: INTERVIEW_DATA   Microsoft Graph   Anthropic + Groq
   (all app data)       (Mail, Calendar,  (English analysis:
                         OneDrive, Teams,  Claude + Whisper)
                         Entra SSO)
```

## Components

| Piece | What it is | Where |
|---|---|---|
| **Static site** | All candidate + admin HTML/JS/CSS. Worker name `interview-portal`. Auto-deploys from this repo via Cloudflare's git integration using root `wrangler.jsonc`. | `*.html`, `admin.js`, `interview.js`, `style.css` |
| **API worker** | All backend logic. Worker name `interview-api`, single file `worker.js` (service-worker format: `addEventListener('fetch')` + `('scheduled')`). Auto-deploys via GitHub Actions (`deploy/wrangler.toml`). | `worker.js` |
| **Data store** | Cloudflare KV namespace `interview-data`, bound as `INTERVIEW_DATA` (id `b4851c26e9db4b348fe8debc8b045283`). Everything is stored here as JSON. | KV |
| **Microsoft Graph** | App-registration ("CTI Interview App") with **application** permissions (tenant-wide). Used for: sending email, reading/writing any cti-usa.com calendar, OneDrive file storage (videos/résumés/photos/recordings), Teams meeting creation, and **Entra SSO** (auth-code flow). | external |
| **Anthropic (Claude)** | Question generation + English-proficiency analysis. | external |
| **Groq (Whisper)** | Transcribes interview audio for the analysis. | external |

## Auth model

- **Recruiters/Admin** sign in with **Microsoft Entra SSO** (`/api/auth/login` → callback → `authsession:{token}` in KV, 7-day TTL). Frontend sends `X-Auth-Token`.
- **Break-glass:** a shared `ADMIN_KEY` secret → `X-Admin-Key` header → resolves to a `super_admin`. Use only if SSO is down.
- `resolveUser()` accepts either header. `requireAdmin()` = any authenticated user; `requireSuperAdmin()` = role `super_admin`.
- **Roles:** one **super_admin** (the first-ever login / bootstrap), everyone else **recruiter**. "Admin" in the UI = a recruiter with `viewScope: manage_all`.
- **Visibility scope** (`viewScope`): `own` (default), `view_all` (see all, edit own), `manage_all` (full). Enforced by `canAccess(record, user, mode)` where `mode` is `'view'` or `'manage'`.

## Key KV keys (all under INTERVIEW_DATA)

| Pattern | Holds |
|---|---|
| `interview:list`, `interview:{id}` | One-way interviews |
| `interview:{id}:sessions` | array of session tokens |
| `session:{token}` | a candidate session (status, responses[], reviewDecision/Stars, aiScore, consentedAt, ownerId, …) |
| `user:list`, `user:{oid}`, `user:byEmail:{email}` | SSO users |
| `invite:list`, `invite:{email}` | pending team invites |
| `authsession:{token}`, `authstate:{state}` | SSO sessions / OAuth state |
| `tw-session:list`, `tw-session:{id}` | two-way (direct invite) sessions |
| `booking:link:list`, `booking:link:{token}`, `booking:link:{t}:bookings`, `booking:booking:{id}` | booking links + bookings |
| `premium:list`, `clientlib:{token}` | Premium Talent + client library links |
| `recruiter:settings` | branding, outcome-email templates, linkedCalendars (legacy/global), **retentionDays** |
| `holiday:list`, `holiday:{id}`, `holiday:settings` | booking holiday blocks |

## Per-recruiter calendar routing (Phase 3)

New meetings are created on the **owning recruiter's** mailbox (`user.calendarEmail`), stored as `organizerEmail` on the record. Recording fetches resolve from that same mailbox's OneDrive. Legacy records fall back to the shared `EMAIL_SENDER` mailbox (`corporate-recruiter@cti-usa.com`). Booking availability checks the owner's own calendar + their own linked calendars.

## Secrets & vars (set in the Cloudflare dashboard on interview-api)

`keep_vars=true` in `deploy/wrangler.toml` preserves these across deploys — they are NOT in the repo.

- `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET` — Entra app
- `EMAIL_SENDER` (corporate-recruiter@cti-usa.com), `ONEDRIVE_USER` — Graph mailbox/drive
- `ADMIN_KEY` — break-glass key
- `ANTHROPIC_API_KEY`, `GROQ_API_KEY` — AI

See `RUNBOOK.md` for how to deploy, roll back, and troubleshoot.
