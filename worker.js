// ─────────────────────────────────────────────────────────────
//  CTI Interview API — Cloudflare Worker (OneDrive storage)
//  Format: Service Worker (addEventListener) — paste into Cloudflare dashboard
//
//  Required secrets (Worker Settings → Bindings → Secret):
//    ADMIN_KEY         — your chosen admin password
//    TENANT_ID         — Azure tenant ID
//    CLIENT_ID         — Azure app client ID
//    CLIENT_SECRET     — Azure app client secret
//    ONEDRIVE_USER     — OneDrive owner email for video file storage (e.g. putu.astra@cti-usa.com)
//    EMAIL_SENDER      — Recruiter calendar owner + email from-address (corporate-recruiter@cti-usa.com)
//    GROQ_API_KEY      — Groq API key (free) — Whisper transcription + LLM
//                        rating, question generation, and premium overviews
//
//  Required KV binding (Worker Settings → Bindings → KV Namespace):
//    INTERVIEW_DATA  → interview-data
//
//  No R2 bucket needed.
// ─────────────────────────────────────────────────────────────

const CTI_LOGO_URL = 'https://interview-portal.putuastrawijaya.workers.dev/logo.png';

// Restrict browser access to the app's own origins instead of "*". The request's
// Origin is reflected back ONLY if it's in this allowlist (otherwise the default,
// first entry, is sent and the browser blocks the cross-origin read). Keep both the
// GitHub Pages and Cloudflare Pages origins here during the migration; once GitHub
// Pages is disabled, drop the github.io entry.
const ALLOWED_ORIGINS = [
  'https://interview-portal.putuastrawijaya.workers.dev', // Cloudflare static-asset Worker (canonical host)
];
const CORS_BASE = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Auth-Token',
  'Vary': 'Origin',
};
// Default headers used by jsonRes; handle() overrides the origin per-request.
const CORS = { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0], ...CORS_BASE };

function pickOrigin(request) {
  const origin = request.headers.get('Origin');
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

addEventListener('scheduled', event => {
  event.waitUntil(handleScheduled());
});

function applyOrigin(res, origin) {
  res.headers.set('Access-Control-Allow-Origin', origin);
  return res;
}

async function handle(request) {
  const allowOrigin = pickOrigin(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': allowOrigin, ...CORS_BASE } });
  }

  // Brute-force throttle: applies ONLY to requests that carry an X-Admin-Key header.
  const providedKey = request.headers.get('X-Admin-Key');
  if (providedKey !== null) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (await authFailCount(ip) >= AUTH_FAIL_LIMIT) {
      return applyOrigin(jsonRes({ error: 'Too many failed attempts. Please try again later.' }, 429), allowOrigin);
    }
    if (!constTimeEq(providedKey, ADMIN_KEY)) {
      await recordAuthFail(ip);
      // Fall through — requireAdmin in the route will return the 401.
    }
  }

  let res;
  try {
    res = await route(request);
  } catch (e) {
    if (e.message === 'Unauthorized') {
      res = jsonRes({ error: 'Unauthorized' }, 401);
    } else if (e.message === 'Forbidden') {
      res = jsonRes({ error: 'Forbidden — administrator access required.' }, 403);
    } else {
      // Log the real error server-side; return a generic message so internal
      // details / stack traces never reach the client.
      console.error('Worker unhandled error:', e.message, e.stack || '');
      res = jsonRes({ error: 'Internal server error' }, 500);
    }
  }
  return applyOrigin(res, allowOrigin);
}

// ── Router ────────────────────────────────────────────────────

async function route(request) {
  const url = new URL(request.url);
  const m = request.method;
  const seg = url.pathname.replace(/^\/api\//, '').split('/');

  // ── Auth (SSO) — public ──
  if (seg[0] === 'auth' && seg[1] === 'login'    && m === 'GET')  return authLogin(request);
  if (seg[0] === 'auth' && seg[1] === 'callback' && m === 'GET')  return authCallback(request);
  if (seg[0] === 'auth' && seg[1] === 'me'       && m === 'GET')  return authMe(request);
  if (seg[0] === 'auth' && seg[1] === 'logout'   && m === 'POST') return authLogout(request);

  // ── Team management (super_admin only) ──
  if (seg[0] === 'users' && seg.length === 1 && m === 'GET')  return listUsers(request);
  if (seg[0] === 'users' && seg[1] === 'basic' && seg.length === 2 && m === 'GET') return listUsersBasic(request);
  if (seg[0] === 'users' && seg[1] === 'invite' && seg.length === 2 && m === 'POST')   return inviteUser(request);
  if (seg[0] === 'users' && seg[1] === 'invite' && seg.length === 3 && m === 'DELETE') return revokeInvite(decodeURIComponent(seg[2]), request);
  if (seg[0] === 'audit' && seg.length === 1 && m === 'GET') return getAuditLog(request);
  if (seg[0] === 'users' && seg[1] === 'backfill-owner' && seg.length === 2 && m === 'POST') return backfillOwner(request);
  if (seg[0] === 'users' && seg.length === 2 && m === 'PATCH')  return updateUser(seg[1], request);
  if (seg[0] === 'users' && seg.length === 2 && m === 'DELETE') return deleteUser(seg[1], request);

  if (seg[0] === 'analytics' && seg.length === 1 && m === 'GET') {
    return getAnalytics(request);
  }
  if (seg[0] === 'interviews' && seg.length === 1) {
    if (m === 'GET')  return listInterviews(request);
    if (m === 'POST') return createInterview(request);
  }
  if (seg[0] === 'interview' && seg.length === 2) {
    if (m === 'GET')    return getInterview(seg[1], request);
    if (m === 'PUT')    return updateInterview(seg[1], request);
    if (m === 'DELETE') return deleteInterview(seg[1], request);
  }
  if (seg[0] === 'interview' && seg[2] === 'access' && m === 'POST') {
    return setInterviewAccess(seg[1], request);
  }
  if (seg[0] === 'interview' && seg[2] === 'sessions') {
    if (m === 'GET')  return listSessions(seg[1], request);
    if (m === 'POST') return createSession(seg[1], request);
  }
  if (seg[0] === 'session' && seg.length === 2 && m === 'GET') {
    return getSession(seg[1], request);
  }
  if (seg[0] === 'session' && seg.length === 2 && m === 'DELETE') {
    return deleteSession(seg[1], request);
  }
  if (seg[0] === 'session' && seg.length === 2 && m === 'PATCH') {
    return patchSession(seg[1], request);
  }
  if (seg[0] === 'session' && seg[2] === 'send-email' && m === 'POST') {
    return sendInterviewEmail(seg[1], request);
  }
  if (seg[0] === 'session' && seg[2] === 'remind' && m === 'POST') {
    return remindSessionNow(seg[1], request);
  }
  if (seg[0] === 'session' && seg[2] === 'consent' && m === 'POST') {
    return recordConsent(seg[1], request);
  }
  if (seg[0] === 'session' && seg[2] === 'verify-identity' && m === 'POST') {
    return recordVerify(seg[1], request);
  }
  if (seg[0] === 'session' && seg[2] === 'upload' && m === 'POST') {
    return uploadVideo(seg[1], parseInt(seg[3]), request);
  }
  if (seg[0] === 'session' && seg[2] === 'upload-audio' && m === 'POST') {
    return uploadAnswerAudio(seg[1], parseInt(seg[3]), request);
  }
  if (seg[0] === 'session' && seg[2] === 'answer' && m === 'POST') {
    return submitWrittenAnswer(seg[1], parseInt(seg[3]), request);
  }
  if (seg[0] === 'session' && seg[2] === 'complete' && m === 'POST') {
    return completeSession(seg[1]);
  }
  if (seg[0] === 'session' && seg[2] === 'video' && m === 'GET') {
    return getVideoUrl(seg[1], parseInt(seg[3]), request);
  }
  if (seg[0] === 'session' && seg[2] === 'video-file' && m === 'GET') {
    return getVideoFile(seg[1], parseInt(seg[3]), request);
  }

  // Two-way sessions
  if (seg[0] === 'tw-sessions' && seg[1] === 'unified' && seg.length === 2 && m === 'GET') {
    return listUnifiedTWSessions(request);
  }
  if (seg[0] === 'tw-sessions' && seg.length === 1) {
    if (m === 'GET')  return listTWSessions(request);
    if (m === 'POST') return createTWSession(request);
  }
  if (seg[0] === 'tw-session' && seg.length === 2) {
    if (m === 'PUT')    return updateTWSession(seg[1], request);
    if (m === 'DELETE') return deleteTWSessionHandler(seg[1], request);
  }
  if (seg[0] === 'tw-session' && seg[2] === 'send-email' && m === 'POST') {
    return sendTWEmail(seg[1], request);
  }
  if (seg[0] === 'tw-session' && seg[2] === 'fetch-recording' && m === 'POST') {
    return fetchTWRecording(seg[1], request);
  }
  if (seg[0] === 'tw-session' && seg[2] === 'recording-url' && m === 'GET') {
    return getTWRecordingUrl(seg[1], request);
  }

  if (seg[0] === 'session' && seg[2] === 'proctoring' && m === 'POST') return saveProctoringLog(seg[1], request);

  // One-way: AI English analysis
  if (seg[0] === 'session' && seg[2] === 'analyze' && m === 'POST') {
    return analyzeSession(seg[1], request);
  }
  if (seg[0] === 'session' && seg[2] === 'analysis' && m === 'GET') {
    return getAnalysis(seg[1], request);
  }

  // One-way: profile photo + resume upload (candidate-facing, no admin key)
  if (seg[0] === 'session' && seg[2] === 'upload-photo'  && m === 'POST') return uploadProfilePhoto(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'upload-resume' && m === 'POST') return uploadResume(seg[1], request);
  // One-way: profile photo + resume fetch (admin-facing)
  if (seg[0] === 'session' && seg[2] === 'profile-photo' && m === 'GET')  return getProfilePhotoUrl(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'resume-url'    && m === 'GET')  return getResumeUrl(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'resume-file'   && m === 'GET')  return getResumeFile(seg[1], request);
  // One-way: recruiter review outcome
  if (seg[0] === 'session' && seg[2] === 'review' && m === 'POST') return saveSessionReview(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'review' && m === 'GET')  return getSessionReview(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'seen-feedback' && m === 'POST') return markFeedbackSeen(seg[1], request);

  // One-way: shareable review links (admin creates, public reads)
  if (seg[0] === 'session' && seg[2] === 'share' && seg[3] === 'email' && m === 'POST') return sendShareEmail(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'share' && m === 'POST') return createShareLink(seg[1], request);
  if (seg[0] === 'share'   && seg.length === 2    && m === 'GET')  return getShare(seg[1]);
  if (seg[0] === 'share'   && seg[2] === 'video'  && m === 'GET')  return getShareVideo(seg[1], parseInt(seg[3]));
  if (seg[0] === 'share'   && seg[2] === 'resume-url' && m === 'GET') return getShareResume(seg[1]);
  if (seg[0] === 'share'   && seg[2] === 'feedback' && m === 'POST') return submitShareFeedback(seg[1], request);

  // ── Premium Talent Library ──
  if (seg[0] === 'session' && seg[2] === 'premium' && seg[3] === 'taken' && m === 'POST') return markPremiumTaken(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'premium' && seg[3] === 'available' && m === 'POST') return markPremiumAvailable(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'premium' && seg[3] === 'overview' && seg[4] === 'generate' && m === 'POST') return generatePremiumOverview(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'premium' && seg[3] === 'overview' && m === 'POST') return setPremiumOverview(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'premium' && seg.length === 3 && m === 'POST')   return addToPremium(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'premium' && seg.length === 3 && m === 'DELETE') return removeFromPremium(seg[1], request);
  if (seg[0] === 'premium' && seg.length === 1 && m === 'GET')        return listPremium(request);
  if (seg[0] === 'clientlib' && seg.length === 1 && m === 'POST')     return createClientLib(request);
  if (seg[0] === 'clientlib' && seg.length === 1 && m === 'GET')      return listClientLibs(request);
  if (seg[0] === 'clientlib' && seg.length === 2 && m === 'DELETE')   return deleteClientLib(seg[1], request);
  if (seg[0] === 'clientlib' && seg[2] === 'video'    && m === 'GET') return getClientLibVideo(seg[1], seg[3], parseInt(seg[4]));
  if (seg[0] === 'clientlib' && seg[2] === 'resume'   && m === 'GET') return getClientLibResume(seg[1], seg[3]);
  if (seg[0] === 'clientlib' && seg[2] === 'interest' && m === 'POST') return clientExpressInterest(seg[1], seg[3], request);
  if (seg[0] === 'session' && seg[2] === 'premium' && seg[3] === 'interest' && m === 'DELETE') return clearPremiumInterest(seg[1], seg[4], request);
  if (seg[0] === 'clientlib' && seg[2] === 'email'    && m === 'POST') return sendClientLibEmail(seg[1], request);
  if (seg[0] === 'clientlib' && seg.length === 2      && m === 'GET') return getClientLib(seg[1]);

  // Interview Script management
  if (seg[0] === 'script' && seg[1] === 'clients' && seg.length === 2) {
    if (m === 'GET')  return listScriptClients(request);
    if (m === 'POST') return createScriptClient(request);
  }
  if (seg[0] === 'script' && seg[1] === 'client' && seg.length === 3 && m === 'DELETE') {
    return deleteScriptClient(seg[2], request);
  }
  if (seg[0] === 'script' && seg[1] === 'client' && seg[3] === 'positions') {
    if (m === 'GET')  return listScriptPositions(seg[2], request);
    if (m === 'POST') return createScriptPosition(seg[2], request);
  }
  if (seg[0] === 'script' && seg[1] === 'position' && seg.length === 3 && m === 'DELETE') {
    return deleteScriptPosition(seg[2], request);
  }
  if (seg[0] === 'script' && seg[1] === 'position' && seg[3] === 'upload' && m === 'POST') {
    return uploadScriptDoc(seg[2], request);
  }
  if (seg[0] === 'script' && seg[1] === 'position' && seg[3] === 'doc-url' && m === 'GET') {
    return getScriptDocUrl(seg[2], request);
  }
  if (seg[0] === 'script' && seg[1] === 'client' && seg[3] === 'upload-logo' && m === 'POST') {
    return uploadScriptClientLogo(seg[2], request);
  }
  if (seg[0] === 'script' && seg[1] === 'client' && seg[3] === 'logo-url' && m === 'GET') {
    return getScriptClientLogoUrl(seg[2], request);
  }

  // ── Booking Interview ────────────────────────────────────────
  // Admin routes
  if (seg[0] === 'booking' && seg[1] === 'links' && seg.length === 2) {
    if (m === 'GET')  return listBookingLinks(request);
    if (m === 'POST') return createBookingLink(request);
  }
  if (seg[0] === 'booking' && seg[1] === 'link' && seg.length === 3) {
    if (m === 'PUT')    return updateBookingLink(seg[2], request);
    if (m === 'DELETE') return deleteBookingLink(seg[2], request);
  }
  if (seg[0] === 'booking' && seg[1] === 'link' && seg[3] === 'bookings' && m === 'GET') {
    return listLinkBookings(seg[2], request);
  }
  if (seg[0] === 'booking' && seg[1] === 'link' && seg[3] === 'send-invite' && m === 'POST') {
    return sendBookingInviteHandler(seg[2], request);
  }
  if (seg[0] === 'booking' && seg[1] === 'invite' && seg.length === 3 && m === 'GET') {
    return getBookingInviteHandler(seg[2]);
  }
  if (seg[0] === 'booking' && seg[1] === 'booking' && seg.length === 3 && m === 'DELETE') {
    return cancelBookingHandler(seg[2], request);
  }
  if (seg[0] === 'booking' && seg[1] === 'booking' && seg.length === 3 && m === 'PUT') {
    return updateBookingStatusHandler(seg[2], request);
  }
  if (seg[0] === 'booking' && seg[1] === 'booking' && seg[3] === 'fetch-recording' && m === 'POST') {
    return fetchBookingRecording(seg[2], request);
  }
  if (seg[0] === 'booking' && seg[1] === 'booking' && seg[3] === 'recording-url' && m === 'GET') {
    return getBookingRecordingUrl(seg[2], request);
  }
  // Public routes (no admin key required)
  if (seg[0] === 'booking' && seg[1] === 'slots' && seg.length === 3 && m === 'GET') {
    return getBookingSlots(seg[2]);
  }
  if (seg[0] === 'booking' && seg[1] === 'book' && seg.length === 3 && m === 'POST') {
    return createBookingHandler(seg[2], request);
  }

  // ── Question Templates ───────────────────────────────────────
  if (seg[0] === 'templates' && seg.length === 1 && m === 'GET') {
    return listTemplates(request);
  }
  if (seg[0] === 'questions' && seg[1] === 'generate' && m === 'POST') {
    return generateQuestions(request);
  }

  // ── Reminder trigger (manual / external cron) ────────────────
  if (seg[0] === 'reminders' && seg[1] === 'run' && m === 'POST') {
    await requireAdmin(request);
    const result = await handleScheduled();
    return jsonRes(result);
  }

  // ── Recruiter / Calendar-Sync Settings ──────────────────────
  if (seg[0] === 'recruiter' && seg[1] === 'settings' && seg.length === 2) {
    if (m === 'GET') return getRecruiterSettings(request);
    if (m === 'PUT') return updateRecruiterSettings(request);
  }
  if (seg[0] === 'recruiter' && seg[1] === 'calendars' && seg[2] === 'test' && m === 'POST') {
    return testLinkedCalendar(request);
  }
  // Per-recruiter linked calendars (each user manages their own busy-time cross-checks)
  if (seg[0] === 'me' && seg[1] === 'calendars' && seg.length === 2) {
    if (m === 'GET') return getMyCalendars(request);
    if (m === 'PUT') return setMyCalendars(request);
  }

  // ── Holiday & Closure Settings ───────────────────────────────
  // /api/holidays/settings  (must be before /api/holidays length-1 catch-all)
  if (seg[0] === 'holidays' && seg[1] === 'settings') {
    if (m === 'GET') return getHolidaySettings(request);
    if (m === 'PUT') return updateHolidaySettings(request);
  }
  // /api/holidays/sync
  if (seg[0] === 'holidays' && seg[1] === 'sync' && m === 'POST') {
    return syncNationalHolidays(request);
  }
  // /api/holidays  (list / create)
  if (seg[0] === 'holidays' && seg.length === 1) {
    if (m === 'GET')  return listHolidays(request);
    if (m === 'POST') return createHoliday(request);
  }
  // /api/holiday/{id}  (update / delete)
  if (seg[0] === 'holiday' && seg.length === 2) {
    if (m === 'PUT')    return updateHoliday(seg[1], request);
    if (m === 'DELETE') return deleteHoliday(seg[1], request);
  }

  return jsonRes({ error: 'Not found' }, 404);
}

// ── Helpers ───────────────────────────────────────────────────

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// Constant-time string compare — avoids leaking the admin key via response timing.
// Compares over the longer length and folds in a length mismatch so it can't
// early-exit on the first differing/shorter character.
function constTimeEq(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// Resolve the active user from either a Microsoft SSO session (X-Auth-Token) or
// the shared ADMIN_KEY (break-glass super-admin). Returns the user object or null.
async function resolveUser(request) {
  const authTok = request.headers.get('X-Auth-Token');
  if (authTok) {
    const s = await kvGet(`authsession:${authTok}`);
    if (s && s.expiresAt > Date.now()) {
      const u = await kvGet(`user:${s.userId}`);
      if (u && u.active !== false) return u;
    }
    return null;
  }
  if (constTimeEq(request.headers.get('X-Admin-Key'), ADMIN_KEY)) {
    return { id: 'admin', role: 'super_admin', name: 'Administrator', email: EMAIL_SENDER, breakGlass: true };
  }
  return null;
}

// Any authenticated user passes (per-user data isolation is layered on in Phase 2);
// returns the user so handlers can stamp/scope ownership.
async function requireAdmin(request) {
  const user = await resolveUser(request);
  if (!user) throw new Error('Unauthorized');
  return user;
}

// User/invite management is restricted to super_admins (and the break-glass key).
async function requireSuperAdmin(request) {
  const user = await requireAdmin(request);
  if (user.role !== 'super_admin') throw new Error('Forbidden');
  return user;
}

// Phase 2 ownership check: super_admin sees everything; a recruiter only their own
// records. Legacy records with no ownerId are visible to super_admin only.
// Per-recruiter visibility scope (set by a super_admin on the Team page):
//   'own'        — only records the recruiter created (default)
//   'view_all'   — can SEE every recruiter's records, but edit/delete only own
//   'manage_all' — full access to all records, like an administrator
// mode: 'view' for read/list/recording-access; 'manage' for edit/delete/cancel.
function canAccess(record, user, mode = 'manage') {
  if (!record || !user) return false;
  if (user.role === 'super_admin') return true;
  const scope = user.viewScope || 'own';
  if (scope === 'manage_all') return true;
  if (scope === 'view_all' && mode === 'view') return true;
  if (record.ownerId === user.id) return true;
  // Explicitly shared with this user (interview-level "add visibility").
  if (Array.isArray(record.sharedWith) && record.sharedWith.includes(user.id)) return true;
  return false;
}

// Phase 3 — dynamic calendar routing. Resolves which mailbox a record's Teams
// meetings, calendar events, and recordings route to: the OWNING recruiter's
// calendarEmail, falling back to the shared corporate mailbox for legacy/unowned
// records or the break-glass admin.
async function resolveOwnerCalendarEmail(ownerId) {
  if (ownerId && ownerId !== 'admin') {
    const u = await kvGet(`user:${ownerId}`);
    if (u && (u.calendarEmail || u.email)) return u.calendarEmail || u.email;
  }
  return EMAIL_SENDER || ONEDRIVE_USER;
}

// Decode a JWT payload (id_token from Microsoft's token endpoint — already trusted
// over TLS via our client secret, so no JWKS signature check needed here).
function decodeJwt(jwt) {
  const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

const SSO_REDIRECT_URI = 'https://interview-api.putuastrawijaya.workers.dev/api/auth/callback';
const SSO_ADMIN_HOME   = 'https://interview-portal.putuastrawijaya.workers.dev/admin';
const ALLOWED_EMAIL_DOMAIN = 'cti-usa.com';

// Begin SSO: redirect the browser to Microsoft sign-in.
async function authLogin(request) {
  const state = uid();
  await INTERVIEW_DATA.put(`authstate:${state}`, '1', { expirationTtl: 600 });
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?` + new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', redirect_uri: SSO_REDIRECT_URI,
    response_mode: 'query', scope: 'openid profile email', state,
  });
  return new Response(null, { status: 302, headers: { Location: url } });
}

function ssoError(msg) {
  return new Response(
    `<!doctype html><meta charset=utf-8><body style="font-family:Arial;background:#0F172A;color:#fff;text-align:center;padding:60px">
       <h2>Sign-in failed</h2><p style="color:#94A3B8">${msg}</p>
       <p><a href="${SSO_ADMIN_HOME}" style="color:#B01A18">Back to ZeusHire</a></p></body>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

// SSO callback: exchange code → id_token, provision the user, create a session,
// redirect back to the admin with the session token in the URL fragment.
async function authCallback(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code) return ssoError('No authorization code returned.');
  if (!state || !(await kvGet(`authstate:${state}`))) return ssoError('Invalid or expired sign-in request.');
  await INTERVIEW_DATA.delete(`authstate:${state}`);

  const tokenRes = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code,
      redirect_uri: SSO_REDIRECT_URI, grant_type: 'authorization_code', scope: 'openid profile email',
    }),
  });
  if (!tokenRes.ok) { console.error('[sso] token', await tokenRes.text().catch(() => '')); return ssoError('Could not complete sign-in.'); }
  const tok = await tokenRes.json();

  let claims;
  try { claims = decodeJwt(tok.id_token); } catch { return ssoError('Invalid identity token.'); }
  if (claims.tid !== TENANT_ID) return ssoError('This sign-in is not from the CTI organization.');
  const email = String(claims.preferred_username || claims.email || '').toLowerCase();
  if (!email.endsWith('@' + ALLOWED_EMAIL_DOMAIN)) return ssoError(`Only @${ALLOWED_EMAIL_DOMAIN} accounts can sign in.`);
  const oid = claims.oid || claims.sub;
  const name = claims.name || email;

  let user = await kvGet(`user:${oid}`);
  if (!user) {
    // INVITE-ONLY: the very first ever sign-in bootstraps the super_admin.
    // Everyone after that must have a pending invite created by a super_admin.
    const list = (await kvGet('user:list')) || [];
    const isBootstrap = list.length === 0;
    const invite = await kvGet(`invite:${email}`);
    if (!isBootstrap && !invite) {
      return ssoError(`Your account hasn't been invited to ZeusHire yet. Please ask an administrator to invite ${email}, then try again.`);
    }
    const role = isBootstrap ? 'super_admin' : (invite?.role || 'recruiter');
    const viewScope = isBootstrap ? 'manage_all' : (invite?.viewScope || 'own');
    user = { id: oid, email, name, calendarEmail: email, role, viewScope, createdAt: Date.now(), active: true, invitedBy: invite?.invitedBy || null };
    list.push(oid); await kvPut('user:list', list);
    await kvPut(`user:byEmail:${email}`, oid);
    // Consume the invite so it can't be reused.
    if (invite) {
      await INTERVIEW_DATA.delete(`invite:${email}`);
      const il = (await kvGet('invite:list')) || [];
      await kvPut('invite:list', il.filter(e => e !== email));
    }
  } else {
    if (user.active === false) return ssoError('Your ZeusHire access has been disabled. Please contact your administrator.');
    user.name = name; user.email = email; if (!user.calendarEmail) user.calendarEmail = email;
  }
  await kvPut(`user:${oid}`, user);

  const sessionToken = uid();
  await INTERVIEW_DATA.put(`authsession:${sessionToken}`,
    JSON.stringify({ userId: oid, createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 3600 * 1000 }),
    { expirationTtl: 7 * 24 * 3600 });

  return new Response(null, { status: 302, headers: { Location: `${SSO_ADMIN_HOME}#authToken=${sessionToken}` } });
}

async function authMe(request) {
  const user = await resolveUser(request);
  if (!user) return jsonRes({ authenticated: false }, 401);
  return jsonRes({ authenticated: true, user: { name: user.name, email: user.email, role: user.role, viewScope: user.viewScope || 'own', breakGlass: !!user.breakGlass } });
}

async function authLogout(request) {
  const t = request.headers.get('X-Auth-Token');
  if (t) await INTERVIEW_DATA.delete(`authsession:${t}`);
  return jsonRes({ ok: true });
}

// ── Audit log ─────────────────────────────────────────────────
// Best-effort append-only record of sensitive admin actions (access/ownership
// changes). Capped to the most recent 500 entries. Never throws.
async function logAudit(actor, action, detail) {
  try {
    const entry = {
      ts: Date.now(),
      by: (actor && (actor.email || actor.id)) || 'unknown',
      action,
      detail: detail || '',
    };
    const log = (await kvGet('audit:log')) || [];
    log.unshift(entry);
    if (log.length > 500) log.length = 500;
    await kvPut('audit:log', log);
  } catch (e) { console.error('[audit] failed:', e.message); }
}

async function getAuditLog(request) {
  await requireSuperAdmin(request);
  const log = (await kvGet('audit:log')) || [];
  return jsonRes({ entries: log.slice(0, 200) });
}

// ── Team management (super_admin only) ────────────────────────
// Returns active users + pending (not-yet-logged-in) invites.
async function listUsers(request) {
  const me = await requireSuperAdmin(request);
  const ids = (await kvGet('user:list')) || [];
  const users = (await Promise.all(ids.map(id => kvGet(`user:${id}`)))).filter(Boolean).map(u => ({
    id: u.id, name: u.name, email: u.email, role: u.role,
    viewScope: u.viewScope || 'own',
    active: u.active !== false, calendarEmail: u.calendarEmail || u.email,
    createdAt: u.createdAt || 0, isMe: u.id === me.id,
  }));
  const inviteEmails = (await kvGet('invite:list')) || [];
  const invites = (await Promise.all(inviteEmails.map(e => kvGet(`invite:${e}`)))).filter(Boolean);
  return jsonRes({ users, invites });
}

// Lightweight active-user list (id/name/email) — powers the owner/share
// pickers. Super Admin only (sharing/transfer is a Super-Admin action).
async function listUsersBasic(request) {
  await requireSuperAdmin(request);
  const ids = (await kvGet('user:list')) || [];
  const users = (await Promise.all(ids.map(id => kvGet(`user:${id}`)))).filter(Boolean)
    .filter(u => u.active !== false)
    .map(u => ({ id: u.id, name: u.name || u.email, email: u.email }));
  return jsonRes({ users });
}

// Create a pending invite for an @cti-usa.com email. They gain access on first SSO login.
async function inviteUser(request) {
  const me = await requireSuperAdmin(request);
  const body = await request.json();
  const email = String(body.email || '').trim().toLowerCase();
  // Only the original bootstrap account is Super Admin — everyone invited is a Recruiter,
  // with an access scope chosen at invite time (own / view_all / manage_all = "Admin").
  const role  = 'recruiter';
  const viewScope = ['own', 'view_all', 'manage_all'].includes(body.viewScope) ? body.viewScope : 'own';
  if (!email) return jsonRes({ error: 'email required' }, 400);
  if (!email.endsWith('@' + ALLOWED_EMAIL_DOMAIN)) {
    return jsonRes({ error: `Only @${ALLOWED_EMAIL_DOMAIN} addresses can be invited.` }, 400);
  }
  const existingId = await kvGet(`user:byEmail:${email}`);
  if (existingId) return jsonRes({ error: 'That person already has an account.' }, 409);

  const invite = { email, role, viewScope, invitedBy: me.email || me.id, invitedByName: me.name || '', invitedAt: Date.now() };
  await kvPut(`invite:${email}`, invite);
  const il = (await kvGet('invite:list')) || [];
  if (!il.includes(email)) { il.push(email); await kvPut('invite:list', il); }

  // Notify the invitee so they know to sign in. Best-effort — the invite is
  // valid regardless of whether the email goes through.
  let emailSent = false, emailError = null;
  try { await sendTeamInviteEmail(invite); emailSent = true; }
  catch (e) { emailError = e.message; console.error('[invite] email failed for', email, '-', e.message); }

  await logAudit(me, 'invite_user', `${email} (${viewScope})`);
  return jsonRes({ ...invite, emailSent, emailError }, 201);
}

// Invitation email: tells a new recruiter they've been granted access and links
// them to the ZeusHire admin sign-in (Microsoft SSO).
async function sendTeamInviteEmail(invite) {
  const sender = EMAIL_SENDER;
  const roleLabel = invite.role === 'super_admin' ? 'Administrator' : 'Recruiter';
  const signInUrl = SSO_ADMIN_HOME;
  const html = emailWrap('#B01A18', "You've been invited to ZeusHire", `
    <p style="margin:0 0 16px 0;font-size:15px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif">Hello,</p>
    <p style="margin:0 0 20px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">
      ${htmlEsc(invite.invitedByName || 'An administrator')} has invited you to access <strong>CTI ZeusHire</strong>, the CTI Group recruitment &amp; interview portal, as a <strong>${roleLabel}</strong>.
    </p>
    <p style="margin:0 0 20px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">
      To get started, click the button below and sign in with your CTI Microsoft account (<strong>${htmlEsc(invite.email)}</strong>). No separate password is needed.
    </p>
    ${emailButton(signInUrl, 'Sign in to ZeusHire')}
    <p style="margin:24px 0 4px 0;color:#6b7280;font-size:12px;text-align:center;font-family:Arial,Helvetica,sans-serif">Or copy this link:</p>
    <p style="margin:0;color:#6b7280;font-size:12px;text-align:center;word-break:break-all;font-family:Arial,Helvetica,sans-serif"><a href="${signInUrl}" style="color:#B01A18;text-decoration:underline">${signInUrl}</a></p>
  `);

  const accessToken = await getAccessToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: 'Your CTI ZeusHire access',
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ZeusHire', address: sender } },
        toRecipients: [{ emailAddress: { address: invite.email } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Email failed: ' + (err.error?.message || res.status));
  }
}

// Revoke a pending invite (before the person has logged in).
async function revokeInvite(email, request) {
  const me = await requireSuperAdmin(request);
  email = String(email || '').trim().toLowerCase();
  await INTERVIEW_DATA.delete(`invite:${email}`);
  const il = (await kvGet('invite:list')) || [];
  await kvPut('invite:list', il.filter(e => e !== email));
  await logAudit(me, 'revoke_invite', email);
  return jsonRes({ ok: true });
}

// Change an existing user's role or enable/disable their access.
async function updateUser(userId, request) {
  const me = await requireSuperAdmin(request);
  const user = await kvGet(`user:${userId}`);
  if (!user) return jsonRes({ error: 'User not found' }, 404);
  const body = await request.json();

  // Guard: don't let the last active super_admin demote or disable themselves out of access.
  const wouldLoseAdmin =
    (body.role && body.role !== 'super_admin' && user.role === 'super_admin') ||
    (body.active === false && user.role === 'super_admin');
  if (wouldLoseAdmin) {
    const ids = (await kvGet('user:list')) || [];
    const all = (await Promise.all(ids.map(id => kvGet(`user:${id}`)))).filter(Boolean);
    const otherActiveAdmins = all.filter(u => u.id !== userId && u.role === 'super_admin' && u.active !== false);
    if (otherActiveAdmins.length === 0) {
      return jsonRes({ error: 'Cannot remove the last administrator. Promote someone else first.' }, 409);
    }
  }

  if (body.role === 'super_admin') return jsonRes({ error: 'Only one Super Admin is allowed.' }, 409);
  if (body.role === 'recruiter') user.role = 'recruiter';
  if (['own', 'view_all', 'manage_all'].includes(body.viewScope)) user.viewScope = body.viewScope;
  if (typeof body.active === 'boolean') user.active = body.active;
  if (body.calendarEmail !== undefined) user.calendarEmail = String(body.calendarEmail || '').trim().toLowerCase() || user.email;
  await kvPut(`user:${userId}`, user);

  await logAudit(me, 'update_user', `${user.email}: role=${user.role}, scope=${user.viewScope || 'own'}, active=${user.active !== false}`);
  // If access was revoked, kill any live sessions belonging to this user is best-effort
  // (sessions self-expire and resolveUser re-checks active flag on every request, so a
  // disabled user is locked out on their next API call regardless).
  return jsonRes({ id: user.id, name: user.name, email: user.email, role: user.role, viewScope: user.viewScope || 'own', active: user.active !== false });
}

// Permanently remove a user account. Their owned records remain in KV (reassignable later).
async function deleteUser(userId, request) {
  const me = await requireSuperAdmin(request);
  if (userId === me.id) return jsonRes({ error: 'You cannot delete your own account.' }, 409);
  const user = await kvGet(`user:${userId}`);
  if (!user) return jsonRes({ error: 'User not found' }, 404);
  if (user.role === 'super_admin') {
    const ids = (await kvGet('user:list')) || [];
    const all = (await Promise.all(ids.map(id => kvGet(`user:${id}`)))).filter(Boolean);
    const otherActiveAdmins = all.filter(u => u.id !== userId && u.role === 'super_admin' && u.active !== false);
    if (otherActiveAdmins.length === 0) {
      return jsonRes({ error: 'Cannot delete the last administrator.' }, 409);
    }
  }
  await INTERVIEW_DATA.delete(`user:${userId}`);
  if (user.email) await INTERVIEW_DATA.delete(`user:byEmail:${user.email}`);
  const ids = (await kvGet('user:list')) || [];
  await kvPut('user:list', ids.filter(id => id !== userId));
  await logAudit(me, 'delete_user', user.email);
  return jsonRes({ ok: true });
}

// Phase 4 — record ownership assignment (super_admin only).
//   body.ownerId : the user to assign records to (defaults to the caller / bootstrap admin).
//   body.force   : when true, REASSIGNS every record (even ones that already have an
//                  owner). When false/absent, only fills records that have no owner yet
//                  (the safe "backfill legacy records" behavior).
// In all cases organizerEmail is only set when MISSING — it points at the mailbox where
// a record's calendar event/recording physically lives, so reassigning ownership never
// breaks recording playback.
async function backfillOwner(request) {
  const me = await requireSuperAdmin(request);
  const body = await request.json().catch(() => ({}));
  const force = body.force === true;

  // Resolve the target owner id (must be a real user for calendar routing).
  let targetId = body.ownerId || me.id;
  if (targetId === 'admin') {
    const uids = (await kvGet('user:list')) || [];
    const all  = (await Promise.all(uids.map(id => kvGet(`user:${id}`)))).filter(Boolean);
    const sa   = all.find(u => u.role === 'super_admin' && u.active !== false);
    if (sa) targetId = sa.id;
  } else {
    // Validate the target is a real, known user.
    const target = await kvGet(`user:${targetId}`);
    if (!target) return jsonRes({ error: 'Target user not found.' }, 404);
  }

  const counts = { interviews: 0, sessions: 0, twSessions: 0, bookingLinks: 0, bookings: 0 };

  // Interviews + their one-way sessions
  const interviewIds = (await kvGet('interview:list')) || [];
  for (const iid of interviewIds) {
    const iv = await kvGet(`interview:${iid}`);
    if (iv && (force || !iv.ownerId)) { iv.ownerId = targetId; await kvPut(`interview:${iid}`, iv); counts.interviews++; }
    const tokens = (await kvGet(`interview:${iid}:sessions`)) || [];
    for (const tk of tokens) {
      const s = await kvGet(`session:${tk}`);
      if (s && (force || !s.ownerId)) { s.ownerId = (iv && iv.ownerId) || targetId; await kvPut(`session:${tk}`, s); counts.sessions++; }
    }
  }

  // Two-way (direct invite) sessions
  const twIds = (await kvGet('tw-session:list')) || [];
  for (const id of twIds) {
    const s = await kvGet(`tw-session:${id}`);
    if (s && (force || !s.ownerId)) {
      s.ownerId = targetId;
      if (!s.organizerEmail) s.organizerEmail = EMAIL_SENDER; // legacy meetings live in the shared mailbox
      await kvPut(`tw-session:${id}`, s); counts.twSessions++;
    }
  }

  // Booking links + their bookings
  const linkTokens = (await kvGet('booking:link:list')) || [];
  for (const t of linkTokens) {
    const link = await kvGet(`booking:link:${t}`);
    if (link && (force || !link.ownerId)) { link.ownerId = targetId; await kvPut(`booking:link:${t}`, link); counts.bookingLinks++; }
    const bids = (await kvGet(`booking:link:${t}:bookings`)) || [];
    for (const bid of bids) {
      const b = await kvGet(`booking:booking:${bid}`);
      if (b && (force || !b.ownerId || !b.organizerEmail)) {
        if (force || !b.ownerId) b.ownerId = (link && link.ownerId) || targetId;
        if (!b.organizerEmail) b.organizerEmail = EMAIL_SENDER; // legacy events/recordings live in the shared mailbox
        await kvPut(`booking:booking:${bid}`, b); counts.bookings++;
      }
    }
  }

  await logAudit(me, force ? 'reassign_all_records' : 'assign_unowned_records',
    `to ${targetId} (${counts.interviews} interviews, ${counts.sessions} sessions, ${counts.twSessions} two-way, ${counts.bookingLinks} links, ${counts.bookings} bookings)`);
  return jsonRes({ ok: true, ownerId: targetId, force, updated: counts });
}

// ── Brute-force throttle for the admin key ────────────────────
// Only counts requests that PRESENT an X-Admin-Key header that is WRONG, keyed by
// client IP. Candidate/public traffic (no key) and correct logins are never touched,
// so there are no false positives. After AUTH_FAIL_LIMIT wrong attempts within
// AUTH_FAIL_WINDOW seconds, the IP is blocked from further admin attempts until the
// window lapses. (KV is eventually-consistent — adequate for brute-force defence.)
const AUTH_FAIL_LIMIT  = 10;
const AUTH_FAIL_WINDOW = 900; // 15 minutes

async function authFailCount(ip) {
  const v = await INTERVIEW_DATA.get(`rl:authfail:${ip}`);
  return v ? parseInt(v, 10) || 0 : 0;
}
async function recordAuthFail(ip) {
  const n = (await authFailCount(ip)) + 1;
  // TTL refreshes on each failure → block persists 15 min past the LAST attempt.
  await INTERVIEW_DATA.put(`rl:authfail:${ip}`, String(n), { expirationTtl: AUTH_FAIL_WINDOW });
}

// HTML-escape any value interpolated into email/HTML markup so candidate- or
// recruiter-supplied text (e.g. names, titles) can't inject markup.
function htmlEsc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function uid() {
  return crypto.randomUUID();
}

// True when a session has a deadline that has passed. Used to enforce expiry
// SERVER-SIDE on candidate write endpoints (the client already shows an expired
// screen, but that's cosmetic — the API must reject late writes too).
function sessionExpired(session) {
  return !!(session.expiresAt && Date.now() > session.expiresAt);
}

// Assessment-only = no video questions (only text/MCQ) → emails say "assessment".
function interviewIsAssessmentOnly(interview) {
  const qs = interview?.questions || [];
  return qs.length > 0 && qs.every(q => (q.answerType || 'video') !== 'video');
}

// Canonical host for the static site. Reminder emails build the candidate link
// from this + the session token, so the link is always present and always points
// at the live host (independent of any stored interviewLink).
const CANONICAL_LINK_BASE = 'https://interview-portal.putuastrawijaya.workers.dev';
function takeUrlFor(token) {
  return `${CANONICAL_LINK_BASE}/take.html?token=${token}`;
}

// ── Question Templates ────────────────────────────────────────

const QUESTION_TEMPLATES_DATA = [
  {
    id: 'general',
    category: 'General Behavioral',
    questions: [
      { text: 'Tell me about yourself and what makes you a strong candidate for this role.', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'Describe a challenging situation you faced at work or school and how you resolved it.', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'What are your greatest strengths, and how do they apply to this position?', duration: 90, thinkTime: 30, maxRetakes: 1 },
      { text: 'Where do you see yourself professionally in 3–5 years?', duration: 90, thinkTime: 30, maxRetakes: 1 },
      { text: 'Why are you interested in working with CTI Group and what motivated you to apply?', duration: 90, thinkTime: 30, maxRetakes: 1 },
    ],
  },
  {
    id: 'sales',
    category: 'Sales & Business Development',
    questions: [
      { text: 'Tell me about a time you exceeded a sales target. What was your approach?', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'How do you handle a prospect who says they\'re not interested? Walk me through your response.', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'Describe your process for researching a new prospect before a cold call or meeting.', duration: 90, thinkTime: 30, maxRetakes: 1 },
      { text: 'Tell me about your most challenging sale. What obstacles did you face and how did you close the deal?', duration: 120, thinkTime: 30, maxRetakes: 1 },
    ],
  },
  {
    id: 'engineering',
    category: 'Engineering & Technical',
    questions: [
      { text: 'Walk me through a complex technical problem you solved. What was your thought process?', duration: 180, thinkTime: 30, maxRetakes: 1 },
      { text: 'How do you stay current with new technologies and industry trends?', duration: 90, thinkTime: 30, maxRetakes: 1 },
      { text: 'Describe a time you had to learn a new technology quickly. How did you approach it?', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'Tell me about a project where you had to balance technical quality with delivery deadlines.', duration: 120, thinkTime: 30, maxRetakes: 1 },
    ],
  },
  {
    id: 'customer-service',
    category: 'Customer Service',
    questions: [
      { text: 'Describe a time you turned a frustrated customer into a satisfied one. What did you do?', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'How do you prioritize when you have multiple customer requests at the same time?', duration: 90, thinkTime: 30, maxRetakes: 1 },
      { text: 'Tell me about a time you went above and beyond for a customer. What was the outcome?', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'How do you handle a situation where you do not know the answer to a customer\'s question?', duration: 90, thinkTime: 30, maxRetakes: 1 },
    ],
  },
  {
    id: 'marketing',
    category: 'Marketing & Communications',
    questions: [
      { text: 'Tell me about a marketing campaign you worked on. What was your role and what were the results?', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'How do you approach creating content for different target audiences?', duration: 90, thinkTime: 30, maxRetakes: 1 },
      { text: 'Describe a time you used data or analytics to improve a marketing strategy.', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'What social media platforms do you have experience with, and how have you grown an audience?', duration: 90, thinkTime: 30, maxRetakes: 1 },
    ],
  },
  {
    id: 'hr',
    category: 'HR & Operations',
    questions: [
      { text: 'Describe your experience with recruitment. Walk me through your typical hiring process.', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'How do you handle a situation where two team members have a conflict? Walk me through your approach.', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'Tell me about a process improvement you implemented. What was the impact?', duration: 120, thinkTime: 30, maxRetakes: 1 },
      { text: 'How do you ensure compliance with company policies and employment regulations?', duration: 90, thinkTime: 30, maxRetakes: 1 },
    ],
  },
];

async function listTemplates(request) {
  await requireAdmin(request);
  return jsonRes(QUESTION_TEMPLATES_DATA);
}

// Shared text LLM completion via Groq (OpenAI-compatible, free tier). Returns
// the assistant's text. Throws on error.
async function groqChat(prompt, maxTokens = 1024) {
  if (typeof GROQ_API_KEY === 'undefined' || !GROQ_API_KEY) throw new Error('GROQ_API_KEY is not configured');
  const key = (GROQ_API_KEY || '').replace(/[^\x21-\x7E]/g, '');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || ('Groq error ' + res.status));
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function generateQuestions(request) {
  await requireAdmin(request);
  const { jobTitle, jobDescription, count = 5 } = await request.json();
  if (!jobTitle) return jsonRes({ error: 'jobTitle required' }, 400);

  const prompt = `You are an expert recruiter. Generate exactly ${count} interview questions for the role: "${jobTitle}".
${jobDescription ? `\nJob context:\n${jobDescription}\n` : ''}
Make questions behavioral, situational, and specific to this role. Mix easy and harder questions.
Respond with ONLY valid JSON — no commentary:
{
  "questions": [
    { "text": "Question text here?", "duration": 90, "thinkTime": 30, "maxRetakes": 1 }
  ]
}
Duration: 60–180s based on complexity. thinkTime: 15–30s. maxRetakes: 1.`;

  let raw;
  try { raw = await groqChat(prompt, 1024); }
  catch (e) { return jsonRes({ error: 'AI error: ' + e.message }, 500); }
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    return jsonRes(JSON.parse(match ? match[0] : raw));
  } catch {
    return jsonRes({ error: 'Failed to parse AI response. Raw: ' + raw.slice(0, 200) }, 500);
  }
}

// ── Scheduled handler (cron + manual trigger) ─────────────────

async function handleScheduled() {
  const now = Date.now();
  let sentTotal = 0, errors = 0;

  const interviewIds = (await kvGet('interview:list')) || [];

  for (const iid of interviewIds) {
    const tokens = (await kvGet(`interview:${iid}:sessions`)) || [];
    for (const token of tokens) {
      const session = await kvGet(`session:${token}`);

      // Skip: no deadline, no frequency, already completed, no email, past deadline
      if (!session?.expiresAt || !session.nextReminderAt) continue;
      if (session.status !== 'pending')     continue;
      if (!session.candidateEmail)          continue;
      if (now > session.expiresAt)          continue; // deadline passed

      // Is it time to fire?
      if (now < session.nextReminderAt) continue;

      try {
        await sendReminderEmail(session);

        // Advance to next reminder, skip past any missed intervals
        const freqMs   = (session.reminderFrequency || 24) * 60 * 60 * 1000;
        let   nextTime = session.nextReminderAt + freqMs;
        // If multiple intervals were missed (e.g. worker was down), catch up to now+freq
        while (nextTime < now) nextTime += freqMs;

        // Don't schedule past the deadline
        session.nextReminderAt = nextTime <= session.expiresAt ? nextTime : null;
        await kvPut(`session:${token}`, session);
        sentTotal++;
      } catch (e) {
        console.error(`[reminders] email failed for ${token}:`, e.message);
        errors++;
      }
    }
  }

  // Data-retention purge (no-op unless retentionDays is configured). Wrapped so
  // a purge failure never affects reminder delivery.
  let retention = { enabled: false, purged: 0 };
  try { retention = await purgeExpiredData(); }
  catch (e) { console.error('[retention] purge failed:', e.message); }

  return { ok: true, sentTotal, errors, retention };
}

// Manual reminder: admin clicks "Remind now" for a single pending candidate.
// Bypasses the schedule entirely (does not touch nextReminderAt).
async function remindSessionNow(token, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session)                       return jsonRes({ error: 'Session not found' }, 404);
  if (!session.candidateEmail)        return jsonRes({ error: 'No email address for this candidate' }, 400);
  if (session.status !== 'pending' && session.status !== 'in_progress')
    return jsonRes({ error: 'Candidate has already completed the interview' }, 400);
  try {
    await sendReminderEmail(session);
    return jsonRes({ ok: true });
  } catch (e) {
    return jsonRes({ error: e.message }, 502);
  }
}

async function sendReminderEmail(session) {
  const interview = await kvGet(`interview:${session.interviewId}`);
  const interviewTitle = interview?.title || 'Interview';
  const assessOnly = interviewIsAssessmentOnly(interview);
  const noun = assessOnly ? 'assessment' : 'interview';
  const Noun = assessOnly ? 'Assessment' : 'Interview';
  // Deadline is optional (manual reminders may have none) — degrade gracefully.
  const hasDeadline = !!session.expiresAt;
  const deadline = hasDeadline ? new Date(session.expiresAt).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }) : null;
  // Compute how many days are left at send time
  const daysLeft = hasDeadline
    ? Math.max(1, Math.ceil((session.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;
  const label    = daysLeft === null ? null : (daysLeft === 1 ? '1 Day' : `${daysLeft} Days`);

  // Always build the candidate link from the canonical host + token, so the
  // reminder has a working button even when no interviewLink was ever stored.
  const link = takeUrlFor(session.token);

  const html = emailWrap('#B01A18', `CTI ZeusHire — ${Noun} Reminder`, `
    <p style="margin:0 0 16px 0;font-size:15px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif">Dear <strong>${htmlEsc(session.candidateName)}</strong>,</p>
    <p style="margin:0 0 16px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">
      ${hasDeadline
        ? `This is a friendly reminder that your ${noun} is due in <strong>${label}</strong>.`
        : `This is a friendly reminder to complete your ${noun}.`}
    </p>
    ${emailInfoBox('#B01A18', htmlEsc(interviewTitle), hasDeadline ? `Deadline: ${deadline}` : '')}
    <p style="margin:0 0 16px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">
      Please complete your ${noun} before the deadline to be considered for this opportunity.
    </p>
    ${link ? emailButton(link, assessOnly ? 'Complete My Assessment' : 'Complete My Interview') : ''}
    ${link ? `
    <p style="margin:16px 0 4px 0;color:#6b7280;font-size:12px;font-family:Arial,Helvetica,sans-serif">Or copy this link into your browser:</p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td bgcolor="#f3f4f6" style="background-color:#f3f4f6;padding:10px;word-break:break-all">
        <p style="margin:0;color:#6b7280;font-size:12px;font-family:Arial,Helvetica,sans-serif;word-break:break-all">${link}</p>
      </td>
    </tr></table>
    ` : ''}
    <p style="margin:20px 0 0 0;color:#9ca3af;font-size:12px;font-family:Arial,Helvetica,sans-serif">
      If you have already completed your ${noun}, please disregard this reminder.
    </p>
  `);

  const sender = EMAIL_SENDER;
  const accessToken = await getAccessToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: hasDeadline
          ? `Reminder: Complete your ${interviewTitle} ${noun} — ${label} Left`
          : `Reminder: Complete your ${interviewTitle} ${noun}`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ZeusHire', address: sender } },
        toRecipients: [{ emailAddress: { address: session.candidateEmail } }],
      },
      saveToSentItems: true,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Email failed: ' + (err.error?.message || res.status));
  }
}

// ─────────────────────────────────────────────────────────────

async function kvGet(key) {
  const v = await INTERVIEW_DATA.get(key);
  return v ? JSON.parse(v) : null;
}

async function kvPut(key, value) {
  await INTERVIEW_DATA.put(key, JSON.stringify(value));
}

// ── Microsoft Graph ───────────────────────────────────────────

async function getAccessToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope:         'https://graph.microsoft.com/.default',
      }),
    }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get Microsoft access token');
  return data.access_token;
}

async function uploadToOneDrive(filePath, blob, accessToken, contentType) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const sessionUrl = `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/root:/${encodedPath}:/createUploadSession`;

  // Create upload session
  const sessionRes = await fetch(sessionUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      item: { '@microsoft.graph.conflictBehavior': 'replace' },
    }),
  });

  const session = await sessionRes.json();
  if (!session.uploadUrl) throw new Error('Could not create OneDrive upload session');

  // Upload file in one PUT (works up to ~150MB)
  const size = blob.byteLength;
  const uploadRes = await fetch(session.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(size),
      'Content-Range': `bytes 0-${size - 1}/${size}`,
      'Content-Type': contentType || 'video/webm',
    },
    body: blob,
  });

  if (!uploadRes.ok) throw new Error('OneDrive upload failed: ' + uploadRes.status);
  return await uploadRes.json(); // file item with id, webUrl, etc.
}

// ── Interview handlers ────────────────────────────────────────

async function createInterview(request) {
  const user = await requireAdmin(request);
  const { title, description, questions } = await request.json();
  if (!title || !questions?.length) return jsonRes({ error: 'title and questions required' }, 400);

  const id = uid();
  const interview = { id, title, description: description || '', questions, createdAt: Date.now(), ownerId: user.id };
  await kvPut(`interview:${id}`, interview);

  const list = (await kvGet('interview:list')) || [];
  list.unshift(id);
  await kvPut('interview:list', list);

  return jsonRes(interview, 201);
}

// Aggregated metrics for the Dashboard. Honors the caller's visibility scope.
// Reads are parallelized (Promise.all) and the result is cached 60s per
// viewer, so it loads fast even with thousands of sessions.
async function getAnalytics(request) {
  const user = await requireAdmin(request);

  const cacheKey = `analytics:cache:${user.id || 'admin'}:${user.role}:${user.viewScope || 'own'}`;
  const cached = await kvGet(cacheKey);
  if (cached && cached.at && (Date.now() - cached.at) < 60000) return jsonRes(cached.data);

  let invited = 0, pending = 0, inProgress = 0, completed = 0, consent = 0;
  let forward = 0, notForward = 0, undecided = 0;
  let completeMsSum = 0, completeMsCount = 0;
  const starDist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const perInterview = [];

  // One-way: fetch interviews in parallel, keep accessible ones, then fetch
  // each interview's sessions in parallel.
  const interviewIds = (await kvGet('interview:list')) || [];
  const interviews = await Promise.all(interviewIds.map(id => kvGet(`interview:${id}`)));
  const accessible = interviews.filter(iv => iv && canAccess(iv, user, 'view'));
  const tokenLists = await Promise.all(accessible.map(iv => kvGet(`interview:${iv.id}:sessions`)));

  await Promise.all(accessible.map(async (iv, idx) => {
    const tokens = tokenLists[idx] || [];
    const sessions = (await Promise.all(tokens.map(t => kvGet(`session:${t}`)))).filter(Boolean);
    let ivTotal = 0, ivCompleted = 0, ivForward = 0;
    for (const s of sessions) {
      invited++; ivTotal++;
      if (s.status === 'completed') { completed++; ivCompleted++; }
      else if (s.status === 'in_progress') inProgress++;
      else pending++;
      if (s.consentedAt) consent++;
      if (s.status === 'completed' && s.completedAt && s.createdAt) {
        completeMsSum += (s.completedAt - s.createdAt); completeMsCount++;
      }
      if (s.reviewDecision === 'move_forward') { forward++; ivForward++; }
      else if (s.reviewDecision === 'not_moving_forward') notForward++;
      else if (s.status === 'completed') undecided++;
      if (s.reviewStars >= 1 && s.reviewStars <= 5) starDist[s.reviewStars]++;
    }
    perInterview.push({ title: iv.title, total: ivTotal, completed: ivCompleted, forward: ivForward });
  }));
  perInterview.sort((a, b) => b.total - a.total);

  // Two-way (direct invite) sessions — parallel.
  const twIds = (await kvGet('tw-session:list')) || [];
  const twSessions = (await Promise.all(twIds.map(id => kvGet(`tw-session:${id}`))))
    .filter(s => s && canAccess(s, user, 'view'));
  let twScheduled = 0, twCompleted = 0, twCancelled = 0;
  for (const s of twSessions) {
    if (s.status === 'completed') twCompleted++;
    else if (s.status === 'cancelled') twCancelled++;
    else twScheduled++;
  }

  // Booking links + confirmed bookings (owner-scoped) — parallel.
  const linkTokens = (await kvGet('booking:link:list')) || [];
  const links = await Promise.all(linkTokens.map(t => kvGet(`booking:link:${t}`)));
  const ownedTokens = linkTokens.filter((t, i) => links[i] && canAccess(links[i], user, 'view'));
  const bookingIdLists = await Promise.all(ownedTokens.map(t => kvGet(`booking:link:${t}:bookings`)));
  const allBookingIds = [...new Set(bookingIdLists.flatMap(ids => ids || []))];
  const allBookings = await Promise.all(allBookingIds.map(id => kvGet(`booking:booking:${id}`)));
  const bookings = allBookings.filter(b => b && b.status !== 'cancelled').length;
  const bookingLinks = ownedTokens.length;

  const premium = ((await kvGet('premium:list')) || []).length;
  const completionRate  = invited ? Math.round((completed / invited) * 100) : 0;
  const avgCompleteHours = completeMsCount ? +((completeMsSum / completeMsCount) / 3600000).toFixed(1) : null;

  const result = {
    oneWay: {
      interviews: perInterview.length, invited, pending, inProgress, completed,
      completionRate, avgCompleteHours, consent,
      decisions: { forward, notForward, undecided }, starDist,
    },
    perInterview: perInterview.slice(0, 10),
    twoWay: { scheduled: twScheduled, completed: twCompleted, cancelled: twCancelled },
    bookings: { confirmed: bookings, links: bookingLinks },
    premium,
  };

  try { await INTERVIEW_DATA.put(cacheKey, JSON.stringify({ at: Date.now(), data: result }), { expirationTtl: 120 }); } catch {}
  return jsonRes(result);
}

async function listInterviews(request) {
  const user = await requireAdmin(request);
  const ids = (await kvGet('interview:list')) || [];
  // Owner/sharing info is Super-Admin-only — build the id→name map just for them.
  const isSuper = user.role === 'super_admin' || !!user.breakGlass;
  let nameOf = () => '';
  if (isSuper) {
    const uids = (await kvGet('user:list')) || [];
    const nameMap = {};
    (await Promise.all(uids.map(uid => kvGet(`user:${uid}`)))).filter(Boolean)
      .forEach(u => { nameMap[u.id] = u.name || u.email; });
    nameOf = oid => !oid ? 'Unassigned' : (nameMap[oid] || (oid === 'admin' ? 'Admin' : 'Unknown'));
  }
  const items = await Promise.all(ids.map(async id => {
    const interview = await kvGet(`interview:${id}`);
    if (!interview) return null;
    if (!canAccess(interview, user, 'view')) return null;   // honors per-recruiter visibility scope
    const tokens = (await kvGet(`interview:${id}:sessions`)) || [];
    const sessions = await Promise.all(tokens.map(t => kvGet(`session:${t}`)));
    const valid = sessions.filter(Boolean);
    interview._counts = {
      total: valid.length,
      pending: valid.filter(s => s.status === 'pending').length,
      inProgress: valid.filter(s => s.status === 'in_progress').length,
      completed: valid.filter(s => s.status === 'completed').length,
    };
    if (isSuper) {
      interview.sharedWith  = interview.sharedWith || [];
      interview.ownerName   = nameOf(interview.ownerId);
      interview.sharedNames = interview.sharedWith.map(nameOf);
      interview._isMine     = interview.ownerId === user.id;
    } else {
      delete interview.sharedWith; // don't leak the sharing list to non-super-admins
    }
    return interview;
  }));
  return jsonRes(items.filter(Boolean));
}

async function getInterview(id, request) {
  const user = await requireAdmin(request);
  const interview = await kvGet(`interview:${id}`);
  if (!interview) return jsonRes({ error: 'Not found' }, 404);
  if (!canAccess(interview, user, 'view')) return jsonRes({ error: 'Forbidden' }, 403);
  return jsonRes(interview);
}

async function updateInterview(id, request) {
  const user = await requireAdmin(request);
  const existing = await kvGet(`interview:${id}`);
  if (!existing) return jsonRes({ error: 'Not found' }, 404);
  if (!canAccess(existing, user)) return jsonRes({ error: 'Forbidden' }, 403);

  const { title, description, questions } = await request.json();
  if (!title || !questions?.length) return jsonRes({ error: 'title and questions required' }, 400);

  const updated = { ...existing, title, description: description || '', questions };
  await kvPut(`interview:${id}`, updated);
  return jsonRes(updated);
}

// Transfer ownership and/or set the shared-with list for an interview.
// Super Admin only.
async function setInterviewAccess(id, request) {
  const user = await requireSuperAdmin(request);
  const iv = await kvGet(`interview:${id}`);
  if (!iv) return jsonRes({ error: 'Not found' }, 404);

  const body = await request.json().catch(() => ({}));
  const changes = [];

  // Transfer ownership
  if (body.ownerId !== undefined && body.ownerId !== null && body.ownerId !== iv.ownerId) {
    const target = await kvGet(`user:${body.ownerId}`);
    if (!target) return jsonRes({ error: 'Unknown user for transfer' }, 400);
    iv.ownerId = body.ownerId;
    // A new owner shouldn't also sit in the shared list.
    if (Array.isArray(iv.sharedWith)) iv.sharedWith = iv.sharedWith.filter(x => x !== body.ownerId);
    changes.push(`owner → ${target.name || target.email}`);
  }

  // Replace the shared-with list (validated, deduped, owner excluded)
  if (Array.isArray(body.sharedWith)) {
    const valid = [];
    for (const sid of [...new Set(body.sharedWith)]) {
      if (!sid || sid === iv.ownerId) continue;
      const u = await kvGet(`user:${sid}`);
      if (u) valid.push(sid);
    }
    iv.sharedWith = valid;
    changes.push(`shared with ${valid.length} user${valid.length !== 1 ? 's' : ''}`);
  }

  await kvPut(`interview:${id}`, iv);
  await logAudit(user, 'interview_access', `${iv.title}: ${changes.join('; ') || 'no change'}`);
  return jsonRes({ ok: true, ownerId: iv.ownerId, sharedWith: iv.sharedWith || [] });
}

async function deleteInterview(id, request) {
  const user = await requireAdmin(request);
  const existing = await kvGet(`interview:${id}`);
  if (existing && !canAccess(existing, user)) return jsonRes({ error: 'Forbidden' }, 403);
  await INTERVIEW_DATA.delete(`interview:${id}`);
  const list = (await kvGet('interview:list')) || [];
  await kvPut('interview:list', list.filter(i => i !== id));
  return jsonRes({ ok: true });
}

// ── Session handlers ──────────────────────────────────────────

async function createSession(interviewId, request) {
  const user = await requireAdmin(request);
  const interview = await kvGet(`interview:${interviewId}`);
  if (!interview) return jsonRes({ error: 'Interview not found' }, 404);
  if (!canAccess(interview, user)) return jsonRes({ error: 'Forbidden' }, 403);

  const { candidateName, candidateEmail, expiresAt, reminderFrequency: remFreq } = await request.json();
  if (!candidateName) return jsonRes({ error: 'candidateName required' }, 400);

  const freqHours = (remFreq && remFreq > 0) ? remFreq : 24;
  const nextReminderAt = expiresAt ? (Date.now() + freqHours * 60 * 60 * 1000) : null;

  const token = uid();
  const session = {
    token, interviewId, candidateName,
    candidateEmail: candidateEmail || '',
    status: 'pending',
    responses: [],
    createdAt: Date.now(),
    completedAt: null,
    expiresAt: expiresAt || null,
    reminderFrequency: freqHours,
    nextReminderAt,
    ownerId: interview.ownerId || user.id,
  };
  await kvPut(`session:${token}`, session);

  const sessions = (await kvGet(`interview:${interviewId}:sessions`)) || [];
  sessions.unshift(token);
  await kvPut(`interview:${interviewId}:sessions`, sessions);

  await logAudit(user, 'invite_candidate', `${candidateName}${candidateEmail ? ` <${candidateEmail}>` : ''} · "${interview.title || interviewId}"`);

  return jsonRes({ token, session }, 201);
}

async function listSessions(interviewId, request) {
  const user = await requireAdmin(request);
  const interview = await kvGet(`interview:${interviewId}`);
  if (interview && !canAccess(interview, user, 'view')) return jsonRes({ error: 'Forbidden' }, 403);
  const tokens = (await kvGet(`interview:${interviewId}:sessions`)) || [];
  const sessions = await Promise.all(tokens.map(t => kvGet(`session:${t}`)));
  return jsonRes(sessions.filter(Boolean));
}

async function getSession(token, request) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  const interview = await kvGet(`interview:${session.interviewId}`);
  const settings  = (await kvGet('recruiter:settings')) || {};
  const branding  = {
    brandName:       settings.brandName       || '',
    brandColor:      settings.brandColor      || '',
    brandWelcomeMsg: settings.brandWelcomeMsg || '',
    brandLogoUrl:    settings.brandLogoUrl    || '',
  };

  // Candidate identity verification config (Google Sign-In). Only "enabled"
  // when an admin has turned it on AND set a Google Client ID. clientId is a
  // public OAuth identifier, safe to send to the candidate's browser.
  const verify = {
    enabled:  !!(settings.requireCandidateIdentity && settings.googleClientId),
    clientId: settings.googleClientId || '',
    done:     !!(session.identity && session.identity.verifiedAt),
  };

  // Authenticated staff (SSO session OR break-glass admin key) get the FULL
  // session — the review modal needs responses, decision, analysis, etc.
  // Visibility scope is enforced so a recruiter can't read another's candidate.
  const user = request ? await resolveUser(request) : null;
  if (user) {
    if (!canAccess(session, user, 'view')) return jsonRes({ error: 'Forbidden' }, 403);
    return jsonRes({ session, interview, branding, verify });
  }

  // PUBLIC (token-only, candidate browser): expose ONLY the fields the candidate
  // page needs — never recruiter-private data (candidateEmail, responses/driveItemIds,
  // reviewDecision/Stars/notes, AI analysis, proctoring logs, reminder schedule,
  // interviewLink, etc.).
  const publicSession = {
    token:              session.token,
    status:             session.status,
    candidateName:      session.candidateName,
    expiresAt:          session.expiresAt || null,
    profilePhotoItemId: session.profilePhotoItemId || null,
    resumeItemId:       session.resumeItemId || null,
  };
  // Strip the MCQ answer key (correctIndex) from questions so candidates can't
  // read it in DevTools. The Worker still has the real key for auto-scoring.
  const publicInterview = interview ? {
    ...interview,
    questions: (interview.questions || []).map(({ correctIndex, ...q }) => q),
  } : interview;
  return jsonRes({ session: publicSession, interview: publicInterview, branding, verify });
}

// Candidate identity verification: validate a Google Sign-In ID token, check
// whether the verified email matches the invited candidate, and stamp the
// result on the session. Token-based (no admin auth) — the candidate calls it.
async function recordVerify(token, request) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  const { credential } = await request.json().catch(() => ({}));
  if (!credential) return jsonRes({ error: 'Missing credential' }, 400);

  const settings = (await kvGet('recruiter:settings')) || {};
  let info;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    if (!r.ok) return jsonRes({ error: 'Invalid Google token' }, 400);
    info = await r.json();
  } catch (e) {
    return jsonRes({ error: 'Could not reach Google to verify token' }, 502);
  }

  // The token must have been issued for OUR client, and the email confirmed.
  if (settings.googleClientId && info.aud !== settings.googleClientId) {
    return jsonRes({ error: 'Token was not issued for this app' }, 400);
  }
  if (info.email_verified !== true && info.email_verified !== 'true') {
    return jsonRes({ error: 'Google has not verified this email' }, 400);
  }

  const verifiedEmail = String(info.email || '').toLowerCase();
  const invitedEmail  = String(session.candidateEmail || '').toLowerCase();
  const matched = !!invitedEmail && verifiedEmail === invitedEmail;
  session.identity = { email: verifiedEmail, name: info.name || '', matched, verifiedAt: Date.now() };
  await kvPut(`session:${token}`, session);
  return jsonRes({ ok: true, matched, email: verifiedEmail });
}

// ─────────────────────────────────────────────────────────────
//  Email helpers — Outlook-safe table-based HTML
// ─────────────────────────────────────────────────────────────

function emailButton(url, text, bg = '#B01A18') {
  return `
  <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:28px auto 0 auto">
    <tr>
      <td align="center" bgcolor="${bg}" style="background-color:${bg};border-radius:6px">
        <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="8%" stroke="f" fillcolor="${bg}"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${text}</center></v:roundrect><![endif]--><!--[if !mso]><!-->
        <a href="${url}" target="_blank" style="mso-hide:all;background-color:${bg};border-radius:6px;color:#ffffff;display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;line-height:44px;padding:0 32px;text-align:center;text-decoration:none;-webkit-text-size-adjust:none">${text}</a>
        <!--<![endif]-->
      </td>
    </tr>
  </table>`;
}

function emailWrap(headerBg, title, bodyRows) {
  return `<!DOCTYPE html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<table cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f3f4f6" style="background-color:#f3f4f6">
<tr><td align="center" style="padding:20px 0">
  <!--[if mso]><table width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
  <table cellpadding="0" cellspacing="0" border="0" width="600" bgcolor="#ffffff"
         style="background-color:#ffffff;border:1px solid #e5e7eb;border-collapse:collapse;max-width:600px;width:100%">
    <!-- HEADER: outer TD owns the banner color; inner table is fixed-layout to lock logo to 90px -->
    <tr>
      <td bgcolor="${headerBg}" style="background-color:${headerBg};padding:0;font-size:0;line-height:0">
        <table cellpadding="0" cellspacing="0" border="0" width="600"
               style="width:600px;border-collapse:collapse;table-layout:fixed">
          <tr>
            <td bgcolor="#ffffff" width="90" align="center" valign="middle"
                style="background-color:#ffffff;width:90px;padding:14px 15px">
              <img src="${CTI_LOGO_URL}" alt="CTI Group" width="60" border="0"
                   style="display:block;width:60px;max-width:60px;height:auto;border:0;outline:0" />
            </td>
            <td bgcolor="${headerBg}" valign="middle"
                style="background-color:${headerBg};padding:18px 24px">
              <p style="margin:0;padding:0;color:#ffffff;font-size:22px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;line-height:28px">${title}</p>
              <p style="margin:4px 0 0 0;padding:0;color:#ffffff;font-size:13px;font-family:Arial,Helvetica,sans-serif;line-height:18px">CTI Group Worldwide Services, Inc.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <!-- BODY -->
    <tr>
      <td style="padding:32px 32px 24px 32px">
        ${bodyRows}
      </td>
    </tr>
    <!-- DIVIDER -->
    <tr><td style="padding:0 32px">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td style="border-top:1px solid #e5e7eb;font-size:0;line-height:0">&nbsp;</td></tr>
      </table>
    </td></tr>
    <!-- FOOTER -->
    <tr>
      <td bgcolor="#f9fafb" style="background-color:#f9fafb;padding:16px 32px">
        <p style="margin:0;color:#9ca3af;font-size:11px;text-align:center;font-family:Arial,Helvetica,sans-serif;line-height:18px">
          CTI Group Worldwide Services, Inc. &nbsp;&middot;&nbsp; ZeusHire Portal<br />
          This is an automated message &mdash; please do not reply to this email.
        </p>
      </td>
    </tr>
  </table>
  <!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

function emailInfoBox(accentColor, title, subtitle = '') {
  return `
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:20px">
    <tr>
      <td width="4" bgcolor="${accentColor}" style="background-color:${accentColor};width:4px;padding:0;line-height:1px;font-size:1px">&nbsp;</td>
      <td bgcolor="#f9fafb" style="background-color:#f9fafb;padding:14px 18px">
        <p style="margin:0;font-size:15px;font-weight:bold;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif">${title}</p>
        ${subtitle ? `<p style="margin:4px 0 0 0;font-size:13px;color:#6b7280;font-family:Arial,Helvetica,sans-serif">${subtitle}</p>` : ''}
      </td>
    </tr>
  </table>`;
}

// ─────────────────────────────────────────────────────────────

async function sendInterviewEmail(token, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (!session.candidateEmail) return jsonRes({ error: 'No email address for this candidate' }, 400);

  const { link } = await request.json();
  const interview = await kvGet(`interview:${session.interviewId}`);
  const interviewTitle = interview?.title || 'Interview';
  const assessOnly = interviewIsAssessmentOnly(interview);
  const noun = assessOnly ? 'assessment' : 'interview';

  // Persist the link so reminder emails can include it
  if (link && !session.interviewLink) {
    session.interviewLink = link;
    await kvPut(`session:${token}`, session);
  }

  const html = emailWrap('#B01A18', 'CTI ZeusHire', `
    <p style="margin:0 0 16px 0;font-size:15px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif">Dear <strong>${htmlEsc(session.candidateName)}</strong>,</p>
    <p style="margin:0 0 20px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">${assessOnly ? 'You have been invited to complete an online assessment for the following position:' : 'You have been invited to complete a one-way video interview for the following position:'}</p>
    ${emailInfoBox('#B01A18', htmlEsc(interviewTitle))}
    <p style="margin:0 0 8px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">Please click the button below to begin. You can complete the ${noun} at your own pace.</p>
    ${emailButton(link, assessOnly ? 'Start Assessment' : 'Start Interview')}
    <p style="margin:20px 0 4px 0;color:#6b7280;font-size:12px;font-family:Arial,Helvetica,sans-serif">Or copy this link into your browser:</p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td bgcolor="#f3f4f6" style="background-color:#f3f4f6;padding:10px;word-break:break-all">
        <p style="margin:0;color:#6b7280;font-size:12px;font-family:Arial,Helvetica,sans-serif;word-break:break-all">${link}</p>
      </td>
    </tr></table>
  `);

  const sender = EMAIL_SENDER;
  const accessToken = await getAccessToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `${assessOnly ? 'Assessment' : 'Interview'} Invitation: ${interviewTitle} — CTI ZeusHire`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ZeusHire', address: sender } },
        toRecipients: [{ emailAddress: { address: session.candidateEmail } }],
      },
      saveToSentItems: true,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return jsonRes({ error: 'Email failed: ' + (err.error?.message || res.status) }, 500);
  }
  return jsonRes({ ok: true });
}

const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB per answer

async function uploadVideo(token, qIndex, request) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (session.status === 'completed') return jsonRes({ error: 'Session already completed' }, 400);
  if (sessionExpired(session)) return jsonRes({ error: 'This interview link has expired' }, 403);

  const interview = await kvGet(`interview:${session.interviewId}`);
  const interviewTitle = interview?.title || 'Interview';

  // Validate the question index against this interview's question count.
  const qCount = interview?.questions?.length || 0;
  if (!Number.isInteger(qIndex) || qIndex < 0 || (qCount && qIndex >= qCount)) {
    return jsonRes({ error: 'Invalid question index' }, 400);
  }

  // Reject oversized uploads early (header) so a token holder can't dump unbounded data.
  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared && declared > MAX_VIDEO_BYTES) {
    return jsonRes({ error: 'Video too large' }, 413);
  }

  const safeName = session.candidateName.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  const shortToken = token.slice(0, 8);

  // Folder: CTI Interviews/{Interview Title}/{Candidate Name} ({shortToken})
  const filePath = `CTI Interviews/${interviewTitle}/${safeName} (${shortToken})/Q${qIndex + 1}.webm`;

  const blob = await request.arrayBuffer();
  if (!blob.byteLength)                 return jsonRes({ error: 'Empty upload' }, 400);
  if (blob.byteLength > MAX_VIDEO_BYTES) return jsonRes({ error: 'Video too large' }, 413);

  let driveItemId = null;
  let webUrl = null;

  try {
    const accessToken = await getAccessToken();
    const fileItem = await uploadToOneDrive(filePath, blob, accessToken);
    driveItemId = fileItem.id;
    webUrl = fileItem.webUrl;
  } catch (e) {
    return jsonRes({ error: 'OneDrive upload failed: ' + e.message }, 500);
  }

  const existing = session.responses.find(r => r.questionIndex === qIndex);
  if (existing) {
    existing.driveItemId = driveItemId;
    existing.webUrl = webUrl;
    existing.uploadedAt = Date.now();
  } else {
    session.responses.push({ questionIndex: qIndex, driveItemId, webUrl, uploadedAt: Date.now() });
  }
  if (session.status === 'pending') session.status = 'in_progress';
  await kvPut(`session:${token}`, session);

  return jsonRes({ ok: true, webUrl });
}

const MAX_AUDIO_BYTES = 30 * 1024 * 1024; // 30 MB — audio-only is tiny in practice

// Store the tiny audio-only track for an answer, used ONLY for transcription
// (Whisper's 25 MB cap is easily blown by full video). Public (token-only),
// mirrors uploadVideo's guards. The video remains the client-facing artifact.
async function uploadAnswerAudio(token, qIndex, request) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (sessionExpired(session)) return jsonRes({ error: 'This interview link has expired' }, 403);

  const interview = await kvGet(`interview:${session.interviewId}`);
  const qCount = interview?.questions?.length || 0;
  if (!Number.isInteger(qIndex) || qIndex < 0 || (qCount && qIndex >= qCount)) {
    return jsonRes({ error: 'Invalid question index' }, 400);
  }

  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared && declared > MAX_AUDIO_BYTES) return jsonRes({ error: 'Audio too large' }, 413);

  const blob = await request.arrayBuffer();
  if (!blob.byteLength)                 return jsonRes({ error: 'Empty upload' }, 400);
  if (blob.byteLength > MAX_AUDIO_BYTES) return jsonRes({ error: 'Audio too large' }, 413);

  // Format from Content-Type (candidate uploads webm/Opus; browser salvage WAV).
  const ct = (request.headers.get('Content-Type') || 'audio/webm').toLowerCase();
  const extMap = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' };
  const audioExt  = extMap[ct.split(';')[0].trim()] || 'webm';
  const audioMime = audioExt === 'wav' ? 'audio/wav' : (audioExt === 'webm' ? 'audio/webm' : ct.split(';')[0].trim());

  const safeName   = session.candidateName.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  const shortToken = token.slice(0, 8);
  const filePath   = `CTI Interviews/${interview?.title || 'Interview'}/${safeName} (${shortToken})/Q${qIndex + 1}-audio.${audioExt}`;

  let audioItemId = null;
  try {
    const accessToken = await getAccessToken();
    const fileItem = await uploadToOneDrive(filePath, blob, accessToken, audioMime);
    audioItemId = fileItem.id;
  } catch (e) {
    return jsonRes({ error: 'Audio upload failed: ' + e.message }, 500);
  }

  // Attach to the matching response (create a stub if the video isn't recorded yet).
  session.responses = session.responses || [];
  const existing = session.responses.find(r => r.questionIndex === qIndex);
  if (existing) { existing.audioItemId = audioItemId; existing.audioExt = audioExt; }
  else session.responses.push({ questionIndex: qIndex, audioItemId, audioExt, uploadedAt: Date.now() });
  await kvPut(`session:${token}`, session);

  return jsonRes({ ok: true });
}

// Store a written (text) or multiple-choice answer. Public (token-only), mirrors
// uploadVideo's guards. MCQ answers are auto-scored against the question's
// correctIndex when one was set.
async function submitWrittenAnswer(token, qIndex, request) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (session.status === 'completed') return jsonRes({ error: 'Session already completed' }, 400);
  if (sessionExpired(session)) return jsonRes({ error: 'This interview link has expired' }, 403);

  const interview = await kvGet(`interview:${session.interviewId}`);
  const q = interview?.questions?.[qIndex];
  if (!q) return jsonRes({ error: 'Invalid question index' }, 400);
  const atype = q.answerType || 'video';
  if (atype !== 'text' && atype !== 'mcq') return jsonRes({ error: 'Question does not accept a written answer' }, 400);

  const body = await request.json().catch(() => ({}));
  const entry = { questionIndex: qIndex, answerType: atype, answeredAt: Date.now() };

  if (atype === 'text') {
    const text = (body.text || '').toString().slice(0, 5000).trim();
    if (!text) return jsonRes({ error: 'Empty answer' }, 400);
    entry.text = text;
  } else {
    const opts = q.options || [];
    const ci = Number.isInteger(body.choiceIndex) ? body.choiceIndex : -1;
    if (ci < 0 || ci >= opts.length) return jsonRes({ error: 'Invalid choice' }, 400);
    entry.choiceIndex = ci;
    entry.choiceText  = opts[ci];
    entry.correct     = (q.correctIndex == null) ? null : (ci === q.correctIndex);
  }

  session.responses = session.responses || [];
  const existing = session.responses.find(r => r.questionIndex === qIndex);
  if (existing) Object.assign(existing, entry);
  else session.responses.push(entry);
  if (session.status === 'pending') session.status = 'in_progress';
  await kvPut(`session:${token}`, session);

  return jsonRes({ ok: true });
}

async function deleteSession(token, request) {
  const user = await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  // "Revoke" (pending) is blocked on completed; explicit ?force=1 (admin Delete) allows it.
  const force = new URL(request.url).searchParams.get('force') === '1';
  if (session.status === 'completed' && !force) return jsonRes({ error: 'Cannot revoke a completed session' }, 400);

  await INTERVIEW_DATA.delete(`session:${token}`);
  await INTERVIEW_DATA.delete(`session:${token}:analysis`);
  await INTERVIEW_DATA.delete(`session:${token}:review`);
  const sessions = (await kvGet(`interview:${session.interviewId}:sessions`)) || [];
  await kvPut(`interview:${session.interviewId}:sessions`, sessions.filter(t => t !== token));
  // Drop from the Premium Talent index too, if listed.
  if (session.premium) {
    const plist = ((await kvGet('premium:list')) || []).filter(t => t !== token);
    await kvPut('premium:list', plist);
  }
  await logAudit(user, force ? 'delete_candidate' : 'revoke_candidate', `${session.candidateName || token}${session.candidateEmail ? ` <${session.candidateEmail}>` : ''}`);
  return jsonRes({ ok: true });
}

async function patchSession(token, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);

  const updates = await request.json();

  // Update deadline and/or frequency; recalculate nextReminderAt whenever either changes
  const freqChanged     = 'reminderFrequency' in updates;
  const deadlineChanged = 'expiresAt' in updates;

  if (deadlineChanged) session.expiresAt = updates.expiresAt || null;
  if (freqChanged)     session.reminderFrequency = updates.reminderFrequency || 24;

  if (deadlineChanged || freqChanged) {
    if (session.expiresAt && session.reminderFrequency) {
      // Schedule first reminder one full interval from now
      const freqMs = session.reminderFrequency * 60 * 60 * 1000;
      session.nextReminderAt = Date.now() + freqMs;
    } else {
      session.nextReminderAt = null;
    }
    // Clear legacy flags
    session.reminderSent     = {};
    session.reminder48hSent  = false;
    session.reminder24hSent  = false;
  }

  await kvPut(`session:${token}`, session);
  return jsonRes(session);
}

async function completeSession(token) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (sessionExpired(session) && session.status !== 'completed') {
    return jsonRes({ error: 'This interview link has expired' }, 403);
  }
  session.status = 'completed';
  session.completedAt = Date.now();
  await kvPut(`session:${token}`, session);
  return jsonRes({ ok: true });
}

// Candidate consent — recorded (token-based, no admin auth) when the candidate
// agrees to recording + AI-assisted review before starting. Stored on the
// session for audit (consentedAt + version of the notice they accepted).
const CONSENT_VERSION = '2026-06-09';
async function recordConsent(token, request) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (!session.consentedAt) {
    session.consentedAt = Date.now();
    session.consentVersion = CONSENT_VERSION;
    await kvPut(`session:${token}`, session);
  }
  return jsonRes({ ok: true });
}

// ── Data retention auto-purge (privacy/compliance) ────────────
// OFF by default — only runs when recruiter:settings.retentionDays > 0.
// Permanently deletes COMPLETED one-way sessions (and their OneDrive media)
// older than the retention window. Premium-Talent candidates are preserved.
async function purgeExpiredData() {
  const settings = (await kvGet('recruiter:settings')) || {};
  const days = parseInt(settings.retentionDays, 10) || 0;
  if (days <= 0) return { enabled: false, purged: 0 };

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const premium = new Set((await kvGet('premium:list')) || []);
  let purged = 0;

  const interviewIds = (await kvGet('interview:list')) || [];
  for (const iid of interviewIds) {
    const tokens = (await kvGet(`interview:${iid}:sessions`)) || [];
    const keep = [];
    for (const token of tokens) {
      const s = await kvGet(`session:${token}`);
      if (!s) continue;
      const ts = s.completedAt || s.createdAt || 0;
      const isPremium = premium.has(token) || !!s.premium;
      if (s.status === 'completed' && ts && ts < cutoff && !isPremium) {
        await purgeSessionMedia(s);
        await INTERVIEW_DATA.delete(`session:${token}`);
        purged++;
      } else {
        keep.push(token);
      }
    }
    if (keep.length !== tokens.length) await kvPut(`interview:${iid}:sessions`, keep);
  }
  console.log(`[retention] purged ${purged} session(s) older than ${days}d`);
  return { enabled: true, purged };
}

// Best-effort delete of a session's OneDrive media (videos, résumé, photo).
async function purgeSessionMedia(s) {
  try {
    const at = await getAccessToken();
    const ids = [];
    for (const r of (s.responses || [])) {
      if (r.driveItemId) ids.push(r.driveItemId);
      if (r.audioItemId) ids.push(r.audioItemId);
    }
    if (s.resumeItemId) ids.push(s.resumeItemId);
    if (s.profilePhotoItemId) ids.push(s.profilePhotoItemId);
    for (const id of ids) {
      await fetch(`https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${id}`,
        { method: 'DELETE', headers: { 'Authorization': `Bearer ${at}` } }).catch(() => {});
    }
  } catch (e) { console.error('[retention] media purge failed:', e.message); }
}

async function getVideoUrl(token, qIndex, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);

  const response = session.responses.find(r => r.questionIndex === qIndex);
  if (!response?.driveItemId) return jsonRes({ error: 'Video not found' }, 404);

  try {
    const accessToken = await getAccessToken();
    const itemRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${response.driveItemId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const item = await itemRes.json();

    return jsonRes({
      downloadUrl: item['@microsoft.graph.downloadUrl'],
      webUrl: item.webUrl,
      fileName: item.name || null,
      fileSize: item.size || null,
      driveItemId: response.driveItemId,
    });
  } catch (e) {
    return jsonRes({ error: 'Could not fetch video URL: ' + e.message }, 500);
  }
}

// Stream the answer video bytes back through the worker (CORS-enabled) so the
// admin can read them with fetch() — used for browser-side audio salvage of
// large recordings made before audio capture existed.
async function getVideoFile(token, qIndex, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  const response = (session.responses || []).find(r => r.questionIndex === qIndex);
  if (!response?.driveItemId) return jsonRes({ error: 'Video not found' }, 404);
  const accessToken = await getAccessToken();
  const item = await fetch(
    `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${response.driveItemId}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  ).then(r => r.json());
  const url = item['@microsoft.graph.downloadUrl'];
  if (!url) return jsonRes({ error: 'Video unavailable' }, 404);
  const fileRes = await fetch(url);
  if (!fileRes.ok) return jsonRes({ error: 'Video fetch failed' }, 502);
  return new Response(fileRes.body, {
    status: 200,
    headers: { 'Content-Type': 'video/webm', 'Cache-Control': 'private, max-age=300' },
  });
}

// ── Two-way session handlers ──────────────────────────────────

async function createTWSession(request) {
  const user = await requireAdmin(request);
  const { candidateName, candidateEmail, position, scheduledAt, duration, meetingLink, notes, autoMeeting } = await request.json();
  if (!candidateName || !candidateEmail || !position) {
    return jsonRes({ error: 'candidateName, candidateEmail, and position are required' }, 400);
  }

  const id = uid();
  const session = {
    id, candidateName, candidateEmail, position,
    scheduledAt: scheduledAt || null,
    duration: duration || 60,
    meetingLink: meetingLink || '',
    notes: notes || '',
    status: 'scheduled',
    createdAt: Date.now(),
    ownerId: user.id,
    organizerEmail: user.calendarEmail || user.email || EMAIL_SENDER,
  };

  if (autoMeeting && scheduledAt) {
    try {
      const meeting = await createTeamsMeeting(session, session.organizerEmail);
      session.meetingLink        = meeting.joinUrl;
      session.calendarEventId    = meeting.eventId;
      session.calendarWebLink    = meeting.webLink;
      session.meetingShortId     = meeting.shortId;    // e.g. "a1b2c3d4"
      session.meetingSubjectTag  = meeting.subjectTag; // e.g. "[CTI-a1b2c3d4]"
      session.teamsGenerated     = true;
    } catch (e) {
      session.teamsError = e.message;
    }
  }

  await kvPut(`tw-session:${id}`, session);

  const list = (await kvGet('tw-session:list')) || [];
  list.unshift(id);
  await kvPut('tw-session:list', list);

  return jsonRes(session, 201);
}

async function listTWSessions(request) {
  const user = await requireAdmin(request);
  const ids = (await kvGet('tw-session:list')) || [];
  const items = await Promise.all(ids.map(id => kvGet(`tw-session:${id}`)));
  return jsonRes(items.filter(Boolean).filter(s => canAccess(s, user, 'view')));
}

// ── Unified Two-Way list (Direct Invite + Self-Booked merged) ─

async function listUnifiedTWSessions(request) {
  const user = await requireAdmin(request);

  // 1. Direct Invite sessions (tw-session:*)
  const twIds   = (await kvGet('tw-session:list')) || [];
  const twItems = (await Promise.all(twIds.map(id => kvGet(`tw-session:${id}`)))).filter(Boolean).filter(s => canAccess(s, user, 'view'));
  const directItems = twItems.map(s => ({
    id:                   s.id,
    ownerId:              s.ownerId || null,
    scheduling_source:    'DIRECT_INVITE',
    candidateName:        s.candidateName,
    candidateEmail:       s.candidateEmail       || '',
    position:             s.position             || '',
    scheduledAt:          s.scheduledAt          || null,
    duration:             s.duration             || 30,
    meetingLink:          s.meetingLink          || null,
    teamsGenerated:       s.teamsGenerated       || false,
    status:               s.status               || 'scheduled',
    createdAt:            s.createdAt            || 0,
    notes:                s.notes                || '',
    recordingDriveItemId: s.recordingDriveItemId || null,
    recordingFileName:    s.recordingFileName    || null,
    recordingWebUrl:      s.recordingWebUrl      || null,
    linkToken:            null,
    linkTitle:            null,
  }));

  // 2. Candidate Booking sessions (booking:booking:*)
  const linkTokens = (await kvGet('booking:link:list')) || [];
  const links      = await Promise.all(linkTokens.map(t => kvGet(`booking:link:${t}`)));

  const bookingArrays = await Promise.all(
    linkTokens.map(async (t, i) => {
      const link = links[i];
      if (!link) return [];
      if (!canAccess(link, user, 'view')) return [];
      const ids      = (await kvGet(`booking:link:${t}:bookings`)) || [];
      const bookings = (await Promise.all(ids.map(id => kvGet(`booking:booking:${id}`)))).filter(b => b && b.status !== 'cancelled');
      return bookings.map(b => ({
        id:                   b.id,
        ownerId:              link.ownerId || null,
        scheduling_source:    'CANDIDATE_BOOKING',
        candidateName:        b.candidateName,
        candidateEmail:       b.candidateEmail   || '',
        position:             link.position || link.title || '',
        scheduledAt:          b.slotStart         || null,
        duration:             link.duration       || 30,
        meetingLink:          b.meetingLink       || null,
        teamsGenerated:       !!b.meetingLink,
        // normalise: booking uses 'confirmed', unified uses 'scheduled'
        status:               b.status === 'confirmed' ? 'scheduled' : (b.status || 'scheduled'),
        createdAt:            b.createdAt         || 0,
        notes:                '',
        recordingDriveItemId: b.recordingDriveItemId || null,
        recordingFileName:    b.recordingFileName    || null,
        recordingWebUrl:      b.recordingWebUrl      || null,
        linkToken:            b.linkToken,
        linkTitle:            link.title          || '',
        calendarEventId:      b.calendarEventId   || null,
      }));
    })
  );

  const unified = [...directItems, ...bookingArrays.flat()]
    .sort((a, b) => (b.scheduledAt || 0) - (a.scheduledAt || 0));

  return jsonRes(unified);
}

// ── Update self-booked session status (e.g. mark completed) ──

async function updateBookingStatusHandler(bookingId, request) {
  const user = await requireAdmin(request);
  const booking = await kvGet(`booking:booking:${bookingId}`);
  if (!booking) return jsonRes({ error: 'Not found' }, 404);
  if (booking.linkToken) {
    const link = await kvGet(`booking:link:${booking.linkToken}`);
    if (link && !canAccess(link, user)) return jsonRes({ error: 'Forbidden' }, 403);
  }
  const { status } = await request.json();
  const allowed = ['completed', 'cancelled', 'confirmed'];
  if (!allowed.includes(status)) return jsonRes({ error: 'Invalid status' }, 400);
  booking.status = status;
  await kvPut(`booking:booking:${bookingId}`, booking);
  return jsonRes(booking);
}

async function updateTWSession(id, request) {
  const user = await requireAdmin(request);
  const existing = await kvGet(`tw-session:${id}`);
  if (!existing) return jsonRes({ error: 'Not found' }, 404);
  if (!canAccess(existing, user)) return jsonRes({ error: 'Forbidden' }, 403);
  const updates = await request.json();
  const updated = { ...existing, ...updates, ownerId: existing.ownerId || user.id };
  await kvPut(`tw-session:${id}`, updated);

  // Send cancellation email when status transitions to 'cancelled'
  let emailSent = false;
  if (updates.status === 'cancelled' && existing.status !== 'cancelled' && updated.candidateEmail) {
    try {
      await sendTWCancellationEmail(updated);
      emailSent = true;
    } catch (e) {
      console.error('[tw-session] cancellation email failed:', e.message);
    }
  }

  return jsonRes({ ...updated, emailSent });
}

async function deleteTWSessionHandler(id, request) {
  const user = await requireAdmin(request);
  const existing = await kvGet(`tw-session:${id}`);
  if (existing && !canAccess(existing, user)) return jsonRes({ error: 'Forbidden' }, 403);
  await INTERVIEW_DATA.delete(`tw-session:${id}`);
  const list = (await kvGet('tw-session:list')) || [];
  await kvPut('tw-session:list', list.filter(i => i !== id));
  return jsonRes({ ok: true });
}

async function sendTWCancellationEmail(session) {
  const sender = EMAIL_SENDER;
  const dt       = session.scheduledAt ? new Date(session.scheduledAt) : null;
  const dateStr  = dt ? dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const timeStr  = dt ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : null;

  const html = emailWrap('#374151', 'Interview Cancelled', `
    <p style="margin:0 0 16px 0;font-size:15px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif">Dear <strong>${session.candidateName}</strong>,</p>
    <p style="margin:0 0 20px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">We regret to inform you that your scheduled interview has been <strong>cancelled</strong>. Here are the details of the cancelled session:</p>
    ${emailInfoBox('#9ca3af', session.position || 'Interview')}
    ${dateStr ? `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:20px">
      <tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Date</td>
        <td valign="top" style="padding:8px 0;color:#9ca3af;font-size:14px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;text-decoration:line-through">${dateStr}</td>
      </tr>
      ${timeStr ? `<tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Time</td>
        <td valign="top" style="padding:8px 0;color:#9ca3af;font-size:14px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;text-decoration:line-through">${timeStr}</td>
      </tr>` : ''}
    </table>` : ''}
    <p style="margin:0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">If you have questions or would like to reschedule, please contact us directly and we will arrange a new time for you.</p>
  `);

  const accessToken = await getAccessToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `Interview Cancelled: ${session.position || 'Interview'} — ${session.candidateName} — CTI ZeusHire`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ZeusHire', address: sender } },
        toRecipients: [{ emailAddress: { address: session.candidateEmail } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Graph sendMail failed: ' + (err.error?.message || res.status));
  }
}

async function sendTWEmail(id, request) {
  await requireAdmin(request);
  const session = await kvGet(`tw-session:${id}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (!session.candidateEmail) return jsonRes({ error: 'No email address for this candidate' }, 400);

  const dt = session.scheduledAt ? new Date(session.scheduledAt) : null;
  const dateStr = dt
    ? dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'To Be Confirmed';
  const timeStr = dt
    ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : '';

  const html = emailWrap('#B01A18', 'CTI ZeusHire', `
    <p style="margin:0 0 16px 0;font-size:15px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif">Dear <strong>${session.candidateName}</strong>,</p>
    <p style="margin:0 0 20px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">You have been scheduled for a two-way interview for the following position:</p>
    ${emailInfoBox('#B01A18', session.position)}
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:20px">
      <tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Date</td>
        <td valign="top" style="padding:8px 0;color:#1a1a1a;font-size:14px;font-weight:bold;font-family:Arial,Helvetica,sans-serif">${dateStr}</td>
      </tr>
      ${timeStr ? `<tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Time</td>
        <td valign="top" style="padding:8px 0;color:#1a1a1a;font-size:14px;font-weight:bold;font-family:Arial,Helvetica,sans-serif">${timeStr}</td>
      </tr>` : ''}
      <tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Duration</td>
        <td valign="top" style="padding:8px 0;color:#1a1a1a;font-size:14px;font-family:Arial,Helvetica,sans-serif">${session.duration} minutes</td>
      </tr>
      <tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Format</td>
        <td valign="top" style="padding:8px 0;color:#1a1a1a;font-size:14px;font-family:Arial,Helvetica,sans-serif">Microsoft Teams (video)</td>
      </tr>
      ${session.meetingLink ? `<tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Meeting</td>
        <td valign="top" style="padding:8px 0"><a href="${session.meetingLink}" style="color:#B01A18;font-weight:bold;font-family:Arial,Helvetica,sans-serif;font-size:14px;text-decoration:underline">Join Meeting Link</a></td>
      </tr>` : ''}
    </table>
    ${session.meetingLink ? emailButton(session.meetingLink, 'Join Interview') : ''}
  `);

  const sender = EMAIL_SENDER;
  const accessToken = await getAccessToken();
  const emailRes = await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `Interview Scheduled: ${session.position} — CTI ZeusHire`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ZeusHire', address: sender } },
        toRecipients: [{ emailAddress: { address: session.candidateEmail } }],
      },
      saveToSentItems: true,
    }),
  });

  if (!emailRes.ok) {
    const err = await emailRes.json().catch(() => ({}));
    return jsonRes({ error: 'Email failed: ' + (err.error?.message || emailRes.status) }, 500);
  }
  return jsonRes({ ok: true });
}

// ── Resolve the organizer's OneDrive drive base URL ──────────────
// Tries /users/{email}/drive first. If that returns 423 (common when the
// account has sign-in blocked or SharePoint access policies block the
// /users/ endpoint), falls back to /sites/{host}/personal/{path}/drive
// which only requires Sites.ReadWrite.All and is not user-account-gated.
async function resolveOrganizerDriveBase(organizer, accessToken) {
  const userBase = `https://graph.microsoft.com/v1.0/users/${organizer}/drive`;
  const testRes  = await fetch(`${userBase}/root`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  console.log(`[drive] /users/ → ${testRes.status}`);
  if (testRes.ok) return { driveBase: userBase, error: null };

  if (testRes.status !== 423) {
    const err = await testRes.json().catch(() => ({}));
    console.error(`[drive] /users/ failed: ${testRes.status} ${JSON.stringify(err.error || {})}`);
    return {
      driveBase: null,
      error: {
        message: `Cannot access OneDrive for ${organizer} (HTTP ${testRes.status}): ${err.error?.message || 'unknown'}`,
        code: err.error?.code,
        innerError: err.error?.innerError,
      },
    };
  }

  // 423 → try site-based access.
  // Derive the personal site path from the email:
  //   corporate-recruiter@cti-usa.com  →  corporate-recruiter_cti-usa_com
  // Rule: replace '@' with '_', keep hyphens, replace '.' with '_'.
  const sitePath   = organizer.toLowerCase().replace('@', '_').replace(/\./g, '_');
  const siteApiUrl = `https://graph.microsoft.com/v1.0/sites/ctiworldwide-my.sharepoint.com:/personal/${sitePath}`;
  console.log(`[drive] 423 → trying site fallback: /personal/${sitePath}`);

  const siteRes = await fetch(siteApiUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  console.log(`[drive] site fallback → ${siteRes.status}`);
  if (!siteRes.ok) {
    const siteErr = await siteRes.json().catch(() => ({}));
    console.error(`[drive] site fallback failed: ${siteRes.status} ${JSON.stringify(siteErr.error || {})}`);
    return {
      driveBase: null,
      error: {
        message: `Cannot access OneDrive for ${organizer}: /users/ returned 423, site fallback returned ${siteRes.status}: ${siteErr.error?.message || 'unknown'}`,
        code: siteErr.error?.code,
        hint: 'Check if the account is blocked in Azure AD (portal.azure.com → Users → Block sign-in) or if a SharePoint network location policy is restricting access.',
      },
    };
  }

  const siteData  = await siteRes.json();
  console.log(`[drive] site fallback OK, siteId=${siteData.id}`);
  const siteBase  = `https://graph.microsoft.com/v1.0/sites/${siteData.id}/drive`;
  return { driveBase: siteBase, error: null };
}

// ── Shared recording-matching helper ─────────────────────────────
//
// Matches ONE recording file to a specific interview session with precision.
//
// Matching tiers (in priority order):
//
//   Tier 1 — AUTHORITATIVE: Unique CTI tag  [CTI-{shortId}]
//     • All ZeusHire-generated Teams meetings embed this tag in the meeting
//       subject → Teams includes it in the recording filename.
//     • If meetingShortId is set on the session, ONLY this match is accepted.
//     • Never falls back to name-matching when shortId is available.
//       (Prevents cross-session contamination for same-name candidates.)
//
//   Tier 2 — NAME MATCH: ALL significant words must appear in the filename.
//     • Only used when no meetingShortId (manual / pre-feature sessions).
//     • Requires every word >2 chars in the candidate name to match.
//       Partial word-list matches are rejected to avoid false positives.
//
// Returns { match: DriveItem|null, reason: string }
function findRecordingCandidate(files, session) {
  if (!files.length) return { match: null, reason: 'no_files_in_window' };

  // ── Tier 1: Unique [CTI-{shortId}] tag ───────────────────────
  if (session.meetingShortId) {
    const tag   = `cti-${session.meetingShortId}`;
    const match = files.find(f => f.name.toLowerCase().includes(tag));
    if (match) return { match, reason: `id_tag:${tag}` };
    // Tag set but NOT found — do NOT fall through to name search.
    // A name-based guess here would silently return the wrong recording.
    const pool = files.slice(0, 5).map(f => f.name).join(' | ');
    return {
      match: null,
      reason: `tag_not_found:[CTI-${session.meetingShortId}] not in ${files.length} file(s): ${pool}`,
    };
  }

  // ── Tier 2: Name match (manual/legacy sessions only) ─────────
  const nameWords = (session.candidateName || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2);

  if (!nameWords.length) {
    return { match: null, reason: 'no_usable_name_terms' };
  }

  // ALL significant words must match — one-word hits are false positives.
  const match = files.find(f => {
    const fn = f.name.toLowerCase();
    return nameWords.every(w => fn.includes(w));
  });
  if (match) return { match, reason: `name_all_words:${nameWords.join('+')}` };

  const pool = files.slice(0, 5).map(f => f.name).join(' | ');
  return {
    match: null,
    reason: `name_not_found:"${session.candidateName}" (words: ${nameWords.join(',')}) not matched in ${files.length} file(s): ${pool}`,
  };
}

// ── Targeted search: find a recording by its unique [CTI-{shortId}] tag ──
// Searches the WHOLE drive by filename text, so it locates the recording even
// when it's old enough to have scrolled past the recent-files listing. Returns
// only files whose name actually contains the tag (defensive against fuzzy hits).
async function searchRecordingByTag(driveBase, accessToken, shortId) {
  if (!shortId) return [];
  const videoExt = /\.(mp4|mkv|webm)$/i;
  try {
    const res = await fetch(
      `${driveBase}/search(q='${encodeURIComponent(shortId)}')?$top=25&$select=id,name,createdDateTime,size,webUrl`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const tag = `cti-${shortId}`.toLowerCase();
    return (data.value || []).filter(f => videoExt.test(f.name) && f.name.toLowerCase().includes(tag));
  } catch { return []; }
}

// ── Shared OneDrive recording file collector ──────────────────────
// Lists /Recordings folder (Teams default) then falls back to drive search.
async function collectRecordingFiles(driveBase, accessToken) {
  const videoExt = /\.(mp4|mkv|webm)$/i;
  let files = [];

  const folderRes = await fetch(
    `${driveBase}/root:/Recordings:/children` +
    `?$orderby=createdDateTime+desc&$top=200&$select=id,name,createdDateTime,size,webUrl`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  if (folderRes.ok) {
    const data = await folderRes.json();
    files.push(...(data.value || []).filter(f => videoExt.test(f.name)));
  }

  // Drive-wide search as fallback (covers recordings saved outside /Recordings)
  if (!files.length) {
    const searchRes = await fetch(
      `${driveBase}/search(q='.mp4')?$top=50&$select=id,name,createdDateTime,size,webUrl`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    if (searchRes.ok) {
      const data = await searchRes.json();
      files.push(...(data.value || []).filter(f => videoExt.test(f.name)));
    }
  }
  return files;
}

// ── Narrow files to the meeting's time window ─────────────────────
// Only return files whose createdDateTime falls between:
//   windowStart = meetingStart        (recording can't exist before meeting starts)
//   windowEnd   = meetingEnd + 4 h   (Teams processing delay, generous but bounded)
//
// Bounded upper limit is the critical fix — previously unbounded, which allowed
// recordings from LATER sessions to contaminate the candidate pool.
function applyTimeWindow(files, meetingStartMs, durationMinutes) {
  if (!meetingStartMs) return files; // no scheduledAt → can't filter
  const meetingEndMs = meetingStartMs + durationMinutes * 60 * 1000;
  const windowEnd    = meetingEndMs + 4 * 60 * 60 * 1000; // +4h processing grace
  return files.filter(f => {
    const t = new Date(f.createdDateTime).getTime();
    return t >= meetingStartMs && t <= windowEnd;
  });
}

async function fetchTWRecording(id, request) {
  const user = await requireAdmin(request);
  const session = await kvGet(`tw-session:${id}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (!canAccess(session, user, 'view')) return jsonRes({ error: 'Forbidden' }, 403);

  const organizer   = session.organizerEmail || EMAIL_SENDER || ONEDRIVE_USER;
  const accessToken = await getAccessToken();
  const { driveBase, error } = await resolveOrganizerDriveBase(organizer, accessToken);
  if (error) return jsonRes(error, 500);

  // Tier 0: direct tag search (robust to old recordings that scrolled past the
  // recent-files listing). If the uniquely-tagged file exists anywhere in the
  // drive, use it directly — no time window needed since the tag is unique.
  let match = null, reason = '';
  if (session.meetingShortId) {
    const tagged = await searchRecordingByTag(driveBase, accessToken, session.meetingShortId);
    if (tagged.length) { match = tagged[0]; reason = `tag_search:cti-${session.meetingShortId}`; }
  }

  if (!match) {
    const allFiles   = await collectRecordingFiles(driveBase, accessToken);
    const candidates = applyTimeWindow(allFiles, session.scheduledAt, session.duration || 60);

    if (!candidates.length) {
      return jsonRes({
        notFound: true,
        message: allFiles.length
          ? `Found ${allFiles.length} recording(s) in OneDrive but none fall within the expected ` +
            `meeting window (${new Date(session.scheduledAt).toISOString()} + ${session.duration || 60} min + 4h). ` +
            `Recording may still be processing — retry in a few minutes.`
          : 'No recording found yet. Recording may still be processing — try again in a few minutes.',
      });
    }

    ({ match, reason } = findRecordingCandidate(candidates, session));
  }

  if (!match) {
    return jsonRes({
      notFound: true,
      message: reason.startsWith('tag_not_found')
        ? `Recording tag not found — ${reason.replace('tag_not_found:', '')}. ` +
          `Teams may still be processing — retry in a few minutes.`
        : `No recording matched for "${session.candidateName}". ${reason}`,
    });
  }

  // Persist the exact Drive item ID — all future playback uses this ID directly,
  // never re-runs the search, so no future mismatch is possible.
  session.recordingDriveItemId  = match.id;
  session.recordingFileName     = match.name;
  session.recordingWebUrl       = match.webUrl;
  session.recordingMatchReason  = reason; // audit trail
  await kvPut(`tw-session:${id}`, session);

  return jsonRes({ ok: true, fileName: match.name, webUrl: match.webUrl });
}

async function fetchBookingRecording(bookingId, request) {
  const user = await requireAdmin(request);
  const booking = await kvGet(`booking:booking:${bookingId}`);
  if (!booking) return jsonRes({ error: 'Booking not found' }, 404);
  if (booking.linkToken) {
    const link = await kvGet(`booking:link:${booking.linkToken}`);
    if (link && !canAccess(link, user, 'view')) return jsonRes({ error: 'Forbidden' }, 403);
  }

  const organizer   = booking.organizerEmail || EMAIL_SENDER || ONEDRIVE_USER;
  const accessToken = await getAccessToken();
  const { driveBase, error } = await resolveOrganizerDriveBase(organizer, accessToken);
  if (error) return jsonRes(error, 500);

  const duration   = booking.slotEnd
    ? Math.round((booking.slotEnd - booking.slotStart) / 60000)
    : 30;

  // Build session-like object for the shared matcher
  const sessionLike = {
    meetingShortId: booking.meetingShortId || null,
    candidateName:  booking.candidateName,
  };

  // Tier 0: direct tag search (robust to old recordings beyond the recent listing).
  let match = null, reason = '';
  if (booking.meetingShortId) {
    const tagged = await searchRecordingByTag(driveBase, accessToken, booking.meetingShortId);
    if (tagged.length) { match = tagged[0]; reason = `tag_search:cti-${booking.meetingShortId}`; }
  }

  if (!match) {
    const allFiles   = await collectRecordingFiles(driveBase, accessToken);
    const candidates = applyTimeWindow(allFiles, booking.slotStart, duration);

    if (!candidates.length) {
      return jsonRes({
        notFound: true,
        message: allFiles.length
          ? `Found ${allFiles.length} recording(s) but none fall within the expected meeting window. ` +
            `Recording may still be processing — retry in a few minutes.`
          : 'No recording found yet — try again in a few minutes.',
      });
    }

    ({ match, reason } = findRecordingCandidate(candidates, sessionLike));
  }

  if (!match) {
    return jsonRes({
      notFound: true,
      message: reason.startsWith('tag_not_found')
        ? `Recording tag not found — ${reason.replace('tag_not_found:', '')}. ` +
          `Teams may still be processing — retry in a few minutes.`
        : `No recording matched for "${booking.candidateName}". ${reason}`,
    });
  }

  booking.recordingDriveItemId = match.id;
  booking.recordingFileName    = match.name;
  booking.recordingWebUrl      = match.webUrl;
  booking.recordingMatchReason = reason;
  await kvPut(`booking:booking:${bookingId}`, booking);

  return jsonRes({ ok: true, fileName: match.name, webUrl: match.webUrl });
}

async function getBookingRecordingUrl(bookingId, request) {
  const user = await requireAdmin(request);
  const booking = await kvGet(`booking:booking:${bookingId}`);
  if (!booking) return jsonRes({ error: 'Booking not found' }, 404);
  if (booking.linkToken) {
    const link = await kvGet(`booking:link:${booking.linkToken}`);
    if (link && !canAccess(link, user, 'view')) return jsonRes({ error: 'Forbidden' }, 403);
  }
  if (!booking.recordingDriveItemId) {
    return jsonRes({ error: 'No recording linked to this booking' }, 404);
  }
  try {
    const organizer   = booking.organizerEmail || EMAIL_SENDER || ONEDRIVE_USER;
    const accessToken = await getAccessToken();
    const { driveBase, error } = await resolveOrganizerDriveBase(organizer, accessToken);
    if (error) return jsonRes(error, 500);

    const itemRes = await fetch(
      `${driveBase}/items/${booking.recordingDriveItemId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const item = await itemRes.json();
    return jsonRes({
      downloadUrl: item['@microsoft.graph.downloadUrl'],
      webUrl:      item.webUrl,
      fileName:    booking.recordingFileName,
    });
  } catch (e) {
    return jsonRes({ error: 'Could not fetch recording URL: ' + e.message }, 500);
  }
}

async function getTWRecordingUrl(id, request) {
  const user = await requireAdmin(request);
  const session = await kvGet(`tw-session:${id}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (!canAccess(session, user, 'view')) return jsonRes({ error: 'Forbidden' }, 403);
  if (!session.recordingDriveItemId) return jsonRes({ error: 'No recording linked to this session' }, 404);

  try {
    const organizer   = session.organizerEmail || EMAIL_SENDER || ONEDRIVE_USER;
    const accessToken = await getAccessToken();

    const { driveBase, error } = await resolveOrganizerDriveBase(organizer, accessToken);
    if (error) return jsonRes(error, 500);

    const itemRes = await fetch(
      `${driveBase}/items/${session.recordingDriveItemId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const item = await itemRes.json();
    return jsonRes({
      downloadUrl: item['@microsoft.graph.downloadUrl'],
      webUrl:      item.webUrl,
      fileName:    session.recordingFileName,
    });
  } catch (e) {
    return jsonRes({ error: 'Could not fetch recording URL: ' + e.message }, 500);
  }
}

async function createTeamsMeeting(session, organizerEmail) {
  const accessToken = await getAccessToken();
  // Phase 3: the meeting is organized on the OWNING recruiter's calendar
  // (organizerEmail). Falls back to the shared corporate mailbox when no owner
  // is resolved (legacy records / break-glass admin).
  const organizer   = organizerEmail || EMAIL_SENDER || ONEDRIVE_USER;

  const startMs  = session.scheduledAt;
  const endMs    = startMs + (session.duration || 60) * 60 * 1000;
  const startStr = new Date(startMs).toISOString().replace('Z', '');
  const endStr   = new Date(endMs).toISOString().replace('Z', '');

  // Embed a short session ID tag in the meeting subject.
  // Teams includes the meeting subject in the recording filename, so
  // fetchTWRecording can match by this tag instead of guessing by name.
  // e.g. subject = "Interview: Cunard Line - Waiter — Herry Wahyudi [CTI-a1b2c3d4]"
  // recording  = "Interview Cunard Line - Waiter — Herry Wahyudi [CTI-a1b2c3d4]-Meeting Recording.mp4"
  const shortId  = session.id.replace(/-/g, '').slice(0, 8); // 8-char hex tag
  const subjectTag = `[CTI-${shortId}]`;

  const eventBody = {
    subject: `Interview: ${session.position} — ${session.candidateName} ${subjectTag}`,
    body: {
      contentType: 'HTML',
      content: `
        <p>Interview scheduled via <strong>CTI ZeusHire</strong>.</p>
        <table cellpadding="6" style="font-family:Arial,sans-serif;font-size:14px">
          <tr><td style="color:#6b7280;width:100px">Candidate</td><td><strong>${session.candidateName}</strong> &lt;${session.candidateEmail}&gt;</td></tr>
          <tr><td style="color:#6b7280">Position</td><td>${session.position}</td></tr>
          <tr><td style="color:#6b7280">Duration</td><td>${session.duration || 60} minutes</td></tr>
          ${session.notes ? `<tr><td style="color:#6b7280;vertical-align:top">Notes</td><td>${session.notes}</td></tr>` : ''}
        </table>
      `,
    },
    start: { dateTime: startStr, timeZone: 'UTC' },
    end:   { dateTime: endStr,   timeZone: 'UTC' },
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
    attendees: [
      {
        emailAddress: { address: session.candidateEmail, name: session.candidateName },
        type: 'required',
      },
    ],
  };

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${organizer}/calendar/events`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(eventBody),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Teams: ' + (err.error?.message || res.status));
  }

  const event = await res.json();
  return {
    joinUrl:  event.onlineMeeting?.joinUrl || '',
    eventId:  event.id,
    webLink:  event.webLink || '',
    shortId,           // passed back so caller can store it on the session
    subjectTag,        // e.g. "[CTI-a1b2c3d4]"
  };
}

// ── English Analysis (One-Way Interview) ──────────────────────
// Required Worker secrets: GROQ_API_KEY (transcription + rating)

async function analyzeSession(token, request) {
  const user = await requireAdmin(request);

  if (typeof GROQ_API_KEY === 'undefined' || !GROQ_API_KEY) {
    return jsonRes({ error: 'GROQ_API_KEY is not configured in Worker secrets.' }, 500);
  }

  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);

  const responses = (session.responses || []).filter(r => r.audioItemId || r.driveItemId);
  if (!responses.length) return jsonRes({ error: 'No recordings found for this session.' }, 400);

  const interview  = await kvGet(`interview:${session.interviewId}`);
  const questions  = interview?.questions || [];
  const accessToken = await getAccessToken();

  // ── Step 1: resolve @microsoft.graph.downloadUrl for every response ──
  // Prefer the compact audio-only file (tiny, never hits Whisper's 25 MB cap);
  // fall back to the full video for answers recorded before audio capture.
  const downloadItems = await Promise.all(responses.map(async r => {
    const itemId  = r.audioItemId || r.driveItemId;
    const isAudio = !!r.audioItemId;
    const ext     = isAudio ? (r.audioExt || 'webm') : 'webm';
    try {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${itemId}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      const item = await res.json();
      return { qIndex: r.questionIndex, url: item['@microsoft.graph.downloadUrl'] || null, isAudio, ext };
    } catch {
      return { qIndex: r.questionIndex, url: null, isAudio, ext };
    }
  }));

  // ── Step 2: download each recording + transcribe via Groq Whisper (parallel) ──
  const transcripts = await Promise.all(downloadItems.map(async ({ qIndex, url, isAudio, ext }) => {
    const qText = questions[qIndex]?.text || `Question ${qIndex + 1}`;

    if (!url) {
      return { qIndex, qText, transcript: '[Recording unavailable]', error: true };
    }
    try {
      const videoRes = await fetch(url);
      if (!videoRes.ok) {
        return { qIndex, qText, transcript: '[Download failed]', error: true };
      }
      const blob = await videoRes.blob();

      // Groq Whisper limit is 25 MB. Audio-only files stay well under it; only
      // legacy video-only answers (recorded before audio capture) can exceed it.
      if (blob.size > 24 * 1024 * 1024) {
        return { qIndex, qText, transcript: '[Recording too large to transcribe — please re-record this answer]', error: true };
      }

      const form = new FormData();
      form.append('file', blob, `q${qIndex + 1}.${ext || 'webm'}`);
      form.append('model', 'whisper-large-v3');
      form.append('language', 'en');

      // Groq's Whisper API is OpenAI-compatible — same response shape, much faster
      // Strip ALL non-printable characters from the key (handles invisible paste artifacts)
      const groqKey = (GROQ_API_KEY || '').replace(/[^\x21-\x7E]/g, '');
      let whisperRes;
      try {
        whisperRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${groqKey}` },
          body: form,
        });
      } catch (fetchErr) {
        console.error(`[analyze] Groq fetch error Q${qIndex + 1}:`, fetchErr.message);
        return { qIndex, qText, transcript: `[Groq header error: ${fetchErr.message} — re-enter GROQ_API_KEY in Cloudflare]`, error: true };
      }
      if (!whisperRes.ok) {
        const e = await whisperRes.json().catch(() => ({}));
        console.error(`[analyze] Groq Whisper Q${qIndex + 1}:`, JSON.stringify(e));
        return { qIndex, qText, transcript: `[Groq ${whisperRes.status}: ${e.error?.message || 'transcription failed'}]`, error: true };
      }
      const wData = await whisperRes.json();
      return { qIndex, qText, transcript: wData.text?.trim() || '' };
    } catch (e) {
      console.error(`[analyze] Q${qIndex + 1} exception:`, e.message);
      return { qIndex, qText, transcript: '[Error: ' + e.message + ']', error: true };
    }
  }));

  // Sort by question order
  transcripts.sort((a, b) => a.qIndex - b.qIndex);

  // ── Step 3: analyze with Claude ──
  const qaBlock = transcripts.map(t =>
    `Question ${t.qIndex + 1}: ${t.qText}\nCandidate's answer: ${t.transcript}`
  ).join('\n\n---\n\n');

  const prompt = `You are a professional recruiter evaluating a candidate's English language proficiency from their video interview answers.

Candidate: ${session.candidateName}

${qaBlock}

Rate each answer's English on a 1–5 scale:
1 ⭐ Very limited — hard to follow, major errors, very basic vocabulary
2 ⭐⭐ Basic — understandable but frequent grammar/vocabulary errors
3 ⭐⭐⭐ Intermediate — communicates ideas, noticeable but not blocking errors
4 ⭐⭐⭐⭐ Good — fluent and professional, occasional minor errors
5 ⭐⭐⭐⭐⭐ Excellent — near-native, sophisticated vocabulary, polished tone

Criteria: grammar accuracy, vocabulary range, sentence complexity, fluency, professional tone. Also produce a brief content summary of what the candidate said (not about language quality — just what they discussed).

Respond with ONLY a valid JSON object — no commentary before or after:
{
  "questions": [
    {
      "questionIndex": 0,
      "stars": 4,
      "feedback": "One concise sentence on English quality.",
      "summary": "1-2 sentence summary of what the candidate actually said in their answer."
    }
  ],
  "overall": {
    "stars": 4,
    "level": "Good",
    "recommendation": "consider",
    "summary": "2–3 sentence professional summary of the candidate's overall English proficiency."
  }
}

For "recommendation", output exactly one of: "strong" (clear move-forward), "consider" (borderline), or "weak" (likely not a fit) — based on overall English proficiency and the substance of the answers.`;

  // LLM rating via Groq (free). Transcription above already used Groq Whisper.
  let rawText;
  try {
    rawText = await groqChat(prompt, 1024);
  } catch (e) {
    console.error('[analyze] Groq error:', e.message);
    return jsonRes({ error: 'Analysis failed: ' + e.message }, 500);
  }

  let analysis;
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    analysis = JSON.parse(match ? match[0] : rawText);
  } catch (e) {
    console.error('[analyze] JSON parse failed. Raw:', rawText.slice(0, 300));
    return jsonRes({ error: 'Could not parse AI response. Raw: ' + rawText.slice(0, 200) }, 500);
  }

  // Attach transcripts to each question result
  analysis.questions = (analysis.questions || []).map(q => {
    const t = transcripts.find(t => t.qIndex === q.questionIndex);
    return { ...q, transcript: t?.transcript || '', qText: t?.qText || '' };
  });
  analysis.analyzedAt     = Date.now();
  analysis.candidateName  = session.candidateName;

  // Cache in KV
  await kvPut(`session:${token}:analysis`, analysis);

  // Persist a compact AI score on the SESSION so the candidate list can rank/sort
  // and badge candidates without re-opening each analysis blob.
  try {
    session.aiScore          = analysis.overall?.stars ?? null;
    session.aiLevel          = analysis.overall?.level || '';
    session.aiRecommendation = analysis.overall?.recommendation || '';
    session.aiAnalyzedAt     = analysis.analyzedAt;
    await kvPut(`session:${token}`, session);
  } catch (e) {}

  await logAudit(user, 'run_ai_analysis', `${session.candidateName || token}${analysis.overall?.stars != null ? ` → ${analysis.overall.stars}★ ${analysis.overall.level || ''}`.trimEnd() : ''}`);

  return jsonRes(analysis);
}

async function getAnalysis(token, request) {
  await requireAdmin(request);
  const analysis = await kvGet(`session:${token}:analysis`);
  if (!analysis) return jsonRes({ notFound: true });
  return jsonRes(analysis);
}

// ── Profile Photo & Resume Upload ─────────────────────────────

async function uploadProfilePhoto(token, request) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (sessionExpired(session)) return jsonRes({ error: 'This interview link has expired' }, 403);

  try {
    const formData    = await request.formData();
    const file        = formData.get('file');
    if (!file) return jsonRes({ error: 'No file in request' }, 400);

    const contentType = file.type || 'image/jpeg';
    if (!contentType.startsWith('image/')) return jsonRes({ error: 'File must be an image' }, 400);
    if (file.size && file.size > 10 * 1024 * 1024) return jsonRes({ error: 'Image too large (max 10 MB)' }, 413);
    const ext         = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : 'jpg';
    const interview   = await kvGet(`interview:${session.interviewId}`);
    const safeName    = session.candidateName.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    const shortToken  = token.slice(0, 8);
    const filePath    = `CTI Interviews/${interview?.title || 'Interview'}/${safeName} (${shortToken})/profile.${ext}`;

    const blob        = await file.arrayBuffer();
    const accessToken = await getAccessToken();
    const fileItem    = await uploadToOneDrive(filePath, blob, accessToken, contentType);
    session.profilePhotoItemId = fileItem.id;
    await kvPut(`session:${token}`, session);
    return jsonRes({ ok: true });
  } catch (e) {
    return jsonRes({ error: 'Photo upload failed: ' + e.message }, 500);
  }
}

async function uploadResume(token, request) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (sessionExpired(session)) return jsonRes({ error: 'This interview link has expired' }, 403);

  try {
    const formData    = await request.formData();
    const file        = formData.get('file');
    if (!file) return jsonRes({ error: 'No file in request' }, 400);

    const fileName    = file.name || 'resume.pdf';
    const ext         = fileName.split('.').pop().toLowerCase() || 'pdf';
    const mimeMap     = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif' };
    const contentType = mimeMap[ext] || 'application/octet-stream';
    const interview   = await kvGet(`interview:${session.interviewId}`);
    const safeName    = session.candidateName.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    const shortToken  = token.slice(0, 8);
    const filePath    = `CTI Interviews/${interview?.title || 'Interview'}/${safeName} (${shortToken})/resume.${ext}`;

    const blob        = await file.arrayBuffer();
    const accessToken = await getAccessToken();
    const fileItem    = await uploadToOneDrive(filePath, blob, accessToken, contentType);
    session.resumeItemId   = fileItem.id;
    session.resumeFileName = fileName;
    session.resumeExt      = ext;
    await kvPut(`session:${token}`, session);
    return jsonRes({ ok: true });
  } catch (e) {
    return jsonRes({ error: 'Resume upload failed: ' + e.message }, 500);
  }
}

async function getProfilePhotoUrl(token, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session?.profilePhotoItemId) return jsonRes({ notFound: true });
  try {
    const accessToken = await getAccessToken();
    const res  = await fetch(
      `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${session.profilePhotoItemId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const item = await res.json();
    return jsonRes({ downloadUrl: item['@microsoft.graph.downloadUrl'] || null });
  } catch (e) {
    return jsonRes({ error: e.message }, 500);
  }
}

// Microsoft Graph /preview returns a short-lived embeddable URL that renders the
// file inline (PDF/doc/image) — far more reliable than the Google Docs viewer.
async function drivePreviewUrl(itemId, accessToken) {
  try {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${itemId}/preview`,
      { method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chromeless: true }) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j.getUrl || null;
  } catch { return null; }
}

// Stream the résumé back inline so the admin can render it in the browser's
// NATIVE viewer (consistent scroll). Fetched via JS with the X-Admin-Key header
// (so the key never goes in a URL) and turned into a blob on the client.
async function getResumeFile(token, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session?.resumeItemId) return jsonRes({ error: 'No résumé' }, 404);
  const accessToken = await getAccessToken();
  const item = await fetch(
    `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${session.resumeItemId}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  ).then(r => r.json());
  const url = item['@microsoft.graph.downloadUrl'];
  if (!url) return jsonRes({ error: 'Résumé unavailable' }, 404);
  const fileRes = await fetch(url);
  if (!fileRes.ok) return jsonRes({ error: 'Résumé fetch failed' }, 502);
  const ext = (session.resumeExt || 'pdf').toLowerCase();
  const ctMap = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif' };
  const ct = ctMap[ext] || (fileRes.headers.get('content-type') || 'application/octet-stream');
  return new Response(fileRes.body, {
    status: 200,
    headers: { 'Content-Type': ct, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=300' },
  });
}

async function getResumeUrl(token, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session?.resumeItemId) return jsonRes({ notFound: true });
  try {
    const accessToken = await getAccessToken();
    const [item, previewUrl] = await Promise.all([
      fetch(`https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${session.resumeItemId}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }).then(r => r.json()),
      drivePreviewUrl(session.resumeItemId, accessToken),
    ]);
    return jsonRes({
      downloadUrl: item['@microsoft.graph.downloadUrl'] || null,
      previewUrl,
      fileName:    session.resumeFileName || 'resume.pdf',
      ext:         session.resumeExt      || 'pdf',
    });
  } catch (e) {
    return jsonRes({ error: e.message }, 500);
  }
}

// Default outcome-email templates (used when the recruiter hasn't customized them).
// Placeholders: {name} {position}
const OUTCOME_DEFAULTS = {
  move_forward: {
    subject: 'Good news about your {position} application — CTI Group',
    body:
`Dear {name},

Congratulations! We were impressed with your responses for {position}, and we're pleased to let you know that you've been selected to move forward to the next stage of our process.

Our recruitment team will be in touch shortly with the next steps. Thank you for your interest in CTI Group.

Warm regards,
CTI Group Recruitment Team`,
  },
  not_moving_forward: {
    subject: 'Update on your {position} application — CTI Group',
    body:
`Dear {name},

Thank you for taking the time to complete your interview for {position} and for your interest in CTI Group.

After careful consideration, we have decided not to move forward with your application at this time. We genuinely appreciate the effort you put in and encourage you to apply for future opportunities that match your experience.

We wish you all the best in your career.

Kind regards,
CTI Group Recruitment Team`,
  },
};

// Outcome email to the candidate based on the recruiter's decision.
async function sendOutcomeEmail(session, interview, decision) {
  if (!session.candidateEmail) return false;
  if (decision !== 'move_forward' && decision !== 'not_moving_forward') return false;

  const settings = (await kvGet('recruiter:settings')) || {};
  const custom = decision === 'move_forward'
    ? { subject: settings.outcomeFwdSubject, body: settings.outcomeFwdBody }
    : { subject: settings.outcomeRejSubject, body: settings.outcomeRejBody };
  const def = OUTCOME_DEFAULTS[decision];

  const fill = t => (t || '').replace(/\{name\}/g, session.candidateName).replace(/\{position\}/g, interview?.title || 'the position');
  const subject = fill((custom.subject && custom.subject.trim()) ? custom.subject : def.subject);
  const bodyText = fill((custom.body && custom.body.trim()) ? custom.body : def.body);
  // Plain-text body → safe HTML paragraphs (escape, blank line = paragraph, single newline = <br>).
  const inner = bodyText.split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 16px;color:#374151;font-size:14px;font-family:Arial,sans-serif;line-height:22px">${htmlEsc(p).replace(/\n/g, '<br/>')}</p>`
  ).join('');

  const accessToken = await getAccessToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${EMAIL_SENDER}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: emailWrap('#B01A18', 'CTI ZeusHire', inner) },
        from: { emailAddress: { name: 'CTI ZeusHire', address: EMAIL_SENDER } },
        toRecipients: [{ emailAddress: { address: session.candidateEmail } }],
      },
      saveToSentItems: true,
    }),
  });
  return res.ok;
}

async function saveSessionReview(token, request) {
  const user = await requireAdmin(request);
  const { notes, decision, stars, questionScores, notify } = await request.json();
  const prev = (await kvGet(`session:${token}:review`)) || {};
  await kvPut(`session:${token}:review`, {
    notes, decision,
    stars:          stars          || 0,
    questionScores: questionScores || {},
    reviewedAt:     Date.now(),
    outcomeEmailedDecision: prev.outcomeEmailedDecision || null,
  });
  // Mirror decision + stars onto the session for fast list rendering
  const session = await kvGet(`session:${token}`);
  if (session) {
    session.reviewDecision = decision;
    session.reviewStars    = stars || 0;
    await kvPut(`session:${token}`, session);
  }

  // Email the candidate the outcome — only when requested, the decision actually
  // changed since the last email (no spam on note edits), and they have an email.
  let emailed = false;
  if (notify && decision && session?.candidateEmail && decision !== prev.outcomeEmailedDecision) {
    try {
      const interview = await kvGet(`interview:${session.interviewId}`);
      emailed = await sendOutcomeEmail(session, interview, decision);
      if (emailed) {
        const r = await kvGet(`session:${token}:review`);
        r.outcomeEmailedDecision = decision;
        await kvPut(`session:${token}:review`, r);
      }
    } catch (e) { console.error('[outcome email]', e.message); }
  }

  // Log only when the decision changed (skip plain note/score edits).
  if (decision && decision !== prev.decision) {
    await logAudit(user, 'review_decision', `${session?.candidateName || token}: ${decision}${stars ? ` (${stars}★)` : ''}`);
  }
  return jsonRes({ ok: true, emailed });
}

async function getSessionReview(token, request) {
  await requireAdmin(request);
  const review = await kvGet(`session:${token}:review`);
  if (!review) return jsonRes({ notFound: true });
  return jsonRes(review);
}

// ── Interview Script handlers ─────────────────────────────────

async function listScriptClients(request) {
  await requireAdmin(request);
  const ids = (await kvGet('script:client:list')) || [];
  const clients = await Promise.all(ids.map(id => kvGet(`script:client:${id}`)));
  return jsonRes(clients.filter(Boolean));
}

async function createScriptClient(request) {
  await requireAdmin(request);
  const { name } = await request.json();
  if (!name) return jsonRes({ error: 'name required' }, 400);
  const id = uid();
  const client = { id, name, createdAt: Date.now() };
  await kvPut(`script:client:${id}`, client);
  const list = (await kvGet('script:client:list')) || [];
  list.unshift(id);
  await kvPut('script:client:list', list);
  return jsonRes(client, 201);
}

async function deleteScriptClient(id, request) {
  await requireAdmin(request);
  // Remove all positions belonging to this client
  const posIds = (await kvGet(`script:client:${id}:positions`)) || [];
  await Promise.all(posIds.map(pid => INTERVIEW_DATA.delete(`script:position:${pid}`)));
  await INTERVIEW_DATA.delete(`script:client:${id}:positions`);
  await INTERVIEW_DATA.delete(`script:client:${id}`);
  const list = (await kvGet('script:client:list')) || [];
  await kvPut('script:client:list', list.filter(i => i !== id));
  return jsonRes({ ok: true });
}

async function listScriptPositions(clientId, request) {
  await requireAdmin(request);
  const ids = (await kvGet(`script:client:${clientId}:positions`)) || [];
  const positions = await Promise.all(ids.map(id => kvGet(`script:position:${id}`)));
  return jsonRes(positions.filter(Boolean));
}

async function createScriptPosition(clientId, request) {
  await requireAdmin(request);
  const client = await kvGet(`script:client:${clientId}`);
  if (!client) return jsonRes({ error: 'Client not found' }, 404);
  const { name } = await request.json();
  if (!name) return jsonRes({ error: 'name required' }, 400);
  const id = uid();
  const position = { id, clientId, name, createdAt: Date.now() };
  await kvPut(`script:position:${id}`, position);
  const list = (await kvGet(`script:client:${clientId}:positions`)) || [];
  list.push(id);
  await kvPut(`script:client:${clientId}:positions`, list);
  return jsonRes(position, 201);
}

async function deleteScriptPosition(id, request) {
  await requireAdmin(request);
  const pos = await kvGet(`script:position:${id}`);
  if (!pos) return jsonRes({ error: 'Not found' }, 404);
  const list = (await kvGet(`script:client:${pos.clientId}:positions`)) || [];
  await kvPut(`script:client:${pos.clientId}:positions`, list.filter(p => p !== id));
  await INTERVIEW_DATA.delete(`script:position:${id}`);
  return jsonRes({ ok: true });
}

async function uploadScriptDoc(id, request) {
  await requireAdmin(request);
  const pos = await kvGet(`script:position:${id}`);
  if (!pos) return jsonRes({ error: 'Position not found' }, 404);
  try {
    const formData    = await request.formData();
    const file        = formData.get('file');
    if (!file) return jsonRes({ error: 'No file in request' }, 400);

    const fileName    = file.name || 'script.pdf';
    const ext         = fileName.split('.').pop().toLowerCase() || 'pdf';
    const mimeMap     = {
      pdf:  'application/pdf',
      doc:  'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';

    const client      = await kvGet(`script:client:${pos.clientId}`);
    const safeClient  = (client?.name  || 'Client')  .replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    const safePos     = pos.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    const filePath    = `CTI Interviews/Scripts/${safeClient}/${safePos}.${ext}`;

    const blob        = await file.arrayBuffer();
    const accessToken = await getAccessToken();
    const fileItem    = await uploadToOneDrive(filePath, blob, accessToken, contentType);

    pos.driveItemId = fileItem.id;
    pos.fileName    = fileName;
    pos.ext         = ext;
    pos.uploadedAt  = Date.now();
    await kvPut(`script:position:${id}`, pos);
    return jsonRes({ ok: true, fileName });
  } catch (e) {
    return jsonRes({ error: 'Upload failed: ' + e.message }, 500);
  }
}

async function getScriptDocUrl(id, request) {
  await requireAdmin(request);
  const pos = await kvGet(`script:position:${id}`);
  if (!pos?.driveItemId) return jsonRes({ notFound: true });
  try {
    const accessToken = await getAccessToken();
    const res  = await fetch(
      `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${pos.driveItemId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const item = await res.json();
    return jsonRes({
      downloadUrl: item['@microsoft.graph.downloadUrl'] || null,
      webUrl:      item.webUrl || null,
      fileName:    pos.fileName,
      ext:         pos.ext,
    });
  } catch (e) {
    return jsonRes({ error: e.message }, 500);
  }
}

async function uploadScriptClientLogo(id, request) {
  await requireAdmin(request);
  const client = await kvGet(`script:client:${id}`);
  if (!client) return jsonRes({ error: 'Client not found' }, 404);
  try {
    const formData    = await request.formData();
    const file        = formData.get('file');
    if (!file) return jsonRes({ error: 'No file in request' }, 400);

    const fileName    = file.name || 'logo.png';
    const ext         = fileName.split('.').pop().toLowerCase() || 'png';
    const contentType = file.type || 'image/png';
    const safeClient  = client.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    const filePath    = `CTI Interviews/Scripts/${safeClient}/logo.${ext}`;

    const blob        = await file.arrayBuffer();
    const accessToken = await getAccessToken();
    const fileItem    = await uploadToOneDrive(filePath, blob, accessToken, contentType);

    client.logoItemId = fileItem.id;
    client.logoExt    = ext;
    await kvPut(`script:client:${id}`, client);
    return jsonRes({ ok: true });
  } catch (e) {
    return jsonRes({ error: 'Logo upload failed: ' + e.message }, 500);
  }
}

async function getScriptClientLogoUrl(id, request) {
  await requireAdmin(request);
  const client = await kvGet(`script:client:${id}`);
  if (!client?.logoItemId) return jsonRes({ notFound: true });
  try {
    const accessToken = await getAccessToken();
    const res  = await fetch(
      `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${client.logoItemId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const item = await res.json();
    return jsonRes({ downloadUrl: item['@microsoft.graph.downloadUrl'] || null });
  } catch (e) {
    return jsonRes({ error: e.message }, 500);
  }
}

// ── Booking Interview handlers ────────────────────────────────

async function listBookingLinks(request) {
  const user = await requireAdmin(request);
  const tokens = (await kvGet('booking:link:list')) || [];
  const links = await Promise.all(tokens.map(t => kvGet(`booking:link:${t}`)));
  return jsonRes(links.filter(Boolean).filter(l => canAccess(l, user, 'view')));
}

async function createBookingLink(request) {
  const user = await requireAdmin(request);
  const { title, clientName, position, duration, tzOffset, daysAhead, slotRules, minNoticeHours } = await request.json();
  if (!title) return jsonRes({ error: 'title required' }, 400);
  if (!slotRules?.length) return jsonRes({ error: 'slotRules required' }, 400);

  const token = uid();
  const link = {
    token, title,
    clientName:     clientName || '',
    position:       position || '',
    duration:       duration || 30,
    tzOffset:       tzOffset ?? 0,
    daysAhead:      daysAhead || 14,
    minNoticeHours: minNoticeHours ?? 24,   // default: 24 h — prevents last-minute bookings
    slotRules,
    active:         true,
    createdAt:      Date.now(),
    ownerId:        user.id,
  };
  await kvPut(`booking:link:${token}`, link);
  const list = (await kvGet('booking:link:list')) || [];
  list.unshift(token);
  await kvPut('booking:link:list', list);
  return jsonRes(link, 201);
}

async function updateBookingLink(token, request) {
  const user = await requireAdmin(request);
  const existing = await kvGet(`booking:link:${token}`);
  if (!existing) return jsonRes({ error: 'Not found' }, 404);
  if (!canAccess(existing, user)) return jsonRes({ error: 'Forbidden' }, 403);
  const updates = await request.json();
  const updated = { ...existing, ...updates, ownerId: existing.ownerId || user.id };
  await kvPut(`booking:link:${token}`, updated);
  return jsonRes(updated);
}

async function deleteBookingLink(token, request) {
  const user = await requireAdmin(request);
  const existing = await kvGet(`booking:link:${token}`);
  if (existing && !canAccess(existing, user)) return jsonRes({ error: 'Forbidden' }, 403);
  // Delete all bookings for this link
  const bookingIds = (await kvGet(`booking:link:${token}:bookings`)) || [];
  await Promise.all(bookingIds.map(id => INTERVIEW_DATA.delete(`booking:booking:${id}`)));
  await INTERVIEW_DATA.delete(`booking:link:${token}:bookings`);
  await INTERVIEW_DATA.delete(`booking:link:${token}`);
  const list = (await kvGet('booking:link:list')) || [];
  await kvPut('booking:link:list', list.filter(t => t !== token));
  return jsonRes({ ok: true });
}

async function sendBookingInviteHandler(token, request) {
  const user = await requireAdmin(request);
  const link = await kvGet(`booking:link:${token}`);
  if (!link) return jsonRes({ error: 'Booking link not found' }, 404);
  if (!canAccess(link, user)) return jsonRes({ error: 'Forbidden' }, 403);
  const { candidateName, candidateEmail, bookUrl } = await request.json();
  if (!candidateName || !candidateEmail || !bookUrl) {
    return jsonRes({ error: 'candidateName, candidateEmail and bookUrl are required' }, 400);
  }

  // Generate a personalized invite token so the booking page can pre-fill candidate info
  const inviteToken = uid();
  await INTERVIEW_DATA.put(
    `booking:invite:${inviteToken}`,
    JSON.stringify({
      candidateName:  candidateName.trim(),
      candidateEmail: candidateEmail.trim(),
      linkToken:      token,
      used:           false,
      createdAt:      Date.now(),
    }),
    { expirationTtl: 60 * 60 * 24 * 30 } // 30-day expiry
  );

  // Append invite token to booking URL so the page knows who is booking
  const personalizedUrl = `${bookUrl}&inv=${inviteToken}`;
  await sendBookingInviteEmail(candidateName.trim(), candidateEmail.trim(), link, personalizedUrl);
  return jsonRes({ ok: true });
}

async function getBookingInviteHandler(inviteToken) {
  if (!inviteToken) return jsonRes({ error: 'Missing invite token' }, 400);
  const raw = await INTERVIEW_DATA.get(`booking:invite:${inviteToken}`);
  if (!raw) return jsonRes({ error: 'Invite link is invalid or has expired' }, 404);
  const invite = JSON.parse(raw);
  if (invite.used) return jsonRes({ error: 'This invite link has already been used', reason: 'ALREADY_BOOKED' }, 410);
  // Return candidate info — frontend uses this to pre-fill & lock the form
  return jsonRes({
    candidateName:  invite.candidateName,
    candidateEmail: invite.candidateEmail,
    linkToken:      invite.linkToken,
  });
}

async function sendBookingInviteEmail(candidateName, candidateEmail, link, bookUrl) {
  const sender = EMAIL_SENDER;
  const html = emailWrap('#B01A18', 'Interview Invitation', `
    <p style="margin:0 0 16px 0;font-size:15px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif">Dear <strong>${candidateName}</strong>,</p>
    <p style="margin:0 0 20px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">You have been invited to schedule an interview with <strong>CTI Group Worldwide Services, Inc.</strong> Please use the link below to choose a time that works best for you.</p>
    ${emailInfoBox('#B01A18', link.title, link.clientName ? (link.clientName + (link.position ? ' &middot; ' + link.position : '')) : '')}
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:20px">
      <tr>
        <td width="120" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Format</td>
        <td style="padding:8px 0;color:#1a1a1a;font-size:14px;font-family:Arial,Helvetica,sans-serif">Microsoft Teams (video)</td>
      </tr>
      <tr>
        <td width="120" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Duration</td>
        <td style="padding:8px 0;color:#1a1a1a;font-size:14px;font-family:Arial,Helvetica,sans-serif">${link.duration || 30} minutes</td>
      </tr>
    </table>
    ${emailButton(bookUrl, 'Book Your Interview Time')}
    <p style="margin:16px 0 4px 0;color:#6b7280;font-size:12px;text-align:center;font-family:Arial,Helvetica,sans-serif">Or copy this link:</p>
    <p style="margin:0;color:#6b7280;font-size:12px;text-align:center;word-break:break-all;font-family:Arial,Helvetica,sans-serif"><a href="${bookUrl}" style="color:#B01A18;text-decoration:underline">${bookUrl}</a></p>
  `);

  const accessToken = await getAccessToken();
  await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `Interview Invitation: ${link.title} — ${candidateName} — CTI ZeusHire`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ZeusHire', address: sender } },
        toRecipients: [{ emailAddress: { address: candidateEmail } }],
      },
      saveToSentItems: true,
    }),
  });
}

async function listLinkBookings(token, request) {
  const user = await requireAdmin(request);
  const link = await kvGet(`booking:link:${token}`);
  if (!link) return jsonRes({ error: 'Not found' }, 404);
  if (!canAccess(link, user, 'view')) return jsonRes({ error: 'Forbidden' }, 403);
  const ids = (await kvGet(`booking:link:${token}:bookings`)) || [];
  const bookings = await Promise.all(ids.map(id => kvGet(`booking:booking:${id}`)));
  return jsonRes(bookings.filter(b => b && b.status !== 'cancelled'));
}

async function cancelBookingHandler(bookingId, request) {
  const user = await requireAdmin(request);
  const booking = await kvGet(`booking:booking:${bookingId}`);
  if (!booking) return jsonRes({ error: 'Not found' }, 404);
  if (booking.linkToken) {
    const link = await kvGet(`booking:link:${booking.linkToken}`);
    if (link && !canAccess(link, user)) return jsonRes({ error: 'Forbidden' }, 403);
  }

  booking.status      = 'cancelled';
  booking.cancelledAt = Date.now();
  await kvPut(`booking:booking:${bookingId}`, booking);

  // Free up the slot-lock keys (delete both global and legacy per-link format
  // so cancellations work correctly for bookings made before this deployment)
  await Promise.all([
    INTERVIEW_DATA.delete(`booking:slot:global:${booking.slotStart}`),
    INTERVIEW_DATA.delete(`booking:slot:${booking.linkToken}:${booking.slotStart}`),
  ]);

  // ── Delete Teams calendar event ───────────────────────────────
  if (booking.calendarEventId) {
    try {
      const accessToken = await getAccessToken();
      const organizer   = booking.organizerEmail || EMAIL_SENDER || ONEDRIVE_USER;
      await fetch(
        `https://graph.microsoft.com/v1.0/users/${organizer}/calendar/events/${booking.calendarEventId}`,
        { method: 'DELETE', headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
    } catch (e) {
      console.error('[booking] calendar delete failed:', e.message);
    }
  }

  // ── Send cancellation email to candidate ──────────────────────
  let emailSent = false;
  let emailError = null;
  try {
    const link = await kvGet(`booking:link:${booking.linkToken}`);
    await sendBookingCancellationEmail(booking, link || {});
    emailSent = true;
  } catch (e) {
    emailError = e.message;
    console.error('[booking] cancellation email failed:', e.message);
  }

  return jsonRes({ ok: true, emailSent, emailError });
}

// ── Shareable Review Links ────────────────────────────────────

async function createShareLink(token, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);

  const body = await request.json().catch(() => ({}));
  const mode = body.mode === 'client' ? 'client' : 'coworker';

  session.shareTokens = session.shareTokens || {};
  // Migrate any legacy single shareToken into the coworker slot.
  if (session.shareToken && !session.shareTokens.coworker) {
    session.shareTokens.coworker = session.shareToken;
    await kvPut(`share:${session.shareToken}`, { token, mode: 'coworker' });
  }

  let shareToken = session.shareTokens[mode];
  if (!shareToken) {
    shareToken = uid();
    session.shareTokens[mode] = shareToken;
    await kvPut(`share:${shareToken}`, { token, mode });
  }
  await kvPut(`session:${token}`, session);
  return jsonRes({ shareToken, mode });
}

// Resolve a share record (object {token,mode} or legacy plain token string).
function parseShareRec(rec) {
  if (!rec) return null;
  if (typeof rec === 'string') return { token: rec, mode: 'coworker' };
  return { token: rec.token, mode: rec.mode || 'coworker' };
}

async function getShare(shareToken) {
  const share = parseShareRec(await kvGet(`share:${shareToken}`));
  if (!share) return jsonRes({ error: 'Share link not found' }, 404);
  const token = share.token, mode = share.mode;
  const session   = await kvGet(`session:${token}`);
  if (!session)   return jsonRes({ error: 'Session not found' }, 404);
  const interview = await kvGet(`interview:${session.interviewId}`);
  const review    = await kvGet(`session:${token}:review`);
  const settings  = (await kvGet('recruiter:settings')) || {};
  const branding  = {
    brandName:       settings.brandName       || '',
    brandColor:      settings.brandColor      || '',
    brandWelcomeMsg: settings.brandWelcomeMsg || '',
    brandLogoUrl:    settings.brandLogoUrl    || '',
  };
  // Don't expose other reviewers' feedback to a reviewer (avoid biasing them).
  const { reviewerFeedback, ...pubSession } = session;

  // CLIENT mode (upsell): videos + résumé only — strip recruiter notes/decision
  // and the candidate's email so the client can't bypass the recruiter.
  if (mode === 'client') {
    delete pubSession.candidateEmail;
    return jsonRes({ session: pubSession, interview, review: null, mode, shareToken, branding });
  }
  // CO-WORKER mode: full review (notes/decision) + feedback form.
  return jsonRes({ session: pubSession, interview, review: review || null, mode, shareToken, branding });
}

// Recruiter opened the review — stamp "last seen" so reviewer feedback submitted
// before now is no longer flagged as new on the candidate list.
async function markFeedbackSeen(token, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  session.feedbackSeenAt = Date.now();
  await kvPut(`session:${token}`, session);
  return jsonRes({ ok: true });
}

// Reviewers (via a share link) submit their own rating/recommendation/comments
// for the recruiter to consider. Appended to the session; multiple reviewers OK.
async function submitShareFeedback(shareToken, request) {
  const share = parseShareRec(await kvGet(`share:${shareToken}`));
  if (!share) return jsonRes({ error: 'Share link not found' }, 404);
  if (share.mode === 'client') return jsonRes({ error: 'Feedback not enabled for this link' }, 403);
  const token = share.token;
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);

  const body = await request.json().catch(() => ({}));
  const reviewerName = (body.reviewerName || '').toString().slice(0, 120).trim();
  if (!reviewerName) return jsonRes({ error: 'Reviewer name required' }, 400);
  const stars = (Number.isInteger(body.stars) && body.stars >= 0 && body.stars <= 5) ? body.stars : 0;
  const recommendation = ['move_forward', 'maybe', 'pass'].includes(body.recommendation) ? body.recommendation : '';
  const comment = (body.comment || '').toString().slice(0, 4000).trim();
  if (!stars && !recommendation && !comment) return jsonRes({ error: 'Empty feedback' }, 400);

  session.reviewerFeedback = session.reviewerFeedback || [];
  session.reviewerFeedback.push({ reviewerName, stars, recommendation, comment, submittedAt: Date.now() });
  await kvPut(`session:${token}`, session);
  return jsonRes({ ok: true });
}

async function getShareResume(shareToken) {
  const share = parseShareRec(await kvGet(`share:${shareToken}`));
  if (!share) return jsonRes({ error: 'Share link not found' }, 404);
  const session = await kvGet(`session:${share.token}`);
  if (!session?.resumeItemId) return jsonRes({ notFound: true });
  try {
    const accessToken = await getAccessToken();
    const [item, previewUrl] = await Promise.all([
      fetch(`https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${session.resumeItemId}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }).then(r => r.json()),
      drivePreviewUrl(session.resumeItemId, accessToken),
    ]);
    return jsonRes({
      downloadUrl: item['@microsoft.graph.downloadUrl'] || null,
      previewUrl,
      fileName:    session.resumeFileName || 'resume.pdf',
      ext:         session.resumeExt      || 'pdf',
    });
  } catch (e) {
    return jsonRes({ error: e.message }, 500);
  }
}

async function getShareVideo(shareToken, qIndex) {
  const share = parseShareRec(await kvGet(`share:${shareToken}`));
  if (!share) return jsonRes({ error: 'Share link not found' }, 404);
  const session = await kvGet(`session:${share.token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  const response = session.responses?.find(r => r.questionIndex === qIndex);
  if (!response?.driveItemId) return jsonRes({ error: 'Video not found' }, 404);
  try {
    const accessToken = await getAccessToken();
    const itemRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${response.driveItemId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const item = await itemRes.json();
    return jsonRes({ downloadUrl: item['@microsoft.graph.downloadUrl'], webUrl: item.webUrl });
  } catch (e) {
    return jsonRes({ error: 'Could not retrieve video' }, 500);
  }
}

// ─────────────────────────────────────────────────────────────
//  Premium Talent Library
// ─────────────────────────────────────────────────────────────

// Resolve a OneDrive item's temporary download URL.
async function driveDownloadUrl(itemId) {
  const accessToken = await getAccessToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${itemId}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const item = await res.json();
  return { downloadUrl: item['@microsoft.graph.downloadUrl'] || null, webUrl: item.webUrl || null };
}

// Recruiter adds a candidate to the Premium Talent. AUTHORITATIVE 4★ gate:
// re-reads the saved review so the UI can't be bypassed.
async function addToPremium(token, request) {
  const user = await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  const review = await kvGet(`session:${token}:review`);
  const stars = review?.stars || session.reviewStars || 0;
  if (stars < 4) return jsonRes({ error: 'Candidate must be rated 4★ or 5★ to add to the Premium Talent.' }, 403);

  const { category, department, role } = await request.json().catch(() => ({}));
  if (!category || !department || !role) return jsonRes({ error: 'category, department and role are required' }, 400);

  session.premium = {
    status:     'Available',
    category:   String(category).slice(0, 80),
    department: String(department).slice(0, 80),
    role:       String(role).slice(0, 80),
    stars,
    addedAt:    Date.now(),
    interests:  session.premium?.interests || [],
    takenAt:    null,
    takenBy:    null,
  };
  await kvPut(`session:${token}`, session);
  const list = (await kvGet('premium:list')) || [];
  if (!list.includes(token)) { list.push(token); await kvPut('premium:list', list); }
  await logAudit(user, 'premium_add', `${session.candidateName || token} · ${category} / ${department} / ${role} (${stars}★)`);
  return jsonRes({ ok: true, premium: session.premium });
}

async function removeFromPremium(token, request) {
  const user = await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  delete session.premium;
  await kvPut(`session:${token}`, session);
  const list = ((await kvGet('premium:list')) || []).filter(t => t !== token);
  await kvPut('premium:list', list);
  await logAudit(user, 'premium_remove', session.candidateName || token);
  return jsonRes({ ok: true });
}

// Admin marks a premium talent as Taken (hired) — removes them from the
// client-facing library. Only the recruiter does this, after an actual hire.
async function markPremiumTaken(token, request) {
  const user = await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session?.premium) return jsonRes({ error: 'Not a premium talent' }, 404);
  session.premium.status = 'Taken';
  session.premium.takenAt = Date.now();
  await kvPut(`session:${token}`, session);
  await logAudit(user, 'premium_taken', session.candidateName || token);
  return jsonRes({ ok: true });
}

// Admin reverts a Taken candidate back to Available (e.g. hire fell through).
async function markPremiumAvailable(token, request) {
  const user = await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session?.premium) return jsonRes({ error: 'Not a premium talent' }, 404);
  session.premium.status = 'Available';
  session.premium.takenAt = null;
  await kvPut(`session:${token}`, session);
  await logAudit(user, 'premium_available', session.candidateName || token);
  return jsonRes({ ok: true });
}

// Admin management list — every premium talent (any status) + interests.
async function listPremium(request) {
  await requireAdmin(request);
  const tokens = (await kvGet('premium:list')) || [];
  const sessions = await Promise.all(tokens.map(t => kvGet(`session:${t}`)));
  const premium = sessions.filter(s => s && s.premium).map(s => ({
    token:              s.token,
    candidateName:      s.candidateName,
    candidateEmail:     s.candidateEmail || '',
    interviewId:        s.interviewId,
    profilePhotoItemId: s.profilePhotoItemId || null,
    reviewStars:        s.reviewStars || s.premium.stars || 0,
    premium:            s.premium,
  }));
  return jsonRes({ premium });
}

// ── Client library access (tokenized, no login) ──
async function createClientLib(request) {
  const user = await requireAdmin(request);
  const { label } = await request.json().catch(() => ({}));
  const clientToken = uid();
  await kvPut(`clientlib:${clientToken}`, { label: (label || 'Client').slice(0, 80), createdAt: Date.now() });
  const list = (await kvGet('clientlib:list')) || [];
  list.push(clientToken); await kvPut('clientlib:list', list);
  await logAudit(user, 'clientlib_create', label || 'Client');
  return jsonRes({ clientToken, label: label || 'Client' });
}

async function listClientLibs(request) {
  await requireAdmin(request);
  const tokens = (await kvGet('clientlib:list')) || [];
  const links = (await Promise.all(tokens.map(async t => {
    const meta = await kvGet(`clientlib:${t}`);
    return meta ? { clientToken: t, label: meta.label, createdAt: meta.createdAt } : null;
  }))).filter(Boolean);
  return jsonRes({ links });
}

// Revoke a client library link — the URL stops working immediately.
async function deleteClientLib(token, request) {
  const user = await requireAdmin(request);
  const meta = await kvGet(`clientlib:${token}`);
  await INTERVIEW_DATA.delete(`clientlib:${token}`);
  const list = (await kvGet('clientlib:list')) || [];
  await kvPut('clientlib:list', list.filter(t => t !== token));
  await logAudit(user, 'clientlib_revoke', meta?.label || token);
  return jsonRes({ ok: true });
}

// PUBLIC (client token). HARD ACL: only premium talent with status
// 'Available' are ever returned, and only safe fields (no email/notes/review).
async function getClientLib(clientToken) {
  const meta = await kvGet(`clientlib:${clientToken}`);
  if (!meta) return jsonRes({ error: 'Library link not found' }, 404);

  const settings = (await kvGet('recruiter:settings')) || {};
  const branding = {
    brandName:  settings.brandName  || '',
    brandColor: settings.brandColor || '',
    brandLogoUrl: settings.brandLogoUrl || '',
  };

  const tokens = (await kvGet('premium:list')) || [];
  const sessions = await Promise.all(tokens.map(t => kvGet(`session:${t}`)));
  const available = sessions.filter(s => s && s.premium && s.premium.status === 'Available');

  const candidates = await Promise.all(available.map(async s => {
    const interview = await kvGet(`interview:${s.interviewId}`);
    const qs = interview?.questions || [];
    const videos = (s.responses || [])
      .filter(r => (r.answerType || 'video') === 'video' && r.driveItemId)
      .map(r => ({ questionIndex: r.questionIndex, text: qs[r.questionIndex]?.text || `Question ${r.questionIndex + 1}` }))
      .sort((a, b) => a.questionIndex - b.questionIndex);
    const alreadyInterested = (s.premium.interests || []).some(i => i.clientToken === clientToken);
    return {
      token:              s.token,
      candidateName:      s.candidateName,
      profilePhotoItemId: s.profilePhotoItemId || null,
      category:           s.premium.category,
      department:         s.premium.department,
      role:               s.premium.role,
      overview:           s.premium.overview || '',
      videos,
      alreadyInterested,
    };
  }));

  return jsonRes({ label: meta.label, branding, candidates });
}

// Guard: a clientlib token may only touch premium + Available candidates.
async function clientLibCandidate(clientToken, token) {
  if (!(await kvGet(`clientlib:${clientToken}`))) return { err: jsonRes({ error: 'Library link not found' }, 404) };
  const session = await kvGet(`session:${token}`);
  if (!session?.premium || session.premium.status !== 'Available') return { err: jsonRes({ error: 'Candidate not available' }, 403) };
  return { session };
}

async function getClientLibVideo(clientToken, token, qIndex) {
  const { err, session } = await clientLibCandidate(clientToken, token);
  if (err) return err;
  const response = session.responses?.find(r => r.questionIndex === qIndex);
  if (!response?.driveItemId) return jsonRes({ error: 'Video not found' }, 404);
  try { return jsonRes(await driveDownloadUrl(response.driveItemId)); }
  catch (e) { return jsonRes({ error: 'Could not retrieve video' }, 500); }
}

async function getClientLibResume(clientToken, token) {
  // Privacy: clients no longer get the résumé file (it contains contact info).
  // They see the contact-free Overview instead. Endpoint kept but access denied.
  return jsonRes({ error: 'Résumé is not shared with clients. See the candidate Overview.' }, 403);
  // eslint-disable-next-line no-unreachable
  const { err, session } = await clientLibCandidate(clientToken, token);
  if (err) return err;
  if (!session.resumeItemId) return jsonRes({ notFound: true });
  try {
    const accessToken = await getAccessToken();
    const [item, previewUrl] = await Promise.all([
      fetch(`https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${session.resumeItemId}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }).then(r => r.json()),
      drivePreviewUrl(session.resumeItemId, accessToken),
    ]);
    return jsonRes({ downloadUrl: item['@microsoft.graph.downloadUrl'] || null, previewUrl, ext: session.resumeExt || 'pdf' });
  } catch (e) { return jsonRes({ error: e.message }, 500); }
}

// Email a client their library link.
async function sendClientLibEmail(clientToken, request) {
  await requireAdmin(request);
  const meta = await kvGet(`clientlib:${clientToken}`);
  if (!meta) return jsonRes({ error: 'Library link not found' }, 404);
  const { emails, url } = await request.json();
  if (!emails?.length || !url) return jsonRes({ error: 'emails and url required' }, 400);
  const toRecipients = emails.map(e => e.trim()).filter(e => e.includes('@')).map(e => ({ emailAddress: { address: e } }));
  if (!toRecipients.length) return jsonRes({ error: 'No valid email addresses' }, 400);

  const graphToken = await getAccessToken();
  const bodyRows = `
    <p style="font-family:Arial,sans-serif;font-size:15px;color:#333;margin:0 0 16px">Hello ${htmlEsc(meta.label)},</p>
    <p style="font-family:Arial,sans-serif;font-size:14px;color:#374151;line-height:22px;margin:0 0 16px">
      You have been given private access to <strong>CTI Group's Premium Talent</strong> — a curated pool of top-rated, pre-screened talent. Browse their video answers and résumés, filter by category, department and role, and mark anyone you're <strong>interested</strong> in.
    </p>
    ${emailButton(url, 'Browse Premium Talent')}
    <p style="font-family:Arial,sans-serif;font-size:12px;color:#6b7280;margin:20px 0 4px">Or copy this link into your browser:</p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td bgcolor="#f3f4f6" style="background-color:#f3f4f6;padding:10px;word-break:break-all">
        <p style="margin:0;color:#6b7280;font-size:12px;font-family:Arial,sans-serif;word-break:break-all">${url}</p>
      </td>
    </tr></table>
    <p style="font-family:Arial,sans-serif;font-size:12px;color:#aaa;margin:20px 0 0;text-align:center">This is a private link — no login required.</p>`;

  await fetch(`https://graph.microsoft.com/v1.0/users/${EMAIL_SENDER}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${graphToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `CTI ZeusHire — Premium Talent Access`,
        body: { contentType: 'HTML', content: emailWrap('#B01A18', 'Premium Talent', bodyRows) },
        from: { emailAddress: { name: 'CTI ZeusHire', address: EMAIL_SENDER } },
        toRecipients,
      },
      saveToSentItems: true,
    }),
  });
  return jsonRes({ ok: true });
}

// Client raises their hand. Does NOT change Available status — just logs interest
// for the recruiter; the recruiter later marks "Taken" if the client hires.
async function clientExpressInterest(clientToken, token, request) {
  const meta = await kvGet(`clientlib:${clientToken}`);
  if (!meta) return jsonRes({ error: 'Library link not found' }, 404);
  const session = await kvGet(`session:${token}`);
  if (!session?.premium || session.premium.status !== 'Available') return jsonRes({ error: 'Candidate not available' }, 403);
  session.premium.interests = session.premium.interests || [];
  const existing = session.premium.interests.find(i => i.clientToken === clientToken);
  if (!existing) {
    session.premium.interests.push({ clientToken, clientLabel: meta.label || 'Client', at: Date.now() });
    await kvPut(`session:${token}`, session);
  }
  return jsonRes({ ok: true });
}

// Manually set/edit the client-facing Overview text on a premium candidate.
async function setPremiumOverview(token, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session?.premium) return jsonRes({ error: 'Not a premium candidate' }, 404);
  const { overview } = await request.json().catch(() => ({}));
  session.premium.overview = String(overview || '').slice(0, 2000);
  await kvPut(`session:${token}`, session);
  return jsonRes({ ok: true, overview: session.premium.overview });
}

// AI-generate a contact-free CV Overview from the candidate's résumé (PDF) and
// store it on the premium record. Explicitly strips email/phone/address.
async function generatePremiumOverview(token, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session?.premium) return jsonRes({ error: 'Not a premium candidate' }, 404);

  // Groq can't parse PDFs server-side, so the admin extracts the résumé text in
  // the browser (pdf.js) and posts it here as `resumeText`. If that's missing,
  // we fall back to the candidate's transcribed interview answers (stored by
  // English Analysis at session:{token}:analysis).
  let resumeText = '';
  try { resumeText = ((await request.json()) || {}).resumeText || ''; } catch {}
  resumeText = String(resumeText).replace(/\s+/g, ' ').trim();

  let sourceLabel, sourceText;
  if (resumeText.length >= 80) {
    sourceLabel = 'résumé';
    sourceText  = resumeText.slice(0, 12000);
  } else {
    const analysis = await kvGet(`session:${token}:analysis`);
    const qparts = (analysis?.questions || [])
      .map(q => {
        const t = (q.transcript || '').trim();
        if (!t || q.error) return '';
        return `Q: ${q.qText || ''}\nA: ${t}`;
      })
      .filter(Boolean);
    if (!qparts.length) {
      return jsonRes({ error: 'Could not read the résumé text. Make sure a text-based PDF résumé is uploaded (scanned-image PDFs can\'t be read), or type an overview manually.' }, 400);
    }
    sourceLabel = 'interview answers';
    sourceText  = qparts.join('\n\n').slice(0, 8000);
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const prompt = `Below is a job candidate's ${sourceLabel}. Write a concise professional profile for a hiring client, in a clean, easy-to-scan format.

Today's date is ${todayStr}.

${sourceLabel.toUpperCase()}:
${sourceText}

Output EXACTLY this structure (plain text, no markdown headings):
- A 1–2 sentence summary paragraph (who they are, total/apparent experience, strongest area). If the source states the candidate's age or date of birth, state it as a clear, natural sentence, e.g. "Angelicia is currently 28 years old." (place it as its own short sentence, NOT as an inline aside like "Angelicia, 28, is …"). When only a date of birth is given, compute the age from today's date. If no age or date of birth appears in the source, do NOT mention age and do NOT guess.
- Then a blank line.
- Then 3–6 short bullet points, each on its OWN line starting with "• ". Keep each bullet under ~18 words.
  IMPORTANT: include the NAMES of past employers / properties / companies / ships / hotels / restaurants where they worked, with the role and (if stated) duration — e.g. "• Pastry Chef at Carnival Cruise Line (2 yrs)". Then add bullets for key skills and education.

Keep the whole thing under ~150 words. Write in third person, based ONLY on the source — do not invent facts; if a property/employer name isn't in the source, don't make one up.
STRICT: do NOT include any email, phone/mobile/home number, address, links, or other personal contact details (age and date of birth are allowed). Use ONLY the bullet character "• " (never ❖ or *). Output only the overview.`;

  let text = '';
  try {
    text = (await groqChat(prompt, 500)).trim();
  } catch (e) {
    return jsonRes({ error: 'AI error: ' + e.message }, 502);
  }
  if (!text) return jsonRes({ error: 'AI returned no summary — try again or type one manually.' }, 502);

  session.premium.overview = text.slice(0, 2000);
  await kvPut(`session:${token}`, session);
  return jsonRes({ ok: true, overview: session.premium.overview });
}

// Remove a client's "interested" mark from a premium candidate. With a
// clientToken, removes just that client; without one, clears all interests.
async function clearPremiumInterest(token, clientToken, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session?.premium) return jsonRes({ error: 'Not a premium candidate' }, 404);
  session.premium.interests = clientToken
    ? (session.premium.interests || []).filter(i => i.clientToken !== clientToken)
    : [];
  await kvPut(`session:${token}`, session);
  return jsonRes({ ok: true, interests: session.premium.interests });
}

// ── Recruiter Settings ────────────────────────────────────────

async function getRecruiterSettings(request) {
  await requireAdmin(request);
  return jsonRes(await kvGet('recruiter:settings') || { linkedCalendars: [] });
}

async function updateRecruiterSettings(request) {
  await requireAdmin(request);
  const updates  = await request.json();
  const existing = (await kvGet('recruiter:settings')) || {};
  const updated  = { ...existing, ...updates };
  await kvPut('recruiter:settings', updated);
  return jsonRes(updated);
}

// ── Per-recruiter linked calendars ───────────────────────────
// Each recruiter keeps their own list of extra mailboxes to cross-check for
// busy times. Stored on the user record so it only affects that recruiter's
// own booking links.
async function getMyCalendars(request) {
  const user = await requireAdmin(request);
  let cals = [];
  if (user.id && user.id !== 'admin') {
    const u = await kvGet(`user:${user.id}`);
    cals = (u && u.linkedCalendars) || [];
  }
  return jsonRes({ linkedCalendars: cals });
}

async function setMyCalendars(request) {
  const user = await requireAdmin(request);
  if (!user.id || user.id === 'admin') {
    return jsonRes({ error: 'Sign in with your Microsoft account to manage your linked calendars.' }, 400);
  }
  const body = await request.json();
  const cals = Array.isArray(body.linkedCalendars)
    ? [...new Set(body.linkedCalendars.map(e => String(e).trim().toLowerCase()).filter(Boolean))]
    : [];
  const u = await kvGet(`user:${user.id}`);
  if (!u) return jsonRes({ error: 'User not found' }, 404);
  u.linkedCalendars = cals;
  await kvPut(`user:${user.id}`, u);
  return jsonRes({ linkedCalendars: cals });
}

async function testLinkedCalendar(request) {
  await requireAdmin(request);
  const { email } = await request.json();
  if (!email) return jsonRes({ error: 'email required' }, 400);

  const accessToken = await getAccessToken();
  const startStr = new Date().toISOString().replace('Z', '');
  const endStr   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace('Z', '');

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/calendarView` +
    `?startDateTime=${startStr}&endDateTime=${endStr}&$select=subject,start,end,showAs&$top=5`,
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'Prefer': 'outlook.timezone="UTC"' } }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return jsonRes({
      ok: false,
      error: `Graph API error (${res.status}): ${err.error?.message || 'Cannot read this calendar.'}`,
      hint: res.status === 403
        ? 'Check that the Azure App has Calendars.Read.All (Application) permission and admin consent has been granted.'
        : 'Verify the email belongs to your Microsoft 365 tenant.',
    });
  }

  const data = await res.json();
  const count = data.value?.length ?? 0;
  return jsonRes({ ok: true, message: `Connected — ${count} event(s) found in the next 7 days.`, email });
}

// ── Multi-Calendar Busy Range Fetcher ────────────────────────
//
// Architecture note: the Azure App uses Application-level permissions
// (Calendars.ReadWrite.All), so the same access token that manages
// corporate-recruiter@cti-usa.com can also READ any other user's
// calendar in the tenant — no separate OAuth flow is required.
//
// Busy ranges are KV-cached per email for 5 minutes so that concurrent
// candidates loading the booking page don't each trigger a Graph API round-trip.
//
// Failure mode: if a linked calendar is unreachable (e.g. user disabled,
// Graph 429 rate-limit), the function returns [] — slots remain available
// rather than blocking the entire booking page (fail-open by design).
// The error is logged so the admin can investigate.
async function fetchOutlookBusyRanges(email, windowStartMs, windowEndMs, accessToken) {
  // ── Cache check (KV, 5-min TTL) ──────────────────────────────
  const cacheKey = `calendar:busy:${email}`;
  try {
    const cached = await kvGet(cacheKey);
    if (
      cached &&
      (Date.now() - cached.cachedAt) < 5 * 60 * 1000 &&
      cached.windowStart <= windowStartMs &&
      cached.windowEnd   >= windowEndMs
    ) {
      console.log(`[cal-sync] cache HIT ${email}: ${cached.ranges.length} ranges`);
      return cached.ranges;
    }
  } catch { /* cache miss — continue to live fetch */ }

  // ── Live fetch from Microsoft Graph calendarView ──────────────
  const startStr = new Date(windowStartMs).toISOString().replace('Z', '');
  const endStr   = new Date(windowEndMs).toISOString().replace('Z', '');
  const headers  = {
    'Authorization': `Bearer ${accessToken}`,
    'Prefer':        'outlook.timezone="UTC"',
  };

  let allEvents = [];
  let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/calendarView` +
    `?startDateTime=${startStr}&endDateTime=${endStr}` +
    `&$select=subject,start,end,showAs,isAllDay&$top=100`;

  try {
    // Follow @odata.nextLink pagination — a heavy recruiter calendar can exceed 100 events
    while (url) {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error(`[cal-sync] calendarView ${email} → ${res.status}: ${err.error?.message || ''}`);
        return []; // fail-open
      }
      const data = await res.json();
      allEvents.push(...(data.value || []));
      url = data['@odata.nextLink'] || null;
      if (allEvents.length > 500) break; // safety cap (prevent infinite loop)
    }
  } catch (e) {
    console.error(`[cal-sync] fetch error ${email}:`, e.message);
    return []; // fail-open — network/timeout
  }

  // Keep only events that actually block time (exclude 'free' and 'workingElsewhere')
  const blocked = ['busy', 'tentative', 'oof'];
  const ranges = allEvents
    .filter(evt => blocked.includes(evt.showAs))
    .map(evt => ({
      // Graph returns dateTime WITHOUT 'Z' when Prefer:UTC is set — append it
      start: new Date(evt.start.dateTime + 'Z').getTime(),
      end:   new Date(evt.end.dateTime   + 'Z').getTime(),
    }))
    .filter(r => !isNaN(r.start) && !isNaN(r.end) && r.end > r.start);

  console.log(`[cal-sync] live fetch ${email}: ${allEvents.length} events → ${ranges.length} blocked ranges`);

  // ── Write to KV cache with 5-min TTL ─────────────────────────
  try {
    await INTERVIEW_DATA.put(cacheKey, JSON.stringify({
      cachedAt: Date.now(), windowStart: windowStartMs, windowEnd: windowEndMs, ranges,
    }), { expirationTtl: 300 });
  } catch { /* cache write failure is non-fatal */ }

  return ranges;
}

// ── Slot generation (public) ──────────────────────────────────

// blockedDates:  Set of 'YYYY-MM-DD' strings  (Step 2 — holiday protection)
// blockedRanges: Array of { start, end } UTC ms (Step 4 — ALL confirmed bookings
//                across every link + direct-invite tw-sessions).
//                Uses overlap arithmetic instead of exact-start matching so that
//                a 30-min booking correctly blocks a 60-min slot on another link
//                that shares the same start time.
function generateBookingSlots(link, blockedRanges, blockedDates = new Set()) {
  const { slotRules = [], duration = 30, daysAhead = 14, tzOffset = 0, minNoticeHours = 2 } = link;
  const durationMs  = duration * 60 * 1000;
  const tzOffsetMs  = tzOffset * 60 * 1000;
  const now         = Date.now();
  // cutoffMs: the earliest UTC ms a slot may start — enforces the minimum scheduling notice.
  // Slots starting at or before this threshold are hidden from candidates.
  // Default 2h preserves original behaviour for links created before this field existed.
  const cutoffMs    = now + minNoticeHours * 60 * 60 * 1000;
  const slots       = [];

  for (let d = 0; d < daysAhead; d++) {
    const checkMs   = now + d * 24 * 60 * 60 * 1000;
    const localMs   = checkMs + tzOffsetMs;
    const localDate = new Date(localMs);
    const weekday   = localDate.getUTCDay();

    const y  = localDate.getUTCFullYear();
    const mo = localDate.getUTCMonth();
    const dy = localDate.getUTCDate();

    // ── Step 2: Holiday hard-block — wipe entire day if it's a holiday ──
    const localDateStr = `${y}-${String(mo + 1).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
    if (blockedDates.has(localDateStr)) continue;

    // ── Step 1: Check recruiter's weekly template ────────────────
    const dayRules = slotRules.filter(r => r.day === weekday);
    if (!dayRules.length) continue;

    // UTC of local midnight: local midnight = UTC midnight - tzOffset
    const localMidnightUtc = Date.UTC(y, mo, dy) - tzOffsetMs;

    for (const rule of dayRules) {
      const [fh, fm] = rule.from.split(':').map(Number);
      const [th, tm] = rule.to.split(':').map(Number);
      const startUtc = localMidnightUtc + (fh * 60 + fm) * 60 * 1000;
      const endUtc   = localMidnightUtc + (th * 60 + tm) * 60 * 1000;

      let t = startUtc;
      while (t + durationMs <= endUtc) {
        if (t > cutoffMs) {
          // Overlap check: slot [t, t+duration] is taken if ANY blocked range
          // intersects it. Two intervals overlap when: startA < endB && endA > startB
          const slotEnd  = t + durationMs;
          const isBooked = blockedRanges.some(r => t < r.end && slotEnd > r.start);
          slots.push({ start: t, end: slotEnd, booked: isBooked });
        }
        t += durationMs;
      }
    }
  }
  return slots;
}

async function getBookingSlots(token) {
  // ── Step 1: Fetch recruiter's availability template ──────────
  const link = await kvGet(`booking:link:${token}`);
  if (!link) return jsonRes({ error: 'Booking link not found' }, 404);
  if (!link.active) return jsonRes({ error: 'This booking link is no longer active' }, 410);

  // ── Step 2: Holiday Protection Layer (hard-block entire days) ─
  // Load settings + full holiday list in parallel for minimal latency
  const [settings, holidayIds] = await Promise.all([
    kvGet('holiday:settings'),
    kvGet('holiday:list'),
  ]);
  const cfg = settings || {};

  const blockedDates = new Set(); // 'YYYY-MM-DD' strings in the link's local timezone

  // Default ON — only skip if explicitly disabled
  if (cfg.autoBlockNational !== false && holidayIds?.length) {
    const allHolidays = await Promise.all(holidayIds.map(id => kvGet(`holiday:${id}`)));
    const active = allHolidays.filter(h => h?.isActive);

    // Pre-compute year range we'll generate slots for
    const now         = Date.now();
    const rangeEndMs  = now + (link.daysAhead || 14) * 24 * 60 * 60 * 1000;
    const yearStart   = new Date(now).getUTCFullYear();
    const yearEnd     = new Date(rangeEndMs).getUTCFullYear();

    for (const h of active) {
      if (h.isRecurring) {
        // Same month-day every year — block across the entire generation window
        const [, mm, dd] = h.date.split('-');
        for (let y = yearStart; y <= yearEnd; y++) {
          blockedDates.add(`${y}-${mm}-${dd}`);
        }
      } else {
        // One-off date — block only the specific day
        blockedDates.add(h.date);
      }
    }
  }

  // ── Step 3: Linked calendars busy-range fetch ────────────────
  // Uses the app-level Graph token — no OAuth per-user flow needed since the
  // Azure App has Calendars.ReadWrite.All (Application) permission.
  // Results are KV-cached 5 min so concurrent page loads share one API call.
  // On failure the function returns [] — slots stay open (fail-open).
  //
  // Availability is PER-RECRUITER: only the owning recruiter's own appointments,
  // their own Outlook calendar, and THEIR OWN linked calendars block this link's
  // slots — so two recruiters can independently offer the same wall-clock time.
  const linkOwnerId = link.ownerId || null;
  const ownerEmail  = await resolveOwnerCalendarEmail(linkOwnerId);
  const ownerUser   = (linkOwnerId && linkOwnerId !== 'admin') ? await kvGet(`user:${linkOwnerId}`) : null;
  const ownerLinkedCalendars = (ownerUser && ownerUser.linkedCalendars) || [];

  // ── Step 4: Build the owning recruiter's blocked time ranges ──
  // Scans the owner's confirmed candidate bookings (across their own links) +
  // their scheduled direct-invite (tw-session) appointments.

  // 4a. The owner's booking links → their confirmed candidate bookings
  const allLinkTokens = (await kvGet('booking:link:list')) || [];
  const allLinks      = await Promise.all(allLinkTokens.map(t => kvGet(`booking:link:${t}`)));
  const ownedTokens   = allLinkTokens.filter((t, i) => ((allLinks[i]?.ownerId || null) === linkOwnerId));
  const ownedBookingIdLists = await Promise.all(
    ownedTokens.map(t => kvGet(`booking:link:${t}:bookings`))
  );
  const ownedBookingIds = [...new Set(ownedBookingIdLists.flatMap(ids => ids || []))];
  const ownedBookings   = await Promise.all(ownedBookingIds.map(id => kvGet(`booking:booking:${id}`)));

  // 4b. The owner's direct-invite (tw-session) scheduled appointments
  const twIds      = (await kvGet('tw-session:list')) || [];
  const twSessions = (await Promise.all(twIds.map(id => kvGet(`tw-session:${id}`))))
    .filter(s => s && (s.ownerId || null) === linkOwnerId);

  // 4c. Merge owner's ZeusHire bookings + tw-sessions into base blocked ranges
  const blockedRanges = [
    ...ownedBookings
      .filter(b => b?.status === 'confirmed')
      .map(b => ({
        start: b.slotStart,
        end:   b.slotEnd ?? b.slotStart + (link.duration || 30) * 60 * 1000,
      })),
    ...twSessions
      .filter(s => s?.status === 'scheduled' && s.scheduledAt)
      .map(s => ({
        start: s.scheduledAt,
        end:   s.scheduledAt + (s.duration || 30) * 60 * 1000,
      })),
  ];

  // ── Step 4d: Merge the owner's Outlook calendar busy blocks ───
  // Checks the owning recruiter's own calendar (ownerEmail) plus the extra
  // calendars THAT recruiter linked. Runs AFTER base blockedRanges is built so a
  // single error doesn't prevent internal bookings from being blocked.
  const calendarsToCheck = [...new Set([ownerEmail, ...ownerLinkedCalendars].filter(Boolean))];
  if (calendarsToCheck.length) {
    const windowStartMs = Date.now();
    const windowEndMs   = windowStartMs + (link.daysAhead || 14) * 24 * 60 * 60 * 1000;
    try {
      const accessToken = await getAccessToken();
      // Concurrent: all calendars fetched in parallel
      const busyArrays = await Promise.all(
        calendarsToCheck.map(email =>
          fetchOutlookBusyRanges(email, windowStartMs, windowEndMs, accessToken)
        )
      );
      for (const ranges of busyArrays) blockedRanges.push(...ranges);
      console.log(`[cal-sync] merged ${busyArrays.flat().length} external busy ranges from ${calendarsToCheck.length} calendar(s) for owner ${ownerEmail}`);
    } catch (e) {
      // Non-fatal — if linked calendar lookup crashes, serve slots from
      // internal bookings only rather than blocking the whole page
      console.error('[cal-sync] linked calendar merge failed:', e.message);
    }
  }

  // Generate slots applying all filters
  const slots = generateBookingSlots(link, blockedRanges, blockedDates);

  return jsonRes({
    title:      link.title,
    clientName: link.clientName,
    position:   link.position,
    duration:   link.duration,
    slots,
    // Expose blocked count for transparency (useful for debugging)
    _meta: { holidaysBlocked: blockedDates.size, slotsAvailable: slots.length },
  });
}

async function createBookingHandler(token, request) {
  const link = await kvGet(`booking:link:${token}`);
  if (!link) return jsonRes({ error: 'Booking link not found' }, 404);
  if (!link.active) return jsonRes({ error: 'This booking link is no longer active' }, 410);

  const { candidateName, candidateEmail, slotStart, candidateTz, inviteToken } = await request.json();

  // ── Flow A: System Invite — validate token and pull candidate info ──
  let resolvedName  = candidateName?.trim();
  let resolvedEmail = candidateEmail?.trim();
  if (inviteToken) {
    const raw = await INTERVIEW_DATA.get(`booking:invite:${inviteToken}`);
    if (!raw) return jsonRes({ error: 'Invite link is invalid or has expired.' }, 410);
    const invite = JSON.parse(raw);
    if (invite.used) return jsonRes({ error: 'This invite link has already been used.' }, 410);
    if (invite.linkToken !== token) return jsonRes({ error: 'Invite token does not match this booking link.' }, 400);
    // Trust the server-stored name/email — ignore any client-submitted values
    resolvedName  = invite.candidateName;
    resolvedEmail = invite.candidateEmail;
  }

  // ── Flow B: Public link — require candidate to supply their own info ──
  if (!resolvedName || !resolvedEmail || !slotStart) {
    return jsonRes({ error: 'candidateName, candidateEmail and slotStart are required' }, 400);
  }

  const slotEnd = slotStart + (link.duration || 30) * 60 * 1000;

  // Phase 3: route this booking's calendar event / Teams meeting / recording to
  // the recruiter who owns the booking link.
  const organizerEmail = await resolveOwnerCalendarEmail(link.ownerId);

  // ── Race-condition guard: claim the slot atomically across ALL links ─
  // Key is global (not per-link) so two candidates booking *different* templates
  // at the same time cannot both win the same calendar slot.
  const lockKey      = `booking:slot:global:${slotStart}`;
  const existingLock = await kvGet(lockKey);
  if (existingLock) {
    return jsonRes({ error: 'Sorry, that slot was just taken. Please pick another time.' }, 409);
  }

  // Reserve the slot immediately (short TTL in case of crash mid-save)
  const bookingId = uid();
  await INTERVIEW_DATA.put(lockKey, bookingId, { expirationTtl: 3600 }); // 1-hour TTL

  // Mark invite token as used (prevents double-booking via same invite link)
  if (inviteToken) {
    const raw = await INTERVIEW_DATA.get(`booking:invite:${inviteToken}`);
    if (raw) {
      const invite = JSON.parse(raw);
      invite.used = true;
      await INTERVIEW_DATA.put(`booking:invite:${inviteToken}`, JSON.stringify(invite), { expirationTtl: 60 * 60 * 24 * 30 });
    }
  }

  // Create booking record
  const booking = {
    id:             bookingId,
    linkToken:      token,
    candidateName:  resolvedName,
    candidateEmail: resolvedEmail,
    slotStart,
    slotEnd,
    candidateTz:    candidateTz || 'UTC',
    status:         'confirmed',
    createdAt:      Date.now(),
    inviteToken:    inviteToken || null,
    ownerId:        link.ownerId || null,
    organizerEmail: organizerEmail,
    calendarEventId:  null,
    calendarEventUrl: null,
  };

  // Attempt to create Teams calendar event
  try {
    const session = {
      candidateName:  booking.candidateName,
      candidateEmail: booking.candidateEmail,
      position:       link.position || link.title,
      scheduledAt:    slotStart,
      duration:       link.duration || 30,
      notes:          `Booking Interview — ${link.interviewType || ''}`,
      id:             bookingId,
    };
    const meeting = await createTeamsMeeting(session, organizerEmail);
    booking.calendarEventId  = meeting.eventId;
    booking.calendarEventUrl = meeting.webLink;
    booking.meetingLink      = meeting.joinUrl;
    // Store the unique short ID so fetchBookingRecording can match
    // the recording file by the [CTI-{shortId}] tag embedded in
    // the Teams meeting subject — prevents cross-session mismatch.
    booking.meetingShortId   = meeting.shortId;
    booking.meetingSubjectTag = meeting.subjectTag;
  } catch (e) {
    console.error('[booking] calendar event failed:', e.message);
    // Non-fatal — booking still confirmed
  }

  await kvPut(`booking:booking:${bookingId}`, booking);

  // Update the slot-lock key to permanent (no TTL)
  await INTERVIEW_DATA.put(lockKey, bookingId);

  // Add to link's booking list
  const ids = (await kvGet(`booking:link:${token}:bookings`)) || [];
  ids.push(bookingId);
  await kvPut(`booking:link:${token}:bookings`, ids);

  // Send confirmation email to candidate
  try {
    await sendBookingConfirmationEmail(booking, link);
  } catch (e) {
    console.error('[booking] confirmation email failed:', e.message);
  }

  return jsonRes({
    ok:           true,
    bookingId,
    slotStart,
    slotEnd,
    meetingLink:  booking.meetingLink || null,
    calendarEventUrl: booking.calendarEventUrl || null,
  }, 201);
}

// ── Holiday & Closure handlers ────────────────────────────────
//
// KV Schema:
//   holiday:list               → string[]  (ordered list of IDs)
//   holiday:{id}               → Holiday   (see createHoliday for shape)
//   holiday:settings           → Settings  (autoBlockNational, country, syncedYears)
//
// Holiday shape:
//   { id, name, nameEn?, date (YYYY-MM-DD), isRecurring, isActive,
//     type ('national'|'custom'), countryCode, createdAt }

async function listHolidays(request) {
  await requireAdmin(request);
  const ids      = (await kvGet('holiday:list')) || [];
  const holidays = await Promise.all(ids.map(id => kvGet(`holiday:${id}`)));
  return jsonRes(holidays.filter(Boolean));
}

async function createHoliday(request) {
  await requireAdmin(request);
  const { name, date, isRecurring, type, countryCode } = await request.json();
  if (!name) return jsonRes({ error: 'name required' }, 400);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonRes({ error: 'date required (YYYY-MM-DD)' }, 400);

  const id      = uid();
  const holiday = {
    id, name, date,
    isRecurring: !!isRecurring,
    isActive:    true,
    type:        type || 'custom',
    countryCode: countryCode || 'ID',
    createdAt:   Date.now(),
  };
  await kvPut(`holiday:${id}`, holiday);
  const list = (await kvGet('holiday:list')) || [];
  list.unshift(id);
  await kvPut('holiday:list', list);
  return jsonRes(holiday, 201);
}

async function updateHoliday(id, request) {
  await requireAdmin(request);
  const existing = await kvGet(`holiday:${id}`);
  if (!existing) return jsonRes({ error: 'Not found' }, 404);
  const updates = await request.json();
  const updated = { ...existing, ...updates };
  await kvPut(`holiday:${id}`, updated);
  return jsonRes(updated);
}

async function deleteHoliday(id, request) {
  await requireAdmin(request);
  await INTERVIEW_DATA.delete(`holiday:${id}`);
  const list = (await kvGet('holiday:list')) || [];
  await kvPut('holiday:list', list.filter(i => i !== id));
  return jsonRes({ ok: true });
}

async function getHolidaySettings(request) {
  await requireAdmin(request);
  const settings = (await kvGet('holiday:settings')) || {
    autoBlockNational: true,
    country:           'ID',
    syncedYears:       [],
  };
  return jsonRes(settings);
}

async function updateHolidaySettings(request) {
  await requireAdmin(request);
  const existing = (await kvGet('holiday:settings')) || {};
  const updates  = await request.json();
  const updated  = { ...existing, ...updates };
  await kvPut('holiday:settings', updated);
  return jsonRes(updated);
}

async function syncNationalHolidays(request) {
  await requireAdmin(request);
  const { year, country } = await request.json();
  const countryCode = (country || 'ID').toUpperCase();
  const yr          = parseInt(year) || new Date().getFullYear();

  // Fetch from Nager.Date (free, no API key required)
  let fetched;
  try {
    const res = await fetch(
      `https://date.nager.at/api/v3/PublicHolidays/${yr}/${countryCode}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) {
      return jsonRes({ error: `Nager.Date returned HTTP ${res.status} for ${countryCode} ${yr}. Check the country code is valid.` }, 502);
    }
    fetched = await res.json();
  } catch (e) {
    return jsonRes({ error: 'Could not reach Nager.Date API: ' + e.message }, 502);
  }

  if (!Array.isArray(fetched) || !fetched.length) {
    return jsonRes({ error: `No holidays returned for ${countryCode} ${yr}. This country code may not be supported.` }, 404);
  }

  // Load existing holidays to avoid duplicates
  const existingIds      = (await kvGet('holiday:list')) || [];
  const existingHolidays = (await Promise.all(existingIds.map(id => kvGet(`holiday:${id}`)))).filter(Boolean);

  let addedCount = 0, skippedCount = 0;
  const newIds = [...existingIds];

  for (const h of fetched) {
    // Skip if already loaded (same date + national + same country)
    const exists = existingHolidays.find(
      e => e.date === h.date && e.type === 'national' && e.countryCode === countryCode
    );
    if (exists) { skippedCount++; continue; }

    const id = uid();
    const holiday = {
      id,
      name:        h.localName || h.name,
      nameEn:      h.name,
      date:        h.date,          // YYYY-MM-DD — exact date for this year
      isRecurring: h.fixed === true, // Nager: fixed=true means same date every year
      isActive:    true,
      type:        'national',
      countryCode,
      createdAt:   Date.now(),
    };
    await kvPut(`holiday:${id}`, holiday);
    newIds.unshift(id);
    addedCount++;
  }

  await kvPut('holiday:list', newIds);

  // Record which years have been synced
  const cfg         = (await kvGet('holiday:settings')) || {};
  const syncedYears = cfg.syncedYears || [];
  if (!syncedYears.includes(yr)) syncedYears.push(yr);
  await kvPut('holiday:settings', { autoBlockNational: true, ...cfg, country: countryCode, syncedYears });

  return jsonRes({ ok: true, added: addedCount, skipped: skippedCount, total: fetched.length });
}

async function sendBookingConfirmationEmail(booking, link) {
  const sender  = EMAIL_SENDER;
  const tz      = booking.candidateTz || 'UTC';
  const dtFmt   = { timeZone: tz };
  const dateStr = new Date(booking.slotStart).toLocaleDateString('en-US', { ...dtFmt, weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const timeStr = new Date(booking.slotStart).toLocaleTimeString('en-US', { ...dtFmt, hour:'2-digit', minute:'2-digit', timeZoneName:'short' });
  const endStr  = new Date(booking.slotEnd).toLocaleTimeString('en-US',   { ...dtFmt, hour:'2-digit', minute:'2-digit', timeZoneName:'short' });

  const html = emailWrap('#B01A18', 'Interview Confirmed', `
    <p style="margin:0 0 16px 0;font-size:15px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif">Dear <strong>${booking.candidateName}</strong>,</p>
    <p style="margin:0 0 20px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">Your interview has been confirmed. Here are the details:</p>
    ${emailInfoBox('#B01A18', link.title, link.clientName ? (link.clientName + (link.position ? ' &middot; ' + link.position : '')) : '')}
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:20px">
      <tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Date</td>
        <td valign="top" style="padding:8px 0;color:#1a1a1a;font-size:14px;font-weight:bold;font-family:Arial,Helvetica,sans-serif">${dateStr}</td>
      </tr>
      <tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Time</td>
        <td valign="top" style="padding:8px 0;color:#1a1a1a;font-size:14px;font-weight:bold;font-family:Arial,Helvetica,sans-serif">${timeStr} &ndash; ${endStr}</td>
      </tr>
      <tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Format</td>
        <td valign="top" style="padding:8px 0;color:#1a1a1a;font-size:14px;font-family:Arial,Helvetica,sans-serif">Microsoft Teams (video)</td>
      </tr>
      ${booking.meetingLink ? `<tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Meeting</td>
        <td valign="top" style="padding:8px 0"><a href="${booking.meetingLink}" style="color:#B01A18;font-weight:bold;font-family:Arial,Helvetica,sans-serif;font-size:14px;text-decoration:underline">Join Meeting Link</a></td>
      </tr>` : ''}
    </table>
    ${booking.meetingLink ? emailButton(booking.meetingLink, 'Join Interview') : ''}
  `);

  const accessToken = await getAccessToken();
  await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `Interview Confirmed: ${link.title} — ${booking.candidateName} — CTI ZeusHire`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ZeusHire', address: sender } },
        toRecipients: [{ emailAddress: { address: booking.candidateEmail } }],
      },
      saveToSentItems: true,
    }),
  });
}

async function saveProctoringLog(token, request) {
  // No admin check — called by candidate page
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  const { log } = await request.json();
  session.proctoringLog = Array.isArray(log) ? log : [];
  await kvPut(`session:${token}`, session);
  return jsonRes({ ok: true });
}

async function sendShareEmail(token, request) {
  await requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  const { emails, shareUrl, interviewTitle } = await request.json();
  if (!emails?.length || !shareUrl) return jsonRes({ error: 'emails and shareUrl required' }, 400);

  const interview = await kvGet(`interview:${session.interviewId}`);
  const title = interviewTitle || interview?.title || 'Interview Review';
  const graphToken = await getAccessToken();

  const toRecipients = emails
    .map(e => e.trim()).filter(e => e.includes('@'))
    .map(e => ({ emailAddress: { address: e } }));

  if (!toRecipients.length) return jsonRes({ error: 'No valid email addresses' }, 400);

  const bodyRows = `
    <p style="font-family:Arial,sans-serif;font-size:15px;color:#333;margin:0 0 16px">
      You have been invited to review a candidate's recorded interview.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px">
      <tr><td style="font-family:Arial,sans-serif;font-size:13px;color:#888;padding:2px 0;width:120px">Candidate</td><td style="font-family:Arial,sans-serif;font-size:13px;color:#333;font-weight:700">${session.candidateName}</td></tr>
      <tr><td style="font-family:Arial,sans-serif;font-size:13px;color:#888;padding:2px 0">Interview</td><td style="font-family:Arial,sans-serif;font-size:13px;color:#333">${title}</td></tr>
    </table>
    ${emailButton(shareUrl, 'View Candidate Review')}
    <p style="font-family:Arial,sans-serif;font-size:12px;color:#aaa;margin:20px 0 0;text-align:center">
      This is a read-only link — no login required.
    </p>`;

  await fetch(`https://graph.microsoft.com/v1.0/users/${EMAIL_SENDER}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${graphToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `Review request: ${session.candidateName} — ${title}`,
        body: { contentType: 'HTML', content: emailWrap('#B01A18', `Candidate Review`, bodyRows) },
        toRecipients,
      },
    }),
  });

  return jsonRes({ ok: true, sent: toRecipients.length });
}

async function sendBookingCancellationEmail(booking, link) {
  const sender  = EMAIL_SENDER;
  const tz      = booking.candidateTz || 'UTC';
  const dtFmt   = { timeZone: tz };
  const dateStr = new Date(booking.slotStart).toLocaleDateString('en-US', { ...dtFmt, weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const timeStr = new Date(booking.slotStart).toLocaleTimeString('en-US', { ...dtFmt, hour:'2-digit', minute:'2-digit', timeZoneName:'short' });
  const endStr  = new Date(booking.slotEnd).toLocaleTimeString('en-US',   { ...dtFmt, hour:'2-digit', minute:'2-digit', timeZoneName:'short' });

  const html = emailWrap('#374151', 'Interview Cancelled', `
    <p style="margin:0 0 16px 0;font-size:15px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif">Dear <strong>${booking.candidateName}</strong>,</p>
    <p style="margin:0 0 20px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">We regret to inform you that your interview has been <strong>cancelled</strong>. Here are the details of the cancelled session:</p>
    ${emailInfoBox('#9ca3af', link.title || 'Interview', link.clientName ? (link.clientName + (link.position ? ' &middot; ' + link.position : '')) : '')}
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:20px">
      <tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Date</td>
        <td valign="top" style="padding:8px 0;color:#9ca3af;font-size:14px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;text-decoration:line-through">${dateStr}</td>
      </tr>
      <tr>
        <td width="120" valign="top" style="padding:8px 0;color:#6b7280;font-size:13px;font-family:Arial,Helvetica,sans-serif">Time</td>
        <td valign="top" style="padding:8px 0;color:#9ca3af;font-size:14px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;text-decoration:line-through">${timeStr} &ndash; ${endStr}</td>
      </tr>
    </table>
    <p style="margin:0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">If you have questions or would like to reschedule, please contact us directly and we will arrange a new time for you.</p>
  `);

  const accessToken = await getAccessToken();
  await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `Interview Cancelled: ${link.title || 'Interview'} — ${booking.candidateName} — CTI ZeusHire`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ZeusHire', address: sender } },
        toRecipients: [{ emailAddress: { address: booking.candidateEmail } }],
      },
      saveToSentItems: true,
    }),
  });
}
