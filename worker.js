// ─────────────────────────────────────────────────────────────
//  CTI Interview API — Cloudflare Worker (OneDrive storage)
//  Format: Service Worker (addEventListener) — paste into Cloudflare dashboard
//
//  Required secrets (Worker Settings → Bindings → Secret):
//    ADMIN_KEY       — your chosen admin password
//    TENANT_ID       — Azure tenant ID
//    CLIENT_ID       — Azure app client ID
//    CLIENT_SECRET   — Azure app client secret
//    ONEDRIVE_USER   — OneDrive owner email for video file storage (e.g. putu.astra@cti-usa.com)
//    EMAIL_SENDER    — Recruiter calendar owner + email from-address (corporate-recruiter@cti-usa.com)
//
//  Required KV binding (Worker Settings → Bindings → KV Namespace):
//    INTERVIEW_DATA  → interview-data
//
//  No R2 bucket needed.
// ─────────────────────────────────────────────────────────────

const CTI_LOGO_URL = 'https://putuastra.github.io/interview-portal/logo.png';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};

addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

addEventListener('scheduled', event => {
  event.waitUntil(handleScheduled());
});

async function handle(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  try {
    return await route(request);
  } catch (e) {
    const status = e.message === 'Unauthorized' ? 401 : 500;
    if (status === 500) console.error('Worker unhandled error:', e.message, e.stack || '');
    return jsonRes({ error: e.message }, status);
  }
}

// ── Router ────────────────────────────────────────────────────

async function route(request) {
  const url = new URL(request.url);
  const m = request.method;
  const seg = url.pathname.replace(/^\/api\//, '').split('/');

  if (seg[0] === 'interviews' && seg.length === 1) {
    if (m === 'GET')  return listInterviews(request);
    if (m === 'POST') return createInterview(request);
  }
  if (seg[0] === 'interview' && seg.length === 2) {
    if (m === 'GET')    return getInterview(seg[1], request);
    if (m === 'PUT')    return updateInterview(seg[1], request);
    if (m === 'DELETE') return deleteInterview(seg[1], request);
  }
  if (seg[0] === 'interview' && seg[2] === 'sessions') {
    if (m === 'GET')  return listSessions(seg[1], request);
    if (m === 'POST') return createSession(seg[1], request);
  }
  if (seg[0] === 'session' && seg.length === 2 && m === 'GET') {
    return getSession(seg[1]);
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
  if (seg[0] === 'session' && seg[2] === 'upload' && m === 'POST') {
    return uploadVideo(seg[1], parseInt(seg[3]), request);
  }
  if (seg[0] === 'session' && seg[2] === 'complete' && m === 'POST') {
    return completeSession(seg[1]);
  }
  if (seg[0] === 'session' && seg[2] === 'video' && m === 'GET') {
    return getVideoUrl(seg[1], parseInt(seg[3]), request);
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
  // One-way: recruiter review outcome
  if (seg[0] === 'session' && seg[2] === 'review' && m === 'POST') return saveSessionReview(seg[1], request);
  if (seg[0] === 'session' && seg[2] === 'review' && m === 'GET')  return getSessionReview(seg[1], request);

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

  // ── Reminder trigger (manual / external cron) ────────────────
  if (seg[0] === 'reminders' && seg[1] === 'run' && m === 'POST') {
    requireAdmin(request);
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

function requireAdmin(request) {
  if (request.headers.get('X-Admin-Key') !== ADMIN_KEY) throw new Error('Unauthorized');
}

function uid() {
  return crypto.randomUUID();
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

function listTemplates(request) {
  requireAdmin(request);
  return jsonRes(QUESTION_TEMPLATES_DATA);
}

// ── Scheduled handler (cron + manual trigger) ─────────────────

async function handleScheduled() {
  const now    = Date.now();
  const h48    = 48 * 60 * 60 * 1000;
  const h24    = 24 * 60 * 60 * 1000;
  const window = 2  * 60 * 60 * 1000; // ±2h fire window

  let sent48 = 0, sent24 = 0, errors = 0;

  const interviewIds = (await kvGet('interview:list')) || [];

  for (const iid of interviewIds) {
    const tokens = (await kvGet(`interview:${iid}:sessions`)) || [];
    for (const token of tokens) {
      const session = await kvGet(`session:${token}`);
      if (!session?.expiresAt || session.status !== 'pending') continue;
      if (!session.candidateEmail) continue;

      const timeLeft = session.expiresAt - now;

      // 48h window: between 46h and 50h remaining
      if (!session.reminder48hSent && timeLeft >= (h48 - window) && timeLeft < (h48 + window)) {
        try {
          await sendReminderEmail(session, '48h');
          session.reminder48hSent = true;
          await kvPut(`session:${token}`, session);
          sent48++;
        } catch (e) {
          console.error('[reminders] 48h email failed for', token, e.message);
          errors++;
        }
      }

      // 24h window: between 22h and 26h remaining
      if (!session.reminder24hSent && timeLeft >= (h24 - window) && timeLeft < (h24 + window)) {
        try {
          await sendReminderEmail(session, '24h');
          session.reminder24hSent = true;
          await kvPut(`session:${token}`, session);
          sent24++;
        } catch (e) {
          console.error('[reminders] 24h email failed for', token, e.message);
          errors++;
        }
      }
    }
  }

  return { ok: true, sent48, sent24, errors };
}

async function sendReminderEmail(session, type) {
  const interview = await kvGet(`interview:${session.interviewId}`);
  const interviewTitle = interview?.title || 'Interview';
  const deadline = new Date(session.expiresAt).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const label = type === '48h' ? '48 Hours' : '24 Hours';

  // Build the interview link
  // We don't know the exact domain here — store it on session if known, else omit
  const link = session.interviewLink || null;

  const html = emailWrap('#B01A18', 'CTI ZeusHire — Interview Reminder', `
    <p style="margin:0 0 16px 0;font-size:15px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif">Dear <strong>${session.candidateName}</strong>,</p>
    <p style="margin:0 0 16px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">
      This is a friendly reminder that your video interview is due in <strong>${label}</strong>.
    </p>
    ${emailInfoBox('#B01A18', interviewTitle, `Deadline: ${deadline}`)}
    <p style="margin:0 0 16px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">
      Please complete your interview before the deadline to be considered for this opportunity.
    </p>
    ${link ? emailButton(link, 'Complete My Interview') : ''}
    ${link ? `
    <p style="margin:16px 0 4px 0;color:#6b7280;font-size:12px;font-family:Arial,Helvetica,sans-serif">Or copy this link into your browser:</p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td bgcolor="#f3f4f6" style="background-color:#f3f4f6;padding:10px;word-break:break-all">
        <p style="margin:0;color:#6b7280;font-size:12px;font-family:Arial,Helvetica,sans-serif;word-break:break-all">${link}</p>
      </td>
    </tr></table>
    ` : ''}
    <p style="margin:20px 0 0 0;color:#9ca3af;font-size:12px;font-family:Arial,Helvetica,sans-serif">
      If you have already completed your interview, please disregard this reminder.
    </p>
  `);

  const sender = EMAIL_SENDER;
  const accessToken = await getAccessToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `Reminder: Complete your ${interviewTitle} interview — ${label} remaining`,
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
  requireAdmin(request);
  const { title, description, questions } = await request.json();
  if (!title || !questions?.length) return jsonRes({ error: 'title and questions required' }, 400);

  const id = uid();
  const interview = { id, title, description: description || '', questions, createdAt: Date.now() };
  await kvPut(`interview:${id}`, interview);

  const list = (await kvGet('interview:list')) || [];
  list.unshift(id);
  await kvPut('interview:list', list);

  return jsonRes(interview, 201);
}

async function listInterviews(request) {
  requireAdmin(request);
  const ids = (await kvGet('interview:list')) || [];
  const items = await Promise.all(ids.map(async id => {
    const interview = await kvGet(`interview:${id}`);
    if (!interview) return null;
    const tokens = (await kvGet(`interview:${id}:sessions`)) || [];
    const sessions = await Promise.all(tokens.map(t => kvGet(`session:${t}`)));
    const valid = sessions.filter(Boolean);
    interview._counts = {
      total: valid.length,
      pending: valid.filter(s => s.status === 'pending').length,
      completed: valid.filter(s => s.status === 'completed').length,
    };
    return interview;
  }));
  return jsonRes(items.filter(Boolean));
}

async function getInterview(id, request) {
  requireAdmin(request);
  const interview = await kvGet(`interview:${id}`);
  if (!interview) return jsonRes({ error: 'Not found' }, 404);
  return jsonRes(interview);
}

async function updateInterview(id, request) {
  requireAdmin(request);
  const existing = await kvGet(`interview:${id}`);
  if (!existing) return jsonRes({ error: 'Not found' }, 404);

  const { title, description, questions } = await request.json();
  if (!title || !questions?.length) return jsonRes({ error: 'title and questions required' }, 400);

  const updated = { ...existing, title, description: description || '', questions };
  await kvPut(`interview:${id}`, updated);
  return jsonRes(updated);
}

async function deleteInterview(id, request) {
  requireAdmin(request);
  await INTERVIEW_DATA.delete(`interview:${id}`);
  const list = (await kvGet('interview:list')) || [];
  await kvPut('interview:list', list.filter(i => i !== id));
  return jsonRes({ ok: true });
}

// ── Session handlers ──────────────────────────────────────────

async function createSession(interviewId, request) {
  requireAdmin(request);
  const interview = await kvGet(`interview:${interviewId}`);
  if (!interview) return jsonRes({ error: 'Interview not found' }, 404);

  const { candidateName, candidateEmail, expiresAt } = await request.json();
  if (!candidateName) return jsonRes({ error: 'candidateName required' }, 400);

  const token = uid();
  const session = {
    token, interviewId, candidateName,
    candidateEmail: candidateEmail || '',
    status: 'pending',
    responses: [],
    createdAt: Date.now(),
    completedAt: null,
    expiresAt: expiresAt || null,
    reminder48hSent: false,
    reminder24hSent: false,
  };
  await kvPut(`session:${token}`, session);

  const sessions = (await kvGet(`interview:${interviewId}:sessions`)) || [];
  sessions.unshift(token);
  await kvPut(`interview:${interviewId}:sessions`, sessions);

  return jsonRes({ token, session }, 201);
}

async function listSessions(interviewId, request) {
  requireAdmin(request);
  const tokens = (await kvGet(`interview:${interviewId}:sessions`)) || [];
  const sessions = await Promise.all(tokens.map(t => kvGet(`session:${t}`)));
  return jsonRes(sessions.filter(Boolean));
}

async function getSession(token) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  const interview = await kvGet(`interview:${session.interviewId}`);
  return jsonRes({ session, interview });
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
  requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (!session.candidateEmail) return jsonRes({ error: 'No email address for this candidate' }, 400);

  const { link } = await request.json();
  const interview = await kvGet(`interview:${session.interviewId}`);
  const interviewTitle = interview?.title || 'Interview';

  // Persist the link so reminder emails can include it
  if (link && !session.interviewLink) {
    session.interviewLink = link;
    await kvPut(`session:${token}`, session);
  }

  const html = emailWrap('#B01A18', 'CTI ZeusHire', `
    <p style="margin:0 0 16px 0;font-size:15px;color:#1a1a1a;font-family:Arial,Helvetica,sans-serif">Dear <strong>${session.candidateName}</strong>,</p>
    <p style="margin:0 0 20px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">You have been invited to complete a one-way video interview for the following position:</p>
    ${emailInfoBox('#B01A18', interviewTitle)}
    <p style="margin:0 0 8px 0;color:#374151;font-size:14px;font-family:Arial,Helvetica,sans-serif;line-height:22px">Please click the button below to begin. You can complete the interview at your own pace.</p>
    ${emailButton(link, 'Start Interview')}
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
        subject: `Interview Invitation: ${interviewTitle} — CTI ZeusHire`,
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

async function uploadVideo(token, qIndex, request) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (session.status === 'completed') return jsonRes({ error: 'Session already completed' }, 400);

  const interview = await kvGet(`interview:${session.interviewId}`);
  const interviewTitle = interview?.title || 'Interview';
  const safeName = session.candidateName.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  const shortToken = token.slice(0, 8);

  // Folder: CTI Interviews/{Interview Title}/{Candidate Name} ({shortToken})
  const filePath = `CTI Interviews/${interviewTitle}/${safeName} (${shortToken})/Q${qIndex + 1}.webm`;

  const blob = await request.arrayBuffer();

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

async function deleteSession(token, request) {
  requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (session.status === 'completed') return jsonRes({ error: 'Cannot revoke a completed session' }, 400);

  await INTERVIEW_DATA.delete(`session:${token}`);
  await INTERVIEW_DATA.delete(`session:${token}:analysis`);
  await INTERVIEW_DATA.delete(`session:${token}:review`);
  const sessions = (await kvGet(`interview:${session.interviewId}:sessions`)) || [];
  await kvPut(`interview:${session.interviewId}:sessions`, sessions.filter(t => t !== token));
  return jsonRes({ ok: true });
}

async function patchSession(token, request) {
  requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);

  const updates = await request.json();

  // Allow updating: expiresAt (deadline), and reset reminder flags when deadline changes
  if ('expiresAt' in updates) {
    session.expiresAt = updates.expiresAt || null;
    // Reset reminder flags so new deadline triggers fresh reminders
    session.reminder48hSent = false;
    session.reminder24hSent = false;
  }

  await kvPut(`session:${token}`, session);
  return jsonRes(session);
}

async function completeSession(token) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  session.status = 'completed';
  session.completedAt = Date.now();
  await kvPut(`session:${token}`, session);
  return jsonRes({ ok: true });
}

async function getVideoUrl(token, qIndex, request) {
  requireAdmin(request);
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
    });
  } catch (e) {
    return jsonRes({ error: 'Could not fetch video URL: ' + e.message }, 500);
  }
}

// ── Two-way session handlers ──────────────────────────────────

async function createTWSession(request) {
  requireAdmin(request);
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
  };

  if (autoMeeting && scheduledAt) {
    try {
      const meeting = await createTeamsMeeting(session);
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
  requireAdmin(request);
  const ids = (await kvGet('tw-session:list')) || [];
  const items = await Promise.all(ids.map(id => kvGet(`tw-session:${id}`)));
  return jsonRes(items.filter(Boolean));
}

// ── Unified Two-Way list (Direct Invite + Self-Booked merged) ─

async function listUnifiedTWSessions(request) {
  requireAdmin(request);

  // 1. Direct Invite sessions (tw-session:*)
  const twIds   = (await kvGet('tw-session:list')) || [];
  const twItems = (await Promise.all(twIds.map(id => kvGet(`tw-session:${id}`)))).filter(Boolean);
  const directItems = twItems.map(s => ({
    id:                   s.id,
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
      const ids      = (await kvGet(`booking:link:${t}:bookings`)) || [];
      const bookings = (await Promise.all(ids.map(id => kvGet(`booking:booking:${id}`)))).filter(b => b && b.status !== 'cancelled');
      return bookings.map(b => ({
        id:                   b.id,
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
  requireAdmin(request);
  const booking = await kvGet(`booking:booking:${bookingId}`);
  if (!booking) return jsonRes({ error: 'Not found' }, 404);
  const { status } = await request.json();
  const allowed = ['completed', 'cancelled', 'confirmed'];
  if (!allowed.includes(status)) return jsonRes({ error: 'Invalid status' }, 400);
  booking.status = status;
  await kvPut(`booking:booking:${bookingId}`, booking);
  return jsonRes(booking);
}

async function updateTWSession(id, request) {
  requireAdmin(request);
  const existing = await kvGet(`tw-session:${id}`);
  if (!existing) return jsonRes({ error: 'Not found' }, 404);
  const updates = await request.json();
  const updated = { ...existing, ...updates };
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
  requireAdmin(request);
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
  requireAdmin(request);
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

// ── Shared OneDrive recording file collector ──────────────────────
// Lists /Recordings folder (Teams default) then falls back to drive search.
async function collectRecordingFiles(driveBase, accessToken) {
  const videoExt = /\.(mp4|mkv|webm)$/i;
  let files = [];

  const folderRes = await fetch(
    `${driveBase}/root:/Recordings:/children` +
    `?$orderby=createdDateTime+desc&$top=50&$select=id,name,createdDateTime,size,webUrl`,
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
  requireAdmin(request);
  const session = await kvGet(`tw-session:${id}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);

  const organizer   = EMAIL_SENDER || ONEDRIVE_USER;
  const accessToken = await getAccessToken();
  const { driveBase, error } = await resolveOrganizerDriveBase(organizer, accessToken);
  if (error) return jsonRes(error, 500);

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

  const { match, reason } = findRecordingCandidate(candidates, session);

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
  requireAdmin(request);
  const booking = await kvGet(`booking:booking:${bookingId}`);
  if (!booking) return jsonRes({ error: 'Booking not found' }, 404);

  const organizer   = EMAIL_SENDER || ONEDRIVE_USER;
  const accessToken = await getAccessToken();
  const { driveBase, error } = await resolveOrganizerDriveBase(organizer, accessToken);
  if (error) return jsonRes(error, 500);

  const duration   = booking.slotEnd
    ? Math.round((booking.slotEnd - booking.slotStart) / 60000)
    : 30;
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

  // Build session-like object for the shared matcher
  const sessionLike = {
    meetingShortId: booking.meetingShortId || null,
    candidateName:  booking.candidateName,
  };
  const { match, reason } = findRecordingCandidate(candidates, sessionLike);

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
  requireAdmin(request);
  const booking = await kvGet(`booking:booking:${bookingId}`);
  if (!booking) return jsonRes({ error: 'Booking not found' }, 404);
  if (!booking.recordingDriveItemId) {
    return jsonRes({ error: 'No recording linked to this booking' }, 404);
  }
  try {
    const organizer   = EMAIL_SENDER || ONEDRIVE_USER;
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
  requireAdmin(request);
  const session = await kvGet(`tw-session:${id}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (!session.recordingDriveItemId) return jsonRes({ error: 'No recording linked to this session' }, 404);

  try {
    const organizer   = EMAIL_SENDER || ONEDRIVE_USER;
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

async function createTeamsMeeting(session) {
  const accessToken = await getAccessToken();
  // Use EMAIL_SENDER (corporate-recruiter@cti-usa.com) as the Teams meeting
  // organizer so calendar events appear in the recruiter's calendar.
  // Fall back to ONEDRIVE_USER only if EMAIL_SENDER is not set.
  const organizer   = EMAIL_SENDER || ONEDRIVE_USER;

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
// Required Worker secrets: OPENAI_API_KEY, ANTHROPIC_API_KEY

async function analyzeSession(token, request) {
  requireAdmin(request);

  if (typeof OPENAI_API_KEY === 'undefined' || !OPENAI_API_KEY) {
    return jsonRes({ error: 'OPENAI_API_KEY is not configured in Worker secrets.' }, 500);
  }

  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);

  const responses = (session.responses || []).filter(r => r.driveItemId);
  if (!responses.length) return jsonRes({ error: 'No recordings found for this session.' }, 400);

  const interview  = await kvGet(`interview:${session.interviewId}`);
  const questions  = interview?.questions || [];
  const accessToken = await getAccessToken();

  // ── Step 1: resolve @microsoft.graph.downloadUrl for every response ──
  const downloadItems = await Promise.all(responses.map(async r => {
    try {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${r.driveItemId}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      const item = await res.json();
      return { qIndex: r.questionIndex, url: item['@microsoft.graph.downloadUrl'] || null };
    } catch {
      return { qIndex: r.questionIndex, url: null };
    }
  }));

  // ── Step 2: download each video + transcribe via OpenAI Whisper (parallel) ──
  const transcripts = await Promise.all(downloadItems.map(async ({ qIndex, url }) => {
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

      // Whisper hard limit is 25 MB
      if (blob.size > 24 * 1024 * 1024) {
        return { qIndex, qText, transcript: '[Recording too large to transcribe (>24 MB)]', error: true };
      }

      const form = new FormData();
      form.append('file', blob, `q${qIndex + 1}.webm`);
      form.append('model', 'whisper-1');
      form.append('language', 'en');

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: form,
      });
      if (!whisperRes.ok) {
        const e = await whisperRes.json().catch(() => ({}));
        console.error(`[analyze] Whisper Q${qIndex + 1}:`, JSON.stringify(e));
        return { qIndex, qText, transcript: '[Transcription failed]', error: true };
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

Criteria: grammar accuracy, vocabulary range, sentence complexity, fluency, professional tone.

Respond with ONLY a valid JSON object — no commentary before or after:
{
  "questions": [
    {
      "questionIndex": 0,
      "stars": 4,
      "feedback": "One concise sentence summarising this answer's English quality."
    }
  ],
  "overall": {
    "stars": 4,
    "level": "Good",
    "summary": "2–3 sentence professional summary of the candidate's overall English proficiency."
  }
}`;

  // Use OpenAI GPT-4o-mini for analysis (same key already used for Whisper)
  const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model:      'gpt-4o-mini',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  if (!gptRes.ok) {
    const e = await gptRes.json().catch(() => ({}));
    console.error('[analyze] GPT error:', JSON.stringify(e));
    return jsonRes({ error: 'Analysis failed: ' + (e.error?.message || gptRes.status) }, 500);
  }

  const gptData = await gptRes.json();
  const rawText = gptData.choices?.[0]?.message?.content || '{}';

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
  return jsonRes(analysis);
}

async function getAnalysis(token, request) {
  requireAdmin(request);
  const analysis = await kvGet(`session:${token}:analysis`);
  if (!analysis) return jsonRes({ notFound: true });
  return jsonRes(analysis);
}

// ── Profile Photo & Resume Upload ─────────────────────────────

async function uploadProfilePhoto(token, request) {
  const session = await kvGet(`session:${token}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);

  try {
    const formData    = await request.formData();
    const file        = formData.get('file');
    if (!file) return jsonRes({ error: 'No file in request' }, 400);

    const contentType = file.type || 'image/jpeg';
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

  try {
    const formData    = await request.formData();
    const file        = formData.get('file');
    if (!file) return jsonRes({ error: 'No file in request' }, 400);

    const fileName    = file.name || 'resume.pdf';
    const ext         = fileName.split('.').pop().toLowerCase() || 'pdf';
    const mimeMap     = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
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
  requireAdmin(request);
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

async function getResumeUrl(token, request) {
  requireAdmin(request);
  const session = await kvGet(`session:${token}`);
  if (!session?.resumeItemId) return jsonRes({ notFound: true });
  try {
    const accessToken = await getAccessToken();
    const res  = await fetch(
      `https://graph.microsoft.com/v1.0/users/${ONEDRIVE_USER}/drive/items/${session.resumeItemId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    const item = await res.json();
    return jsonRes({
      downloadUrl: item['@microsoft.graph.downloadUrl'] || null,
      fileName:    session.resumeFileName || 'resume.pdf',
      ext:         session.resumeExt      || 'pdf',
    });
  } catch (e) {
    return jsonRes({ error: e.message }, 500);
  }
}

async function saveSessionReview(token, request) {
  requireAdmin(request);
  const { notes, decision, stars } = await request.json();
  await kvPut(`session:${token}:review`, { notes, decision, stars: stars || 0, reviewedAt: Date.now() });
  // Mirror decision + stars onto the session for fast list rendering
  const session = await kvGet(`session:${token}`);
  if (session) {
    session.reviewDecision = decision;
    session.reviewStars    = stars || 0;
    await kvPut(`session:${token}`, session);
  }
  return jsonRes({ ok: true });
}

async function getSessionReview(token, request) {
  requireAdmin(request);
  const review = await kvGet(`session:${token}:review`);
  if (!review) return jsonRes({ notFound: true });
  return jsonRes(review);
}

// ── Interview Script handlers ─────────────────────────────────

async function listScriptClients(request) {
  requireAdmin(request);
  const ids = (await kvGet('script:client:list')) || [];
  const clients = await Promise.all(ids.map(id => kvGet(`script:client:${id}`)));
  return jsonRes(clients.filter(Boolean));
}

async function createScriptClient(request) {
  requireAdmin(request);
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
  requireAdmin(request);
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
  requireAdmin(request);
  const ids = (await kvGet(`script:client:${clientId}:positions`)) || [];
  const positions = await Promise.all(ids.map(id => kvGet(`script:position:${id}`)));
  return jsonRes(positions.filter(Boolean));
}

async function createScriptPosition(clientId, request) {
  requireAdmin(request);
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
  requireAdmin(request);
  const pos = await kvGet(`script:position:${id}`);
  if (!pos) return jsonRes({ error: 'Not found' }, 404);
  const list = (await kvGet(`script:client:${pos.clientId}:positions`)) || [];
  await kvPut(`script:client:${pos.clientId}:positions`, list.filter(p => p !== id));
  await INTERVIEW_DATA.delete(`script:position:${id}`);
  return jsonRes({ ok: true });
}

async function uploadScriptDoc(id, request) {
  requireAdmin(request);
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
  requireAdmin(request);
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
  requireAdmin(request);
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
  requireAdmin(request);
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
  requireAdmin(request);
  const tokens = (await kvGet('booking:link:list')) || [];
  const links = await Promise.all(tokens.map(t => kvGet(`booking:link:${t}`)));
  return jsonRes(links.filter(Boolean));
}

async function createBookingLink(request) {
  requireAdmin(request);
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
  };
  await kvPut(`booking:link:${token}`, link);
  const list = (await kvGet('booking:link:list')) || [];
  list.unshift(token);
  await kvPut('booking:link:list', list);
  return jsonRes(link, 201);
}

async function updateBookingLink(token, request) {
  requireAdmin(request);
  const existing = await kvGet(`booking:link:${token}`);
  if (!existing) return jsonRes({ error: 'Not found' }, 404);
  const updates = await request.json();
  const updated = { ...existing, ...updates };
  await kvPut(`booking:link:${token}`, updated);
  return jsonRes(updated);
}

async function deleteBookingLink(token, request) {
  requireAdmin(request);
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
  requireAdmin(request);
  const link = await kvGet(`booking:link:${token}`);
  if (!link) return jsonRes({ error: 'Booking link not found' }, 404);
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
  requireAdmin(request);
  const link = await kvGet(`booking:link:${token}`);
  if (!link) return jsonRes({ error: 'Not found' }, 404);
  const ids = (await kvGet(`booking:link:${token}:bookings`)) || [];
  const bookings = await Promise.all(ids.map(id => kvGet(`booking:booking:${id}`)));
  return jsonRes(bookings.filter(b => b && b.status !== 'cancelled'));
}

async function cancelBookingHandler(bookingId, request) {
  requireAdmin(request);
  const booking = await kvGet(`booking:booking:${bookingId}`);
  if (!booking) return jsonRes({ error: 'Not found' }, 404);

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
      const organizer   = EMAIL_SENDER || ONEDRIVE_USER;
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

// ── Recruiter Settings ────────────────────────────────────────

async function getRecruiterSettings(request) {
  requireAdmin(request);
  return jsonRes(await kvGet('recruiter:settings') || { linkedCalendars: [] });
}

async function updateRecruiterSettings(request) {
  requireAdmin(request);
  const updates  = await request.json();
  const existing = (await kvGet('recruiter:settings')) || {};
  const updated  = { ...existing, ...updates };
  await kvPut('recruiter:settings', updated);
  return jsonRes(updated);
}

async function testLinkedCalendar(request) {
  requireAdmin(request);
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
  // Loads recruiter:settings from KV to get the list of additional email
  // addresses to check (e.g. herry.wahyudi@cti-usa.com).
  // Uses the same app-level Graph token — no OAuth per-user flow needed since
  // the Azure App has Calendars.ReadWrite.All (Application) permission.
  // Results are KV-cached 5 min so concurrent page loads share one API call.
  // On failure the function returns [] — slots stay open (fail-open).
  const recruiterSettings = await kvGet('recruiter:settings');
  const linkedCalendars   = recruiterSettings?.linkedCalendars || [];

  // ── Step 4: Build global blocked time ranges ─────────────────
  // Scans ALL confirmed bookings across ALL links + all scheduled
  // direct-invite (tw-session) appointments so the recruiter's ZeusHire
  // calendar is treated as a single unified availability source.

  // 4a. All booking links → all confirmed candidate bookings
  const allLinkTokens    = (await kvGet('booking:link:list')) || [];
  const allBookingIdLists = await Promise.all(
    allLinkTokens.map(t => kvGet(`booking:link:${t}:bookings`))
  );
  const allBookingIds  = [...new Set(allBookingIdLists.flatMap(ids => ids || []))];
  const allBookings    = await Promise.all(allBookingIds.map(id => kvGet(`booking:booking:${id}`)));

  // 4b. Direct-invite (tw-session) scheduled appointments
  const twIds      = (await kvGet('tw-session:list')) || [];
  const twSessions = await Promise.all(twIds.map(id => kvGet(`tw-session:${id}`)));

  // 4c. Merge ZeusHire bookings + tw-sessions into base blocked ranges
  const blockedRanges = [
    ...allBookings
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

  // ── Step 4d: Merge linked Outlook calendar busy blocks ────────
  // Runs AFTER base blockedRanges is built so a single error doesn't
  // prevent internal bookings from being blocked correctly.
  if (linkedCalendars.length) {
    const windowStartMs = Date.now();
    const windowEndMs   = windowStartMs + (link.daysAhead || 14) * 24 * 60 * 60 * 1000;
    try {
      const accessToken = await getAccessToken();
      // Concurrent: all linked calendars fetched in parallel
      const busyArrays = await Promise.all(
        linkedCalendars.map(email =>
          fetchOutlookBusyRanges(email, windowStartMs, windowEndMs, accessToken)
        )
      );
      for (const ranges of busyArrays) blockedRanges.push(...ranges);
      console.log(`[cal-sync] merged ${busyArrays.flat().length} external busy ranges from ${linkedCalendars.length} calendar(s)`);
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
    const meeting = await createTeamsMeeting(session);
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
  requireAdmin(request);
  const ids      = (await kvGet('holiday:list')) || [];
  const holidays = await Promise.all(ids.map(id => kvGet(`holiday:${id}`)));
  return jsonRes(holidays.filter(Boolean));
}

async function createHoliday(request) {
  requireAdmin(request);
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
  requireAdmin(request);
  const existing = await kvGet(`holiday:${id}`);
  if (!existing) return jsonRes({ error: 'Not found' }, 404);
  const updates = await request.json();
  const updated = { ...existing, ...updates };
  await kvPut(`holiday:${id}`, updated);
  return jsonRes(updated);
}

async function deleteHoliday(id, request) {
  requireAdmin(request);
  await INTERVIEW_DATA.delete(`holiday:${id}`);
  const list = (await kvGet('holiday:list')) || [];
  await kvPut('holiday:list', list.filter(i => i !== id));
  return jsonRes({ ok: true });
}

async function getHolidaySettings(request) {
  requireAdmin(request);
  const settings = (await kvGet('holiday:settings')) || {
    autoBlockNational: true,
    country:           'ID',
    syncedYears:       [],
  };
  return jsonRes(settings);
}

async function updateHolidaySettings(request) {
  requireAdmin(request);
  const existing = (await kvGet('holiday:settings')) || {};
  const updates  = await request.json();
  const updated  = { ...existing, ...updates };
  await kvPut('holiday:settings', updated);
  return jsonRes(updated);
}

async function syncNationalHolidays(request) {
  requireAdmin(request);
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
