# ZeusHire — Operations Runbook

Practical procedures for running ZeusHire. Read `ARCHITECTURE.md` first for the system map.

**Production URLs**
- Admin: `https://interview-portal.putuastrawijaya.workers.dev/admin`
- API: `https://interview-api.putuastrawijaya.workers.dev`

---

## 1. Deploying changes

### Frontend (admin.js, interview.js, *.html, style.css)
1. Edit the file. **Bump the cache version** so browsers reload:
   - `admin.html`: `admin.js?v=...` and `style.css?v=...`
   - `take.html`: `var BUILD = '...'` **and** `interview.js?v=...` (both must match)
2. `git commit` + `git push`.
3. Cloudflare's git integration auto-deploys the static site (`interview-portal`) in ~30–60 s.
4. Hard-refresh (`Ctrl+Shift+R`) to confirm.

### Backend (worker.js)
1. Edit `worker.js`.
2. `git commit` + `git push` to `main`.
3. **GitHub Actions → "Deploy API Worker"** runs automatically: syntax-check → unit tests → `wrangler deploy`. If tests fail, **it does not deploy** (prod stays on the last good version).
4. Watch it in the repo's **Actions** tab. Green = live.

> You can also deploy manually: Actions tab → "Deploy API Worker" → **Run workflow**.

### Rollback (instant)
Cloudflare dashboard → **Workers & Pages → interview-api → Deployments** → pick the previous version → **Rollback**. (Static site has the same Deployments rollback.)

---

## 2. Local checks before pushing
```
npm run check   # node --check on worker.js, admin.js, interview.js
npm test        # access-control isolation tests (node:test)
```
CI runs both on every push; run them locally to catch issues first.

---

## 3. Common admin tasks

| Task | Where |
|---|---|
| Invite a teammate (set their access at invite time) | Admin → **Team → ➕ Invite someone** |
| Change a recruiter's role/visibility | Admin → **Team → Members** dropdowns |
| Disable/remove a user | Admin → **Team → Members** (last super-admin is protected) |
| Reassign all records to a recruiter | Admin → **Team → Record ownership** ("Reassign all" checkbox) |
| Set data-retention auto-purge | Admin → **Employer Branding → Data Retention** (0 = keep forever) |
| Each recruiter's extra busy-calendars | Admin → **Calendar Sync** (per-recruiter) |
| See pipeline metrics | Admin → **📊 Dashboard** |

---

## 4. Scheduled jobs (cron)

`interview-api` runs **hourly** (`0 * * * *`, declared in `deploy/wrangler.toml`). Each run:
1. Sends due reminder emails to pending candidates.
2. Runs the **data-retention purge** — only if `recruiter:settings.retentionDays > 0`.

Cron is visible at Cloudflare → interview-api → **Settings → Triggers**. If a deploy ever drops it, it's because `[triggers] crons` is missing from `deploy/wrangler.toml` — re-add `crons = ["0 * * * *"]`.

---

## 5. Troubleshooting (issues we've actually hit)

**"Failed to fetch" / CORS after login** → `worker.js` `CORS_BASE` must include `X-Auth-Token` in `Access-Control-Allow-Headers`. Redeploy.

**Review modal shows "No responses yet" but list shows videos** → `getSession` not recognizing the auth type. It must use `resolveUser()` (handles both `X-Auth-Token` and `X-Admin-Key`), not just the admin key.

**Recording "tag not found" / won't fetch** → the recording is older than the recent-files listing. `fetchTWRecording`/`fetchBookingRecording` do a **drive-wide search by the `[CTI-{shortId}]` tag** first; if still missing, the meeting may have been recorded under a different mailbox or not recorded at all. Check the record's `organizerEmail`.

**All of a candidate's videos look identical (frozen)** → a mobile browser throttled the canvas `captureStream`. The interview now detects a frozen canvas pre-record and falls back to the **raw camera** (logged as `canvas_frozen_fallback`). Affected old recordings can't be recovered — re-invite the candidate.

**Invite email not received** → `inviteUser` sends via Graph from `EMAIL_SENDER`. Use **Resend** on the pending invite; check the recipient's spam/distribution-list filtering. The invite is valid even if the email fails.

**A recruiter can't see legacy (pre-SSO) records** → those have no `ownerId` (super-admin-only). Use **Team → Record ownership** to assign them.

**Deploy failed in CI** → open the Actions log. Most likely `npm test` or `node --check` failed — fix and re-push. Prod is untouched on a failed deploy.

---

## 6. Break-glass (SSO down)
Admin login page → "Use admin key instead" → enter `ADMIN_KEY` (the Cloudflare secret). This grants temporary super-admin via `X-Admin-Key`. Rotate the key afterward if it was exposed.

---

## 7. External dependencies & where they're configured
- **Entra app** ("CTI Interview App") — Azure portal. Redirect URI must be `https://interview-api.putuastrawijaya.workers.dev/api/auth/callback`. App (not delegated) permissions: Mail.Send, Calendars.ReadWrite.All, Files.ReadWrite.All, OnlineMeetings/Calendars, User.Read.All.
- **Cloudflare** — Workers (interview-api, interview-portal), KV (interview-data), secrets, cron.
- **GitHub** — repo `PutuAstra/interview-portal`; Actions secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- **Anthropic / Groq** — API keys as Cloudflare secrets.

---

## 8. Allowed sign-in domain
Only `@cti-usa.com` accounts that have been **invited** can sign in (`ALLOWED_EMAIL_DOMAIN` + invite allowlist in `authCallback`). The very first login bootstraps the single super-admin.
