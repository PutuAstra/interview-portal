// ─────────────────────────────────────────────────────────────
//  CTI Interview API — Cloudflare Worker (OneDrive storage)
//  Format: Service Worker (addEventListener) — paste into Cloudflare dashboard
//
//  Required secrets (Worker Settings → Bindings → Secret):
//    ADMIN_KEY       — your chosen admin password
//    TENANT_ID       — Azure tenant ID
//    CLIENT_ID       — Azure app client ID
//    CLIENT_SECRET   — Azure app client secret
//    ONEDRIVE_USER   — OneDrive owner email (e.g. putua@ctigroup.com)
//
//  Required KV binding (Worker Settings → Bindings → KV Namespace):
//    INTERVIEW_DATA  → interview-data
//
//  No R2 bucket needed.
// ─────────────────────────────────────────────────────────────

const CTI_LOGO_URL = 'https://putuastra.github.io/interview-portal/logo.png';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};

addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
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
  // Public routes (no admin key required)
  if (seg[0] === 'booking' && seg[1] === 'slots' && seg.length === 3 && m === 'GET') {
    return getBookingSlots(seg[2]);
  }
  if (seg[0] === 'booking' && seg[1] === 'book' && seg.length === 3 && m === 'POST') {
    return createBookingHandler(seg[2], request);
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

  const { candidateName, candidateEmail } = await request.json();
  if (!candidateName) return jsonRes({ error: 'candidateName required' }, 400);

  const token = uid();
  const session = {
    token, interviewId, candidateName,
    candidateEmail: candidateEmail || '',
    status: 'pending',
    responses: [],
    createdAt: Date.now(),
    completedAt: null,
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
    <!-- HEADER -->
    <tr>
      <td bgcolor="${headerBg}" style="background-color:${headerBg};padding:0">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td bgcolor="#ffffff" width="88" align="center" valign="middle"
                style="background-color:#ffffff;width:88px;padding:0;font-size:0;line-height:0">
              <table cellpadding="0" cellspacing="0" border="0" align="center">
                <tr><td style="padding:8px;font-size:0;line-height:0">
                  <img src="${CTI_LOGO_URL}" alt="CTI Group" width="60" border="0"
                       style="display:block;width:60px;max-width:60px;height:auto;border:0;outline:0" />
                </td></tr>
              </table>
            </td>
            <td valign="middle" style="padding:18px 24px">
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
          CTI Group Worldwide Services, Inc. &nbsp;&middot;&nbsp; ClaudeHire Portal<br />
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

  const html = emailWrap('#B01A18', 'CTI ClaudeHire', `
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

  const sender = EMAIL_SENDER || ONEDRIVE_USER;
  const accessToken = await getAccessToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `Interview Invitation: ${interviewTitle} — CTI ClaudeHire`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ClaudeHire', address: sender } },
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

async function updateTWSession(id, request) {
  requireAdmin(request);
  const existing = await kvGet(`tw-session:${id}`);
  if (!existing) return jsonRes({ error: 'Not found' }, 404);
  const updates = await request.json();
  const updated = { ...existing, ...updates };
  await kvPut(`tw-session:${id}`, updated);
  return jsonRes(updated);
}

async function deleteTWSessionHandler(id, request) {
  requireAdmin(request);
  await INTERVIEW_DATA.delete(`tw-session:${id}`);
  const list = (await kvGet('tw-session:list')) || [];
  await kvPut('tw-session:list', list.filter(i => i !== id));
  return jsonRes({ ok: true });
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

  const html = emailWrap('#B01A18', 'CTI ClaudeHire', `
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

  const sender = EMAIL_SENDER || ONEDRIVE_USER;
  const accessToken = await getAccessToken();
  const emailRes = await fetch(`https://graph.microsoft.com/v1.0/users/${sender}/sendMail`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `Interview Scheduled: ${session.position} — CTI ClaudeHire`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ClaudeHire', address: sender } },
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

async function fetchTWRecording(id, request) {
  requireAdmin(request);
  const session = await kvGet(`tw-session:${id}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);

  // Use ONEDRIVE_USER (not EMAIL_SENDER) — Teams meetings are created in
  // ONEDRIVE_USER's calendar so recordings land in their accessible drive.
  const organizer   = ONEDRIVE_USER;
  const accessToken = await getAccessToken();

  // ── Step 1: resolve drive base (with 423 fallback) ─────────────
  const { driveBase, error } = await resolveOrganizerDriveBase(organizer, accessToken);
  if (error) return jsonRes(error, 500);

  // ── Step 2: search for recordings ──────────────────────────────
  // Teams recordings are named after the meeting subject (e.g. "Interview -
  // Cunard Line.mp4"), NOT "recording.mp4", so we search several terms and
  // also list the Recordings folder directly.
  let files = [];
  const videoExt = /\.(mp4|mkv|webm)$/i;

  // 2a. List Recordings folder (most reliable — Teams saves here by default)
  const recFolderRes = await fetch(
    `${driveBase}/root:/Recordings:/children` +
    `?$orderby=createdDateTime+desc&$top=50&$select=id,name,createdDateTime,size,webUrl`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  if (recFolderRes.ok) {
    const data = await recFolderRes.json();
    files.push(...(data.value || []).filter(f => videoExt.test(f.name)));
  }

  // 2b. Drive search for ".mp4" — catches files outside the Recordings folder
  if (!files.length) {
    const s = await fetch(
      `${driveBase}/search(q='.mp4')` +
      `?$top=50&$select=id,name,createdDateTime,size,webUrl`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    if (s.ok) {
      const data = await s.json();
      files.push(...(data.value || []).filter(f => videoExt.test(f.name)));
    }
  }

  const meetingStart = session.scheduledAt || 0;
  // Only look for recordings created AFTER the meeting started (not before).
  // This prevents picking up recordings from earlier sessions.
  const windowStart  = meetingStart;

  // Match video files created at or after the meeting time
  let candidates = files.filter(f =>
    new Date(f.createdDateTime).getTime() >= windowStart
  );
  // If time filter yields nothing (meeting time not set / clock skew), use all
  if (!candidates.length) candidates = files;

  if (!candidates.length) {
    return jsonRes({ notFound: true, message: 'No recording found yet. Recording may still be processing — try again in a few minutes.' });
  }

  // ── Match by unique session ID tag first (most reliable) ──────
  // New meetings have [CTI-xxxxxxxx] embedded in the subject → filename.
  const idTag     = session.meetingShortId ? `cti-${session.meetingShortId}` : null;
  const idMatch   = idTag
    ? candidates.find(f => f.name.toLowerCase().includes(idTag))
    : null;

  // ── Fallback: meaningful words from the candidate's name ────────
  // (skip short words/honorifics like "I", "de", "Mr")
  const nameWords = session.candidateName
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2);

  const nameMatch = candidates.find(f => {
    const fn = f.name.toLowerCase();
    return nameWords.some(w => fn.includes(w));
  });

  const best = idMatch || nameMatch;

  if (!best) {
    // Neither tag nor name matched — don't guess, report what was found
    const fileList = candidates.map(f => f.name).join(', ');
    return jsonRes({
      notFound: true,
      message: `Found ${candidates.length} recording(s) after meeting time but none matched "${session.candidateName}". Files found: ${fileList}`,
    });
  }

  session.recordingDriveItemId = best.id;
  session.recordingFileName    = best.name;
  session.recordingWebUrl      = best.webUrl;
  await kvPut(`tw-session:${id}`, session);

  return jsonRes({ ok: true, fileName: best.name, webUrl: best.webUrl });
}

async function getTWRecordingUrl(id, request) {
  requireAdmin(request);
  const session = await kvGet(`tw-session:${id}`);
  if (!session) return jsonRes({ error: 'Session not found' }, 404);
  if (!session.recordingDriveItemId) return jsonRes({ error: 'No recording linked to this session' }, 404);

  try {
    const organizer   = ONEDRIVE_USER;
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
  // Always use ONEDRIVE_USER as the Teams meeting organizer so that
  // recordings land in ONEDRIVE_USER's drive (accessible via app-only auth).
  // EMAIL_SENDER is only used as the FROM address in notification emails.
  const organizer   = ONEDRIVE_USER;

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
        <p>Interview scheduled via <strong>CTI ClaudeHire</strong>.</p>
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
  const { title, clientName, position, duration, tzOffset, daysAhead, slotRules } = await request.json();
  if (!title) return jsonRes({ error: 'title required' }, 400);
  if (!slotRules?.length) return jsonRes({ error: 'slotRules required' }, 400);

  const token = uid();
  const link = {
    token, title,
    clientName: clientName || '',
    position:   position || '',
    duration:   duration || 30,
    tzOffset:      tzOffset ?? 0,
    daysAhead:     daysAhead || 14,
    slotRules,
    active:        true,
    createdAt:     Date.now(),
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
  if (invite.used) return jsonRes({ error: 'This invite link has already been used' }, 410);
  // Return candidate info — frontend uses this to pre-fill & lock the form
  return jsonRes({
    candidateName:  invite.candidateName,
    candidateEmail: invite.candidateEmail,
    linkToken:      invite.linkToken,
  });
}

async function sendBookingInviteEmail(candidateName, candidateEmail, link, bookUrl) {
  const sender = EMAIL_SENDER || ONEDRIVE_USER;
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
        subject: `Interview Invitation: ${link.title} — ${candidateName} — CTI ClaudeHire`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ClaudeHire', address: sender } },
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

  // Free up the slot-lock key so the slot becomes available again
  await INTERVIEW_DATA.delete(`booking:slot:${booking.linkToken}:${booking.slotStart}`);

  // ── Delete Teams calendar event ───────────────────────────────
  if (booking.calendarEventId) {
    try {
      const accessToken = await getAccessToken();
      const organizer   = ONEDRIVE_USER;
      await fetch(
        `https://graph.microsoft.com/v1.0/users/${organizer}/calendar/events/${booking.calendarEventId}`,
        { method: 'DELETE', headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
    } catch (e) {
      console.error('[booking] calendar delete failed:', e.message);
    }
  }

  // ── Send cancellation email to candidate ──────────────────────
  try {
    const link = await kvGet(`booking:link:${booking.linkToken}`);
    await sendBookingCancellationEmail(booking, link || {});
  } catch (e) {
    console.error('[booking] cancellation email failed:', e.message);
  }

  return jsonRes({ ok: true });
}

// ── Slot generation (public) ──────────────────────────────────

// blockedDates: Set of 'YYYY-MM-DD' strings (Step 2 — holiday protection)
// bookedSlotStarts: Set of UTC timestamps (Step 4 — existing bookings)
function generateBookingSlots(link, bookedSlotStarts, blockedDates = new Set()) {
  const { slotRules = [], duration = 30, daysAhead = 14, tzOffset = 0 } = link;
  const durationMs  = duration * 60 * 1000;
  const tzOffsetMs  = tzOffset * 60 * 1000;
  const now         = Date.now();
  const bufferMs    = 2 * 60 * 60 * 1000; // 2-hour lead time
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
    if (blockedDates.has(localDateStr)) continue; // skip ALL slots this day

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
        if (t > now + bufferMs) {
          // Step 4: include booked slots with a flag so the UI can grey them out
          slots.push({ start: t, end: t + durationMs, booked: bookedSlotStarts.has(t) });
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

  // ── Step 3 (Outlook calendar sync — future enhancement) ──────
  // When implemented: query recruiter's Microsoft Graph calendar for
  // Busy/OOF events and add their dates to blockedDates / blockedSlots.

  // ── Step 4: Filter out slots already taken by other candidates ─
  const bookingIds     = (await kvGet(`booking:link:${token}:bookings`)) || [];
  const existingBooks  = await Promise.all(bookingIds.map(id => kvGet(`booking:booking:${id}`)));
  const bookedSlots    = new Set(
    existingBooks.filter(b => b?.status === 'confirmed').map(b => b.slotStart)
  );

  // Generate slots applying all filters
  const slots = generateBookingSlots(link, bookedSlots, blockedDates);

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

  // ── Race-condition guard: attempt to claim the slot atomically ────
  const lockKey = `booking:slot:${token}:${slotStart}`;
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
  const sender  = EMAIL_SENDER || ONEDRIVE_USER;
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
        subject: `Interview Confirmed: ${link.title} — ${booking.candidateName} — CTI ClaudeHire`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ClaudeHire', address: sender } },
        toRecipients: [{ emailAddress: { address: booking.candidateEmail } }],
      },
      saveToSentItems: true,
    }),
  });
}

async function sendBookingCancellationEmail(booking, link) {
  const sender  = EMAIL_SENDER || ONEDRIVE_USER;
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
        subject: `Interview Cancelled: ${link.title || 'Interview'} — ${booking.candidateName} — CTI ClaudeHire`,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: 'CTI ClaudeHire', address: sender } },
        toRecipients: [{ emailAddress: { address: booking.candidateEmail } }],
      },
      saveToSentItems: true,
    }),
  });
}
