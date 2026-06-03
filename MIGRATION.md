# Migration: GitHub Pages → Cloudflare Pages + Access (admin-only gate)

Goal: serve the site from Cloudflare Pages and put **Cloudflare Access** (SSO/MFA)
in front of `admin.html`, while keeping candidate pages (`take.html`, `book.html`,
`share.html`) public. The Worker API and admin key are unchanged.

## End-state
```
Candidate  →  interview-portal.pages.dev/take.html    (PUBLIC, token link)
Recruiter  →  interview-portal.pages.dev/admin.html   (behind Cloudflare Access → SSO/MFA)
Both       →  interview-api.<acct>.workers.dev          (unchanged; CORS allows pages.dev)
```
Access gates *who can load the admin page*; the admin key remains the API credential. Two layers.

## Prereqs already done in code
- Worker CORS allowlist includes BOTH `https://putuastra.github.io` and
  `https://interview-portal.pages.dev` (see `ALLOWED_ORIGINS` in `worker.js`).
  → Redeploy the Worker so this is live BEFORE testing the pages.dev site.
- Candidate/share/book links are origin-relative (`window.location.origin`), so they
  auto-follow whatever domain the admin page is opened from. **Keep all `.html` files
  flat in one folder** — do NOT move admin into a subfolder, or link-building breaks.

---

## Step 1 — Create the Pages project
1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Authorize GitHub, select **`PutuAstra/interview-portal`**.
3. Build settings: **Framework preset = None**, **Build command = empty**, **Output dir = `/`**.
4. **Save and Deploy.** Result: `https://interview-portal.pages.dev`
   - ⚠️ The project MUST be named `interview-portal` so the domain matches the CORS
     allowlist. If Cloudflare assigns a different name, either rename it or update
     `ALLOWED_ORIGINS` in `worker.js` and redeploy the Worker.
5. Every `git push` to `main` now auto-deploys here too.

## Step 2 — Redeploy the Worker (CORS)
Paste the current `worker.js` into Cloudflare → Workers & Pages → your Worker →
Edit Code → Deploy. (Allows pages.dev origin.)

## Step 3 — Verify both pages load on pages.dev
- `…pages.dev/take.html?token=…` → loads, API works.
- `…pages.dev/admin.html` → loads, lists/sessions work (CORS OK).

## Step 4 — Add the Access application (admin path only)
1. Open **Zero Trust** (`one.dash.cloudflare.com`); pick a team name (e.g. `cti`) if first time.
2. **Access → Applications → Add an application → Self-hosted.**
3. **Name:** `ZeusHire Admin`.
4. **Application domain:** `interview-portal.pages.dev` · **Path:** `admin.html`.
   (Protects only `/admin.html`; candidate pages stay public.)
5. **Session duration:** 24 hours.

## Step 5 — Identity provider
- **Quick start:** Zero Trust → Settings → Authentication → **One-time PIN** (on by default; emailed code).
- **Better (CTI):** add **Azure AD / Entra** (tenant ID, client ID, client secret) for real SSO + MFA.

## Step 6 — Access policy (who's allowed)
In `ZeusHire Admin` → **Policies → Add a policy**:
- **Action:** Allow.
- **Include:** Emails ending in `@cti-usa.com` (whole company) OR an explicit email list (tighter, recommended).
- Optional: **Require → MFA**.

## Step 7 — Test
- Incognito → `…pages.dev/admin.html` → Access login → authenticate → admin loads → key works.
- Incognito → `…pages.dev/take.html?token=…` → loads with NO Access prompt.

## Step 8 — 🚨 Close the bypass (critical)
Access only protects the Cloudflare-served copy. The old
`https://putuastra.github.io/interview-portal/admin.html` is STILL open and bypasses Access.
- **Disable GitHub Pages:** repo Settings → Pages → Source → **None**.
- Then drop `https://putuastra.github.io` from `ALLOWED_ORIGINS` in `worker.js` and redeploy the Worker.

---

## Optional next level (defense in depth)
Route the Worker through a Cloudflare custom domain, put it behind the same Access app,
and have the Worker validate the `Cf-Access-Jwt-Assertion` header against your team's
public keys. This requires Access at the API too, so a leaked admin key alone won't work
from arbitrary origins. Do this only after the above is stable.

## Gotchas
- Keep all `.html` files flat in one folder (link-building depends on it).
- Disable GitHub Pages or the gate is meaningless.
- Candidate pages must stay OUTSIDE the protected path.
- Update Worker CORS when origins change (Steps 2 and 8).
