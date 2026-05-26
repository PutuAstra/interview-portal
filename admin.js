// ─────────────────────────────────────────────────────────────
//  Interview Admin Panel
// ─────────────────────────────────────────────────────────────

const WORKER_URL = 'https://interview-api.putuastrawijaya.workers.dev';

// ── State ─────────────────────────────────────────────────────
let adminKey = '';
let questions = [];
let currentInterviewId = null;
let editInterviewId = null;
let editQuestions = [];
let _allInterviews = [];
let _allSessions = [];
let _sessionFilter = 'all';
let _allTWSessions = [];
let _twFilter = 'all';
let _twSourceFilter = 'all'; // 'all' | 'DIRECT_INVITE' | 'CANDIDATE_BOOKING'
let _twSort = 'asc';
let _bulkRows = [];
let _bulkHeaders = [];
let _bulkNameCol = null;
let _bulkEmailCol = null;
let _decisionFilter = 'all';
let _starFilter = 0;
let _reviewStars = 0;
let _sessionSortCol = null;
let _sessionSortDir = 'desc';
let _scriptClients = [];

// ── Auth ──────────────────────────────────────────────────────

async function doLogin() {
  const key = document.getElementById('key-input').value.trim();
  if (!key) return;
  try {
    const res = await api('GET', '/api/interviews', null, key);
    if (res.status === 401) {
      document.getElementById('login-err').style.display = 'block';
      return;
    }
    adminKey = key;
    sessionStorage.setItem('interview_admin_key', key);
    showApp();
  } catch {
    document.getElementById('login-err').style.display = 'block';
  }
}

function doLogout() {
  sessionStorage.removeItem('interview_admin_key');
  adminKey = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-gate').style.display = 'flex';
}

function showApp() {
  document.getElementById('login-gate').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  const valid = ['ow-list', 'ow-create', 'tw-list', 'tw-schedule', 'scripts', 'booking', 'booking-create', 'booking-edit', 'holidays'];
  const hash  = window.location.hash.replace('#', '');
  gotoPage(valid.includes(hash) ? hash : 'ow-list');
}

window.addEventListener('DOMContentLoaded', () => {
  const saved = sessionStorage.getItem('interview_admin_key');
  if (saved) { adminKey = saved; showApp(); }
  document.getElementById('key-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
});

// ── API client ────────────────────────────────────────────────

async function api(method, path, body = null, keyOverride = null) {
  return fetch(WORKER_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': keyOverride || adminKey },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function apiJSON(method, path, body = null) {
  const res = await api(method, path, body);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ── Navigation ────────────────────────────────────────────────

function toggleSidebarGroup(btn) {
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
  btn.nextElementSibling.classList.toggle('collapsed', expanded);
}

function gotoPage(page) {
  history.replaceState(null, '', '#' + page);
  const activeNav = ['ow-create', 'ow-list'].includes(page) ? 'ow-list'
                  : page === 'scripts' ? 'scripts'
                  : ['booking', 'booking-create', 'booking-edit'].includes(page) ? 'booking'
                  : page === 'holidays' ? 'holidays'
                  : 'tw-list';
  document.querySelectorAll('.sidebar-item').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.page === activeNav)
  );
  const main = document.getElementById('admin-main');
  main.innerHTML = '<div class="spinner" style="margin:auto;margin-top:80px"></div>';

  if (page === 'ow-list')        renderOWListPage();
  if (page === 'ow-create')      renderOWCreatePage();
  if (page === 'tw-list')        renderTWListPage();
  if (page === 'tw-schedule')    renderTWSchedulePage();
  if (page === 'scripts')        renderScriptPage();
  if (page === 'booking')        renderBookingPage();
  if (page === 'booking-create') renderCreateBookingLinkPage();
  if (page === 'booking-edit')   renderEditBookingLinkPage(_editingBookingToken);
  if (page === 'holidays')       renderHolidaysPage();
}

// ── One-Way: List page ────────────────────────────────────────

async function renderOWListPage() {
  const main = document.getElementById('admin-main');
  main.innerHTML = `
    <div class="flex justify-between items-center mb-16">
      <h2>One-Way Interviews</h2>
      <button class="btn btn-primary" onclick="gotoPage('ow-create')">+ New Interview</button>
    </div>
    <div class="flex gap-8 mb-16 items-center">
      <input type="text" id="search-interviews" placeholder="Search interviews…"
        oninput="filterAndRenderInterviews()"
        style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 12px;color:var(--text);font-size:13px;width:220px" />
      <select id="sort-interviews" onchange="filterAndRenderInterviews()"
        style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 12px;color:var(--text);font-size:13px">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="az">A → Z</option>
        <option value="za">Z → A</option>
        <option value="candidates">Most candidates</option>
      </select>
    </div>
    <div id="interviews-list"><div class="empty-state">Loading…</div></div>
  `;
  loadInterviews();
}

// ── One-Way: Create page ──────────────────────────────────────

function renderOWCreatePage() {
  questions = [{ text: '', duration: 120 }];
  const main = document.getElementById('admin-main');
  main.innerHTML = `
    <div style="max-width:680px">
      <h2 class="mb-16">New One-Way Interview</h2>
      <div class="card">
        <div class="form-group">
          <label>Interview Title *</label>
          <input type="text" id="new-title" placeholder="e.g. J1 Intern Initial Screening" />
        </div>
        <div class="form-group">
          <label>Description (shown to candidate)</label>
          <textarea id="new-desc" placeholder="Brief instructions for the candidate..."></textarea>
        </div>
        <hr class="divider" />
        <div class="flex justify-between items-center mb-16">
          <h3>Questions</h3>
          <button class="btn btn-outline" onclick="addQuestion()">+ Add Question</button>
        </div>
        <div id="questions-builder"></div>
        <div class="mt-24 flex gap-8">
          <button class="btn btn-primary" onclick="submitInterview()">Create Interview</button>
          <button class="btn btn-outline" onclick="gotoPage('ow-list')">Cancel</button>
        </div>
      </div>
    </div>
  `;
  renderQuestions();
}

// ── Interviews list ───────────────────────────────────────────

async function loadInterviews() {
  const el = document.getElementById('interviews-list');
  if (!el) return;
  el.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const interviews = await apiJSON('GET', '/api/interviews');
    _allInterviews = interviews;
    if (!interviews.length) {
      el.innerHTML = `<div class="empty-state">No interviews yet. <button class="btn btn-primary" style="margin-top:12px" onclick="gotoPage('ow-create')">Create one</button></div>`;
      return;
    }
    filterAndRenderInterviews();
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="color:var(--red)">${e.message}</div>`;
  }
}

function filterAndRenderInterviews() {
  const query = (document.getElementById('search-interviews')?.value || '').trim().toLowerCase();
  const sort = document.getElementById('sort-interviews')?.value || 'newest';

  let list = _allInterviews.filter(i => !query || i.title.toLowerCase().includes(query));
  list.sort((a, b) => {
    if (sort === 'newest')     return b.createdAt - a.createdAt;
    if (sort === 'oldest')     return a.createdAt - b.createdAt;
    if (sort === 'az')         return a.title.localeCompare(b.title);
    if (sort === 'za')         return b.title.localeCompare(a.title);
    if (sort === 'candidates') return (b._counts?.total || 0) - (a._counts?.total || 0);
    return 0;
  });

  const el = document.getElementById('interviews-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div class="empty-state">No interviews match your search.</div>';
    return;
  }
  el.innerHTML = list.map(renderInterviewCard).join('');
}

function renderInterviewCard(interview) {
  const qCount = interview.questions?.length || 0;
  const created = new Date(interview.createdAt).toLocaleDateString();
  const c = interview._counts || { total: 0, pending: 0, completed: 0 };

  const candidateLine = c.total > 0
    ? `<span style="font-weight:600">${c.total} Candidate${c.total !== 1 ? 's' : ''}</span> <span class="text-muted">&nbsp;·&nbsp; ${c.pending} Pending &nbsp;·&nbsp; ${c.completed} Completed</span>`
    : `<span class="text-muted">No candidates yet</span>`;

  return `
    <div class="card" style="margin-bottom:10px">
      <div class="flex justify-between items-center">
        <div>
          <h3>${esc(interview.title)}</h3>
          <p class="text-muted text-sm" style="margin-top:4px">${qCount} question${qCount !== 1 ? 's' : ''} &nbsp;·&nbsp; Created ${created}</p>
          <p class="text-sm" style="margin-top:6px">${candidateLine}</p>
        </div>
        <div class="flex gap-8 items-center">
          <button class="btn btn-primary" onclick="openSessions('${interview.id}', '${esc(interview.title)}', 'candidates')">Candidates</button>
          <button class="btn btn-outline" onclick="openSessions('${interview.id}', '${esc(interview.title)}', 'invite')">Invite</button>
          <button class="btn btn-ghost" style="padding:6px 10px;font-size:15px" title="Edit" onclick="openEditInterview('${interview.id}')"><span style="display:inline-block;transform:rotate(45deg)">✏</span></button>
          <button class="btn btn-ghost" style="padding:6px 10px;font-size:16px" title="Delete" onclick="deleteInterview('${interview.id}')">🗑</button>
        </div>
      </div>
    </div>
  `;
}

async function deleteInterview(id) {
  if (!confirm('Delete this interview and all its sessions?')) return;
  try {
    await apiJSON('DELETE', `/api/interview/${id}`);
    toast('Interview deleted', 'success');
    loadInterviews();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Questions builder (one-way) ───────────────────────────────

function addQuestion() {
  questions.push({ text: '', duration: 120 });
  renderQuestions();
}

function removeQuestion(i) {
  if (questions.length === 1) return toast('Need at least one question', 'error');
  questions.splice(i, 1);
  renderQuestions();
}

function moveQuestion(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= questions.length) return;
  [questions[i], questions[j]] = [questions[j], questions[i]];
  renderQuestions();
}

function renderQuestions() {
  const builder = document.getElementById('questions-builder');
  if (!builder) return;
  builder.innerHTML = questions.map((q, i) => `
    <div class="question-item">
      <div class="q-num">${i + 1}</div>
      <div class="q-fields">
        <input type="text" placeholder="Question text *" value="${esc(q.text)}"
          oninput="questions[${i}].text = this.value" />
        <select onchange="questions[${i}].duration = parseInt(this.value)">
          ${[30, 60, 90, 120, 180, 240, 300].map(s =>
            `<option value="${s}" ${q.duration === s ? 'selected' : ''}>${s}s (${s < 60 ? s + 's' : (s/60) + ' min'})</option>`
          ).join('')}
        </select>
      </div>
      <button class="btn btn-ghost" onclick="moveQuestion(${i}, -1)" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn btn-ghost" onclick="removeQuestion(${i})" style="color:var(--red)">✕</button>
    </div>
  `).join('');
}

async function submitInterview() {
  const title = document.getElementById('new-title').value.trim();
  const description = document.getElementById('new-desc').value.trim();
  if (!title) return toast('Title is required', 'error');
  if (questions.some(q => !q.text.trim())) return toast('All questions need text', 'error');
  try {
    await apiJSON('POST', '/api/interviews', { title, description, questions });
    toast('Interview created!', 'success');
    gotoPage('ow-list');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Two-Way: List page ────────────────────────────────────────

async function renderTWListPage() {
  const main = document.getElementById('admin-main');
  main.innerHTML = `
    <div class="flex justify-between items-center mb-16">
      <h2>Two-Way Interview Sessions</h2>
      <button class="btn btn-primary" onclick="gotoPage('tw-schedule')">+ Schedule Direct Invite</button>
    </div>

    <!-- Row 1: Search + Status filters -->
    <div class="flex gap-8 mb-16 items-center" style="flex-wrap:wrap">
      <input type="text" id="tw-search" placeholder="Search candidates…"
        oninput="filterAndRenderTWSessions()"
        style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 12px;color:var(--text);font-size:13px;width:220px" />
      <div class="flex gap-8">
        <button class="filter-chip active" id="tw-fc-all"        onclick="setTWFilter('all')">All Status</button>
        <button class="filter-chip"        id="tw-fc-scheduled"  onclick="setTWFilter('scheduled')">Scheduled</button>
        <button class="filter-chip"        id="tw-fc-completed"  onclick="setTWFilter('completed')">Completed</button>
        <button class="filter-chip"        id="tw-fc-cancelled"  onclick="setTWFilter('cancelled')">Cancelled</button>
      </div>
    </div>

    <!-- Row 2: Source filter -->
    <div class="flex gap-8 mb-16 items-center">
      <span style="font-size:12px;color:var(--muted);font-weight:500;white-space:nowrap">Source:</span>
      <div class="flex gap-8">
        <button class="filter-chip active" id="tw-src-all"    onclick="setTWSourceFilter('all')">All</button>
        <button class="filter-chip"        id="tw-src-direct" onclick="setTWSourceFilter('DIRECT_INVITE')"
          style="display:inline-flex;align-items:center;gap:4px">
          <span style="font-size:11px">✉</span> Direct Invite
        </button>
        <button class="filter-chip"        id="tw-src-booked" onclick="setTWSourceFilter('CANDIDATE_BOOKING')"
          style="display:inline-flex;align-items:center;gap:4px">
          <span style="font-size:11px">🗓</span> Self-Booked
        </button>
      </div>
    </div>

    <div class="tw-table-header">
      <span>Candidate</span>
      <span>Position</span>
      <span style="cursor:pointer;user-select:none" onclick="toggleTWSort()">Scheduled <span id="tw-sort-indicator">↓</span></span>
      <span style="text-align:center">Status</span>
      <span style="text-align:right">Actions</span>
    </div>
    <div id="tw-sessions-list"></div>
  `;
  await loadTWSessions();
}

async function loadTWSessions() {
  const el = document.getElementById('tw-sessions-list');
  if (!el) return;
  el.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const sessions    = await apiJSON('GET', '/api/tw-sessions/unified');
    _allTWSessions    = sessions;
    _twFilter         = 'all';
    _twSourceFilter   = 'all';
    setTWFilter('all');
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="color:var(--red)">${e.message}</div>`;
  }
}

function toggleTWSort() {
  _twSort = _twSort === 'asc' ? 'desc' : 'asc';
  const ind = document.getElementById('tw-sort-indicator');
  if (ind) ind.textContent = _twSort === 'asc' ? '↑' : '↓';
  filterAndRenderTWSessions();
}

function setTWFilter(filter) {
  _twFilter = filter;
  ['all', 'scheduled', 'completed', 'cancelled'].forEach(f => {
    const chip = document.getElementById(`tw-fc-${f}`);
    if (chip) chip.classList.toggle('active', f === filter);
  });
  filterAndRenderTWSessions();
}

function setTWSourceFilter(source) {
  _twSourceFilter = source;
  const idMap = { all: 'tw-src-all', DIRECT_INVITE: 'tw-src-direct', CANDIDATE_BOOKING: 'tw-src-booked' };
  Object.entries(idMap).forEach(([key, id]) => {
    const chip = document.getElementById(id);
    if (chip) chip.classList.toggle('active', key === source);
  });
  filterAndRenderTWSessions();
}

function filterAndRenderTWSessions() {
  const query = (document.getElementById('tw-search')?.value || '').trim().toLowerCase();
  let list = _allTWSessions.filter(s => {
    if (_twFilter !== 'all' && s.status !== _twFilter) return false;
    if (_twSourceFilter !== 'all' && s.scheduling_source !== _twSourceFilter) return false;
    if (query && !s.candidateName.toLowerCase().includes(query) &&
        !(s.candidateEmail || '').toLowerCase().includes(query) &&
        !(s.position || '').toLowerCase().includes(query)) return false;
    return true;
  });

  list.sort((a, b) => {
    const ta = a.scheduledAt || 0, tb = b.scheduledAt || 0;
    return _twSort === 'asc' ? ta - tb : tb - ta;
  });

  const el = document.getElementById('tw-sessions-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">${_allTWSessions.length ? 'No sessions match your filter.' : 'No sessions scheduled yet.'}</div>`;
    return;
  }
  el.innerHTML = list.map(renderTWSessionRow).join('');
}

function renderTWSessionRow(s) {
  const dt = s.scheduledAt ? new Date(s.scheduledAt) : null;
  const dateStr = dt ? dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const timeStr = dt ? dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  const safeName = esc(s.candidateName).replace(/'/g, "\\'");

  // Status badge
  const statusBadge = {
    scheduled: `<span class="badge badge-pending">Scheduled</span>`,
    completed:  `<span class="badge badge-completed">Completed</span>`,
    cancelled:  `<span class="badge" style="background:rgba(148,163,184,0.15);color:var(--muted)">Cancelled</span>`,
  }[s.status] || `<span class="badge badge-pending">${esc(s.status)}</span>`;

  // Source badge
  const sourceBadge = s.scheduling_source === 'DIRECT_INVITE'
    ? `<span style="display:inline-flex;align-items:center;gap:3px;background:rgba(59,130,246,0.1);color:#3b82f6;border:1px solid rgba(59,130,246,0.2);border-radius:20px;padding:2px 8px;font-size:10px;font-weight:600;white-space:nowrap;margin-top:3px">✉ Direct Invite</span>`
    : `<span style="display:inline-flex;align-items:center;gap:3px;background:rgba(22,163,74,0.1);color:#16a34a;border:1px solid rgba(22,163,74,0.2);border-radius:20px;padding:2px 8px;font-size:10px;font-weight:600;white-space:nowrap;margin-top:3px">🗓 Self-Booked</span>`;

  // Actions — split by scheduling_source
  let actions = '';
  if (s.scheduling_source === 'DIRECT_INVITE') {
    if (s.status === 'scheduled') {
      actions = `
        ${s.meetingLink ? `<a href="${esc(s.meetingLink)}" target="_blank" class="btn btn-ghost" style="padding:4px 8px;font-size:12px">${s.teamsGenerated ? '🟦' : '🔗'} Join</a>` : ''}
        <button class="btn btn-outline" style="padding:4px 10px;font-size:12px" onclick="markTWCompleted('${s.id}')">✓ Done</button>
        <button class="btn btn-danger"  style="padding:4px 10px;font-size:12px" onclick="cancelTWSession('${s.id}','${safeName}')">Cancel</button>
      `;
    } else if (s.status === 'completed') {
      const recBtn = s.recordingDriveItemId
        ? `<button class="btn btn-outline" style="padding:4px 10px;font-size:12px;color:var(--accent);border-color:var(--accent)" onclick="openTWRecording('${s.id}')">▶ Recording</button>`
        : `<button class="btn btn-ghost"   style="padding:4px 10px;font-size:12px" title="Search OneDrive Recordings folder" onclick="fetchAndRefreshTWRecording('${s.id}')">⟳ Fetch</button>`;
      actions = `${recBtn}<button class="btn btn-ghost" style="padding:4px 8px;font-size:16px;line-height:1" onclick="deleteTWSession('${s.id}','${safeName}')">🗑</button>`;
    } else {
      actions = `<button class="btn btn-ghost" style="padding:4px 8px;font-size:16px;line-height:1" onclick="deleteTWSession('${s.id}','${safeName}')">🗑</button>`;
    }
  } else {
    // CANDIDATE_BOOKING
    if (s.status === 'scheduled') {
      actions = `
        ${s.meetingLink ? `<a href="${esc(s.meetingLink)}" target="_blank" class="btn btn-ghost" style="padding:4px 8px;font-size:12px">🟦 Join</a>` : ''}
        <button class="btn btn-outline" style="padding:4px 10px;font-size:12px" onclick="markSelfBookedCompleted('${s.id}')">✓ Done</button>
        <button class="btn btn-danger"  style="padding:4px 10px;font-size:12px" onclick="cancelSelfBookedSession('${s.id}','${safeName}')">Cancel</button>
      `;
    } else {
      actions = `<span class="text-muted" style="font-size:12px">—</span>`;
    }
  }

  const positionLabel = s.position || (s.linkTitle ? `via ${esc(s.linkTitle)}` : '—');

  return `
    <div class="tw-session-row">
      <div style="min-width:0">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.candidateName)}</div>
        <div class="text-muted" style="font-size:11px">${s.candidateEmail ? esc(s.candidateEmail) : ''}${s.teamsGenerated ? ' &nbsp;·&nbsp; <span style="color:#6264a7">Teams</span>' : ''}</div>
        ${sourceBadge}
      </div>
      <div style="font-size:13px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${positionLabel}</div>
      <div>
        <div style="font-size:13px">${dateStr}</div>
        <div class="text-muted" style="font-size:11px">${timeStr}${s.duration ? ' · ' + s.duration + ' min' : ''}</div>
      </div>
      <div style="text-align:center">${statusBadge}</div>
      <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px">${actions}</div>
    </div>
  `;
}

async function markTWCompleted(id) {
  if (!confirm('Mark this session as completed?')) return;
  try {
    await apiJSON('PUT', `/api/tw-session/${id}`, { status: 'completed' });
    toast('Marked as completed — searching for recording…', 'info');
    await loadTWSessions();
    // Auto-try to find the recording in OneDrive
    try {
      const result = await apiJSON('POST', `/api/tw-session/${id}/fetch-recording`);
      if (result.ok) {
        toast('Recording found and linked!', 'success');
        await loadTWSessions();
      } else {
        toast(result.message || 'No recording found yet — use ⟳ Fetch Recording to retry later.', 'info');
      }
    } catch { /* recording not ready yet */ }
  } catch (e) { toast(e.message, 'error'); }
}

async function fetchAndRefreshTWRecording(id) {
  toast('Searching OneDrive Recordings…', 'info');
  try {
    const result = await apiJSON('POST', `/api/tw-session/${id}/fetch-recording`);
    if (result.ok) {
      toast('Recording found: ' + result.fileName, 'success');
      await loadTWSessions();
    } else {
      toast(result.message || 'No recording found yet.', 'info');
    }
  } catch (e) { toast(e.message, 'error'); }
}

async function openTWRecording(id) {
  toast('Loading recording…', 'info');
  try {
    const { downloadUrl, webUrl, fileName } = await apiJSON('GET', `/api/tw-session/${id}/recording-url`);
    document.getElementById('review-candidate-name').textContent = fileName || 'Meeting Recording';
    document.getElementById('review-interview-title').textContent = 'Two-Way Interview Recording';
    document.getElementById('review-content').innerHTML = downloadUrl
      ? `<video src="${downloadUrl}" controls style="width:100%;border-radius:6px;background:#000;display:block"></video>
         <div class="mt-8" style="text-align:right">
           <a href="${webUrl}" target="_blank" class="btn btn-ghost" style="font-size:11px">Open in OneDrive ↗</a>
         </div>`
      : `<div class="empty-state"><a href="${webUrl}" target="_blank" class="btn btn-primary">Open Recording in OneDrive ↗</a></div>`;
    openModal('modal-review');
  } catch (e) { toast(e.message, 'error'); }
}

async function cancelTWSession(id, name) {
  if (!confirm(`Cancel ${name}'s interview session?\nA cancellation email will be sent to the candidate if an email address is on file.`)) return;
  try {
    const data = await apiJSON('PUT', `/api/tw-session/${id}`, { status: 'cancelled' });
    if (data.emailSent) {
      toast('Session cancelled & candidate notified', 'success');
    } else if (data.candidateEmail) {
      toast('Session cancelled (email failed — check EMAIL_SENDER secret in Cloudflare)', 'warning');
    } else {
      toast('Session cancelled (no email on file)', 'success');
    }
    await loadTWSessions();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteTWSession(id, name) {
  if (!confirm(`Delete ${name}'s session record?`)) return;
  try {
    await apiJSON('DELETE', `/api/tw-session/${id}`);
    toast('Session deleted', 'success');
    await loadTWSessions();
  } catch (e) { toast(e.message, 'error'); }
}

// Self-Booked session actions
async function markSelfBookedCompleted(id) {
  if (!confirm('Mark this booking as completed?')) return;
  try {
    await apiJSON('PUT', `/api/booking/booking/${id}`, { status: 'completed' });
    toast('Marked as completed', 'success');
    await loadTWSessions();
  } catch (e) { toast(e.message, 'error'); }
}

async function cancelSelfBookedSession(id, name) {
  if (!confirm(`Cancel ${name}'s booking?\nThis will remove the Teams meeting and send a cancellation email.`)) return;
  try {
    const data = await apiJSON('DELETE', `/api/booking/booking/${id}`);
    if (data.emailSent) {
      toast('Booking cancelled & candidate notified', 'success');
    } else {
      toast('Booking cancelled (email failed — check EMAIL_SENDER secret in Cloudflare)', 'warning');
    }
    await loadTWSessions();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Two-Way: Schedule page ────────────────────────────────────


function renderTWSchedulePage() {
  const main = document.getElementById('admin-main');
  main.innerHTML = `
    <div style="max-width:680px">
      <h2 class="mb-16">Schedule Two-Way Interview</h2>
      <div class="card">
        <div class="form-row" style="grid-template-columns:1fr 1fr;gap:16px">
          <div class="form-group" style="margin-bottom:0">
            <label>Candidate Name *</label>
            <input type="text" id="tw-cand-name" placeholder="Full name" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Candidate Email *</label>
            <input type="email" id="tw-cand-email" placeholder="email@example.com" />
          </div>
        </div>
        <div class="form-group mt-16">
          <label>Position / Role *</label>
          <input type="text" id="tw-position" placeholder="e.g. J1 Summer Intern – Marketing" />
        </div>
        <div class="form-row mt-8" style="grid-template-columns:1fr 1fr 1fr;gap:16px">
          <div class="form-group" style="margin-bottom:0">
            <label>Date *</label>
            <input type="date" id="tw-date"
              value="${(() => { const d = new Date(); d.setDate(d.getDate()+1); return d.toISOString().split('T')[0]; })()}"
              min="${new Date().toISOString().split('T')[0]}" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Time * &nbsp;<span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">${(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch(e){ return ''; } })()}</span></label>
            <div style="display:flex;gap:6px">
              <select id="tw-time-h" style="flex:1">${[...Array(12)].map((_,i)=>{ const v=String(i+1).padStart(2,'0'); return `<option value="${v}"${i===8?' selected':''}>${v}</option>`; }).join('')}</select>
              <select id="tw-time-m" style="flex:1"><option value="00" selected>00</option><option value="15">15</option><option value="30">30</option><option value="45">45</option></select>
              <select id="tw-time-ap" style="flex:1"><option value="AM" selected>AM</option><option value="PM">PM</option></select>
            </div>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Duration</label>
            <select id="tw-duration">
              <option value="30">30 minutes</option>
              <option value="45">45 minutes</option>
              <option value="60" selected>60 minutes</option>
              <option value="90">90 minutes</option>
              <option value="120">2 hours</option>
            </select>
          </div>
        </div>

        <!-- Teams meeting section -->
        <div class="form-group mt-16">
          <label>Microsoft Teams Meeting</label>
          <div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:6px;cursor:pointer"
            onclick="document.getElementById('tw-auto-meeting').click()">
            <input type="checkbox" id="tw-auto-meeting" checked
              style="accent-color:var(--accent);width:16px;height:16px;flex-shrink:0;margin-top:2px;cursor:pointer"
              onclick="event.stopPropagation()"
              onchange="toggleTWAutoMeeting(this.checked)" />
            <div>
              <div style="font-size:13px;font-weight:600;color:var(--text)">Auto-generate Microsoft Teams link</div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px" id="tw-teams-description">
                Creates a Teams meeting on <strong style="color:var(--text-2)">corporate-recruiter@cti-usa.com</strong> calendar.
                Candidate receives a calendar invite with the join link automatically.
              </div>
            </div>
          </div>
        </div>
        <div id="tw-manual-link-wrap" style="display:none">
          <div class="form-group">
            <label>Meeting Link (manual)</label>
            <input type="url" id="tw-meeting-link" placeholder="https://teams.microsoft.com/… or Zoom link" />
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;cursor:pointer"
            onclick="document.getElementById('tw-send-email').click()">
            <input type="checkbox" id="tw-send-email"
              style="accent-color:var(--accent);width:14px;height:14px;flex-shrink:0;cursor:pointer"
              onclick="event.stopPropagation()" />
            <span style="font-size:13px;color:var(--muted)">Send email invite to candidate</span>
          </div>
        </div>

        <div class="form-group mt-8">
          <label>Notes (optional)</label>
          <textarea id="tw-notes" placeholder="Internal notes about this session..."></textarea>
        </div>
        <div class="flex gap-8 items-center">
          <button class="btn btn-primary" id="tw-schedule-btn" onclick="submitTWSession()">Schedule &amp; Create Teams Meeting</button>
          <button class="btn btn-outline" onclick="gotoPage('tw-list')">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function toggleTWAutoMeeting(checked) {
  document.getElementById('tw-manual-link-wrap').style.display = checked ? 'none' : 'block';
  document.getElementById('tw-schedule-btn').textContent = checked
    ? 'Schedule & Create Teams Meeting'
    : 'Schedule Interview';
}

async function submitTWSession() {
  const candidateName  = document.getElementById('tw-cand-name').value.trim();
  const candidateEmail = document.getElementById('tw-cand-email').value.trim();
  const position       = document.getElementById('tw-position').value.trim();
  const date           = document.getElementById('tw-date').value;
  const twH = document.getElementById('tw-time-h').value;
  const twM = document.getElementById('tw-time-m').value;
  const twAP = document.getElementById('tw-time-ap').value;
  let twHour24 = parseInt(twH);
  if (twAP === 'PM' && twHour24 !== 12) twHour24 += 12;
  if (twAP === 'AM' && twHour24 === 12) twHour24 = 0;
  const time = `${String(twHour24).padStart(2,'0')}:${twM}`;
  const duration       = parseInt(document.getElementById('tw-duration').value);
  const autoMeeting    = document.getElementById('tw-auto-meeting').checked;
  const meetingLink    = !autoMeeting ? (document.getElementById('tw-meeting-link')?.value.trim() || '') : '';
  const notes          = document.getElementById('tw-notes').value.trim();
  const sendEmail      = !autoMeeting && document.getElementById('tw-send-email')?.checked;

  if (!candidateName)  return toast('Candidate name is required', 'error');
  if (!candidateEmail) return toast('Candidate email is required', 'error');
  if (!position)       return toast('Position is required', 'error');
  if (!date || !time)  return toast('Date and time are required', 'error');

  const btn = document.getElementById('tw-schedule-btn');
  btn.disabled = true;
  btn.textContent = autoMeeting ? 'Creating Teams meeting…' : 'Scheduling…';

  const scheduledAt = new Date(`${date}T${time}`).getTime();

  try {
    const session = await apiJSON('POST', '/api/tw-sessions', {
      candidateName, candidateEmail, position,
      scheduledAt, duration, meetingLink, notes, autoMeeting,
    });

    if (session.teamsError) {
      toast('Scheduled, but Teams failed: ' + session.teamsError, 'info');
    } else if (autoMeeting && session.teamsGenerated) {
      toast('Teams meeting created! Calendar invite sent to candidate.', 'success');
    } else if (sendEmail && session.id) {
      try {
        await apiJSON('POST', `/api/tw-session/${session.id}/send-email`);
        toast('Session scheduled & email sent!', 'success');
      } catch {
        toast('Scheduled, but email could not be sent', 'info');
      }
    } else {
      toast('Session scheduled!', 'success');
    }
    gotoPage('tw-list');
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = autoMeeting ? 'Schedule & Create Teams Meeting' : 'Schedule Interview';
  }
}

// ── Sessions modal (one-way) ──────────────────────────────────

function switchSessionTab(name) {
  ['invite', 'candidates'].forEach(t => {
    document.getElementById(`session-pane-${t}`).style.display = t === name ? 'block' : 'none';
  });
  const modalEl = document.querySelector('#modal-sessions .modal');
  if (modalEl) {
    if (name === 'invite') {
      modalEl.style.width = '';
      modalEl.style.maxWidth = '660px';
      modalEl.style.height = '';
    } else {
      modalEl.style.width = 'calc(100vw - 160px)';
      modalEl.style.maxWidth = 'calc(100vw - 160px)';
      modalEl.style.height = 'calc(100vh - 140px)';
    }
  }
}

function resetInviteForm() {
  document.getElementById('new-cand-name').value = '';
  document.getElementById('new-cand-email').value = '';
  document.getElementById('generated-link-box').style.display = 'none';
  const btn = document.getElementById('send-email-btn');
  btn.style.display = 'none';
  btn.disabled = false;
  btn.textContent = '✉ Send Email';
  resetBulkUpload();
  switchInviteMode('single');
}

// ── Invite mode toggle ────────────────────────────────────────

function switchInviteMode(mode) {
  document.getElementById('invite-single-section').style.display = mode === 'single' ? 'block' : 'none';
  document.getElementById('invite-bulk-section').style.display   = mode === 'bulk'   ? 'block' : 'none';
  document.getElementById('invite-mode-single').classList.toggle('active', mode === 'single');
  document.getElementById('invite-mode-bulk').classList.toggle('active',   mode === 'bulk');
}

// ── Bulk import ───────────────────────────────────────────────

async function handleBulkFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();

  let rows, headers;
  try {
    if (ext === 'csv') {
      const text = await file.text();
      ({ rows, headers } = parseCsvText(text));
    } else if (ext === 'xlsx' || ext === 'xls') {
      if (typeof XLSX === 'undefined') return toast('Excel library not loaded — try CSV instead', 'error');
      const buffer = await file.arrayBuffer();
      ({ rows, headers } = parseXlsxBuffer(buffer));
    } else {
      return toast('Please upload a .csv, .xlsx, or .xls file', 'error');
    }
  } catch (e) {
    return toast('Could not read file: ' + e.message, 'error');
  }

  if (!rows.length) return toast('No data rows found in file', 'error');

  _bulkRows    = rows;
  _bulkHeaders = headers;

  // Auto-detect name column
  _bulkNameCol = detectBestCol(headers, ['full name', 'fullname', 'name', 'candidate']);
  if (!_bulkNameCol) {
    const first = headers.find(h => /first.?name|fname/i.test(h));
    const last  = headers.find(h => /last.?name|lname|surname/i.test(h));
    if (first && last) _bulkNameCol = `__concat__${first}__${last}`;
    else _bulkNameCol = first || last || headers[0];
  }

  // Auto-detect email column
  _bulkEmailCol = detectBestCol(headers, ['email', 'e-mail', 'mail']);

  renderBulkPreview();
}

function detectBestCol(headers, keywords) {
  for (const kw of keywords) {
    const m = headers.find(h => h.toLowerCase().includes(kw));
    if (m) return m;
  }
  return null;
}

function parseCsvText(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  if (!lines.length) return { rows: [], headers: [] };

  const parseRow = line => {
    const result = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    result.push(cur.trim());
    return result;
  };

  const headers = parseRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseRow(lines[i]);
    if (cells.every(c => !c)) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] || ''; });
    rows.push(obj);
  }
  return { rows, headers };
}

function parseXlsxBuffer(buffer) {
  const wb   = XLSX.read(buffer, { type: 'array' });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!data.length) return { rows: [], headers: [] };

  const headers = data[0].map(String);
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const cells = data[i];
    if (cells.every(c => !String(c))) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = String(cells[idx] ?? ''); });
    rows.push(obj);
  }
  return { rows, headers };
}

function getBulkName(row) {
  if (_bulkNameCol?.startsWith('__concat__')) {
    const parts = _bulkNameCol.slice('__concat__'.length).split('__');
    return parts.map(k => row[k] || '').filter(Boolean).join(' ');
  }
  return row[_bulkNameCol] || '';
}

function getBulkEmail(row) {
  return row[_bulkEmailCol] || '';
}

function renderBulkPreview() {
  const section = document.getElementById('bulk-preview-section');

  // Build name options (includes concat option if first+last exist)
  const first = _bulkHeaders.find(h => /first.?name|fname/i.test(h));
  const last  = _bulkHeaders.find(h => /last.?name|lname|surname/i.test(h));
  const concatKey = first && last ? `__concat__${first}__${last}` : null;

  const nameOpts = [
    ...(concatKey ? [`<option value="${esc(concatKey)}" ${_bulkNameCol === concatKey ? 'selected' : ''}>First + Last Name</option>`] : []),
    ..._bulkHeaders.map(h => `<option value="${esc(h)}" ${_bulkNameCol === h ? 'selected' : ''}>${esc(h)}</option>`),
  ].join('');

  const emailOpts = _bulkHeaders
    .map(h => `<option value="${esc(h)}" ${_bulkEmailCol === h ? 'selected' : ''}>${esc(h)}</option>`)
    .join('');

  const preview = _bulkRows.slice(0, 5);
  const validCount = _bulkRows.filter(r => getBulkName(r) && getBulkEmail(r)).length;

  section.style.display = 'block';
  section.innerHTML = `
    <div style="margin-top:14px;padding:14px 16px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end;margin-bottom:14px">
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);display:block;margin-bottom:4px">Name Column</label>
          <select id="bulk-name-col" onchange="_bulkNameCol=this.value;renderBulkPreview()"
            style="width:100%;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:13px;font-family:inherit">
            ${nameOpts}
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);display:block;margin-bottom:4px">Email Column</label>
          <select id="bulk-email-col" onchange="_bulkEmailCol=this.value;renderBulkPreview()"
            style="width:100%;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:13px;font-family:inherit">
            ${emailOpts}
          </select>
        </div>
        <button class="btn btn-ghost" style="font-size:12px;white-space:nowrap" onclick="resetBulkUpload()">✕ Clear</button>
      </div>

      <div style="font-size:12px;color:var(--muted);margin-bottom:6px">
        Preview — first 5 of <strong style="color:var(--text)">${_bulkRows.length}</strong> rows
        ${validCount < _bulkRows.length ? `<span style="color:var(--red)">&nbsp;·&nbsp; ${_bulkRows.length - validCount} rows missing name or email</span>` : ''}
      </div>
      <div style="border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;padding:7px 12px;background:var(--card-2);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted)">
          <span>Name</span><span>Email</span>
        </div>
        ${preview.map(r => {
          const name = getBulkName(r), email = getBulkEmail(r);
          return `<div style="display:grid;grid-template-columns:1fr 1fr;padding:7px 12px;border-top:1px solid rgba(51,65,85,0.5);font-size:12px${!name || !email ? ';background:rgba(239,68,68,0.05)' : ''}">
            <span style="${!name ? 'color:var(--red)' : ''}">${name || '⚠ missing'}</span>
            <span style="${!email ? 'color:var(--red)' : ''}">${email || '⚠ missing'}</span>
          </div>`;
        }).join('')}
        ${_bulkRows.length > 5 ? `<div style="padding:6px 12px;border-top:1px solid rgba(51,65,85,0.5);font-size:11px;color:var(--muted);text-align:center">and ${_bulkRows.length - 5} more…</div>` : ''}
      </div>

      <div class="flex gap-8 items-center">
        <button class="btn btn-primary"  onclick="runBulkImport(false)">Generate Links for ${validCount}</button>
        <button class="btn btn-outline"  onclick="runBulkImport(true)">Generate &amp; Send Emails</button>
      </div>
    </div>
  `;
}

function resetBulkUpload() {
  _bulkRows = []; _bulkHeaders = []; _bulkNameCol = null; _bulkEmailCol = null;
  const preview  = document.getElementById('bulk-preview-section');
  const progress = document.getElementById('bulk-import-progress');
  if (preview)  { preview.style.display  = 'none'; preview.innerHTML  = ''; }
  if (progress) { progress.style.display = 'none'; progress.innerHTML = ''; }
  const fi = document.getElementById('bulk-file-input');
  if (fi) fi.value = '';
}

async function runBulkImport(sendEmails) {
  const validRows = _bulkRows.filter(r => getBulkName(r) && getBulkEmail(r));
  if (!validRows.length) return toast('No valid rows to import', 'error');

  // Disable preview buttons
  document.getElementById('bulk-preview-section').querySelectorAll('button, select').forEach(el => el.disabled = true);

  const progress = document.getElementById('bulk-import-progress');
  progress.style.display = 'block';

  let done = 0, failed = 0;
  const errors = [];
  const total = validRows.length;

  const showProgress = () => {
    const pct = Math.round((done + failed) / total * 100);
    progress.innerHTML = `
      <div style="font-size:13px;color:var(--text-2);margin-bottom:8px">
        Importing${sendEmails ? ' &amp; sending emails' : ''}…
        <strong>${done + failed}</strong> / ${total}
      </div>
      <div style="background:var(--border);border-radius:4px;height:6px;overflow:hidden">
        <div style="background:var(--accent);height:100%;border-radius:4px;width:${pct}%;transition:width 0.15s"></div>
      </div>
    `;
  };

  showProgress();

  for (const row of validRows) {
    try {
      const name  = getBulkName(row);
      const email = getBulkEmail(row);
      const data  = await apiJSON('POST', `/api/interview/${currentInterviewId}/sessions`, {
        candidateName: name, candidateEmail: email,
      });
      if (sendEmails && data.token) {
        try {
          await apiJSON('POST', `/api/session/${data.token}/send-email`, { link: buildTakeUrl(data.token) });
        } catch { /* email fail is non-fatal */ }
      }
      done++;
    } catch (e) {
      failed++;
      errors.push(e.message);
    }
    showProgress();
  }

  progress.innerHTML = `
    <div style="padding:14px 16px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">Import complete</div>
      <div class="flex gap-16">
        <span style="color:var(--green)">✓ ${done} imported${sendEmails ? ' &amp; emailed' : ''}</span>
        ${failed ? `<span style="color:var(--red)">✗ ${failed} failed</span>` : ''}
      </div>
      ${errors.length ? `<div class="text-muted text-sm mt-8">${errors.slice(0, 3).map(e => `<div>• ${esc(e)}</div>`).join('')}${errors.length > 3 ? `<div>…and ${errors.length - 3} more</div>` : ''}</div>` : ''}
      <button class="btn btn-outline mt-16" onclick="resetBulkUpload();switchInviteMode('single')">Done</button>
    </div>
  `;

  await loadSessions(currentInterviewId);
  loadInterviews();
}

async function openSessions(interviewId, title, tab = 'invite') {
  currentInterviewId = interviewId;
  document.getElementById('modal-interview-title').textContent = title;
  resetInviteForm();
  // Reset all filters + sort to defaults
  _decisionFilter = 'all';
  _starFilter = 0;
  _sessionSortCol = null;
  _sessionSortDir = 'desc';
  [['fd-all','all'],['fd-fwd','move_forward'],['fd-rej','not_moving_forward']].forEach(([id, val]) => {
    const c = document.getElementById(id);
    if (c) c.classList.toggle('active', val === 'all');
  });
  [0,1,2,3,4,5].forEach(i => {
    const c = document.getElementById(`fs-${i}`);
    if (c) c.classList.toggle('active', i === 0);
  });
  switchSessionTab(tab);
  openModal('modal-sessions');
  await loadSessions(interviewId);
}

async function loadSessions(interviewId) {
  const el = document.getElementById('sessions-list');
  el.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const sessions = await apiJSON('GET', `/api/interview/${interviewId}/sessions`);
    _allSessions = sessions;
    _sessionFilter = 'all';
    setSessionFilter('all');
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="color:var(--red)">${e.message}</div>`;
  }
}

function setSessionFilter(filter) {
  _sessionFilter = filter;
  ['all', 'pending', 'completed'].forEach(f => {
    const chip = document.getElementById(`fc-${f}`);
    if (chip) chip.classList.toggle('active', f === filter);
  });
  filterAndRenderSessions();
}

function setDecisionFilter(filter) {
  _decisionFilter = filter;
  [['fd-all','all'],['fd-fwd','move_forward'],['fd-rej','not_moving_forward']].forEach(([id, val]) => {
    const c = document.getElementById(id);
    if (c) c.classList.toggle('active', filter === val);
  });
  filterAndRenderSessions();
}

function setStarFilter(n) {
  _starFilter = n;
  [0,1,2,3,4,5].forEach(i => {
    const c = document.getElementById(`fs-${i}`);
    if (c) c.classList.toggle('active', i === n);
  });
  filterAndRenderSessions();
}

function toggleSessionSort(col) {
  if (_sessionSortCol === col) {
    _sessionSortDir = _sessionSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    _sessionSortCol = col;
    _sessionSortDir = 'desc';
  }
  filterAndRenderSessions();
}

function filterAndRenderSessions() {
  const query = (document.getElementById('search-candidates')?.value || '').trim().toLowerCase();
  let list = _allSessions.filter(s => {
    if (_sessionFilter !== 'all' && s.status !== _sessionFilter) return false;
    if (query && !s.candidateName.toLowerCase().includes(query) &&
        !(s.candidateEmail || '').toLowerCase().includes(query)) return false;
    if (_decisionFilter !== 'all' && s.reviewDecision !== _decisionFilter) return false;
    if (_starFilter > 0 && (s.reviewStars || 0) < _starFilter) return false;
    return true;
  });

  // Sort
  if (_sessionSortCol === 'review') {
    list.sort((a, b) => {
      const sa = a.reviewStars || 0, sb = b.reviewStars || 0;
      return _sessionSortDir === 'desc' ? sb - sa : sa - sb;
    });
  } else if (_sessionSortCol === 'status') {
    const order = { completed: 2, in_progress: 1, pending: 0 };
    list.sort((a, b) => {
      const sa = order[a.status] ?? 0, sb = order[b.status] ?? 0;
      return _sessionSortDir === 'desc' ? sb - sa : sa - sb;
    });
  } else if (_sessionSortCol === 'date') {
    list.sort((a, b) => {
      const ta = a.createdAt || 0, tb = b.createdAt || 0;
      return _sessionSortDir === 'desc' ? tb - ta : ta - tb;
    });
  }

  // Sync sort indicators
  const rv = document.getElementById('sort-review-ind');
  const st = document.getElementById('sort-status-ind');
  const dt = document.getElementById('sort-date-ind');
  if (rv) rv.textContent = _sessionSortCol === 'review' ? (_sessionSortDir === 'desc' ? '↓' : '↑') : '↕';
  if (st) st.textContent = _sessionSortCol === 'status' ? (_sessionSortDir === 'desc' ? '↓' : '↑') : '↕';
  if (dt) dt.textContent = _sessionSortCol === 'date'   ? (_sessionSortDir === 'desc' ? '↓' : '↑') : '↕';

  const heading = document.getElementById('sessions-heading');
  if (heading) heading.textContent = `Candidates (${_allSessions.length})`;

  const el = document.getElementById('sessions-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">${_allSessions.length ? 'No candidates match your filter.' : 'No candidates yet. Use the Invite tab to generate a link.'}</div>`;
    return;
  }
  el.innerHTML = list.map((s, i) => renderSessionRow(s, i + 1)).join('');
  // Lazy-load profile photos for candidates who uploaded one
  list.filter(s => s.profilePhotoItemId).forEach(s => loadAvatarPhoto(s.token));
}

function candidateInitials(name) {
  const w = name.trim().split(/\s+/);
  return (w.length >= 2 ? w[0][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase();
}

async function loadAvatarPhoto(token) {
  const el = document.getElementById(`av-${token}`);
  if (!el) return;
  try {
    const data = await apiJSON('GET', `/api/session/${token}/profile-photo`);
    if (data.downloadUrl) {
      el.innerHTML = `<img src="${data.downloadUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    }
  } catch { /* silently skip */ }
}

const DECISION_STYLE = {
  move_forward:       'background:#16a34a;color:#fff',
  not_moving_forward: 'background:#dc2626;color:#fff',
};
const DECISION_LABEL = {
  move_forward:       '✓ Moving Forward',
  not_moving_forward: '✗ Not Moving Forward',
};

function renderSessionRow(s, num) {
  const invitedDate = s.createdAt
    ? new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
  const responseCount = s.responses?.length || 0;

  const avatarContent = s.profilePhotoItemId
    ? `<img src="" style="display:none">` // replaced by loadAvatarPhoto
    : `<span style="font-size:11px;font-weight:700;color:var(--muted)">${candidateInitials(s.candidateName)}</span>`;


  const videosCell = responseCount > 0
    ? `<button class="btn btn-ghost" style="padding:3px 8px;font-size:12px;color:var(--accent);white-space:nowrap" onclick="openReview('${s.token}', '${esc(s.candidateName)}')">🎥 View ${responseCount}</button>`
    : `<span class="text-muted" style="font-size:12px">—</span>`;

  const actionsCell = s.status === 'pending'
    ? `<button class="btn btn-ghost" style="padding:4px 8px;font-size:13px" title="Copy interview link" onclick="copySessionLink('${s.token}')">🔗</button>
       <button class="btn btn-danger" style="padding:4px 10px;font-size:12px" onclick="revokeSession('${s.token}', '${esc(s.candidateName)}')">Revoke</button>`
    : `<button class="btn btn-outline" style="padding:4px 10px;font-size:12px" onclick="openReview('${s.token}', '${esc(s.candidateName)}')">Review</button>`;

  return `
    <div class="session-row">
      <div style="font-size:11px;color:var(--muted);font-weight:600;text-align:center;align-self:center">${num}</div>
      <div style="display:flex;align-items:center;gap:10px;min-width:0">
        <div id="av-${s.token}" class="candidate-avatar">${avatarContent}</div>
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.candidateName)}</div>
          <div class="text-muted" style="font-size:11px;margin-top:1px">${s.candidateEmail ? esc(s.candidateEmail) : ''}</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;justify-content:center">
        ${s.reviewDecision
          ? `<div><span style="font-size:10px;padding:2px 7px;border-radius:10px;${DECISION_STYLE[s.reviewDecision]||''};white-space:nowrap">${DECISION_LABEL[s.reviewDecision]||s.reviewDecision}</span></div>
             ${s.reviewStars ? `<div style="font-size:13px;letter-spacing:0.5px;color:#f59e0b">${'★'.repeat(s.reviewStars)}<span style="color:var(--border)">${'★'.repeat(5-s.reviewStars)}</span></div>` : ''}`
          : `<span class="text-muted" style="font-size:12px">—</span>`}
      </div>
      <div style="display:flex;align-items:center">
        <span style="font-size:12px;color:var(--text-2)">${invitedDate}</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:center">
        <span class="badge badge-${s.status}">${s.status.replace('_', ' ')}</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:center">
        ${videosCell}
      </div>
      <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px">
        ${actionsCell}
      </div>
    </div>
  `;
}

async function generateLink() {
  const name = document.getElementById('new-cand-name').value.trim();
  const email = document.getElementById('new-cand-email').value.trim();
  if (!name) return toast('Candidate name is required', 'error');
  if (!email) return toast('Email is required', 'error');

  try {
    const data = await apiJSON('POST', `/api/interview/${currentInterviewId}/sessions`, {
      candidateName: name,
      candidateEmail: email,
    });
    const link = buildTakeUrl(data.token);
    document.getElementById('generated-link-text').textContent = link;
    document.getElementById('generated-link-box').style.display = 'block';

    const sendBtn = document.getElementById('send-email-btn');
    sendBtn.style.display = 'inline-flex';
    sendBtn.onclick = () => sendLinkEmail(data.token, link, email);

    toast('Link generated!', 'success');
    await loadSessions(currentInterviewId);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function buildTakeUrl(token) {
  const origin = window.location.origin;
  let path = window.location.pathname; // e.g. /j1-dashboard/interview/admin.html
  if (path.includes('admin.html')) {
    path = path.replace('admin.html', 'take.html');
  } else {
    path = path.replace(/\/?$/, '/') + 'take.html';
  }
  return `${origin}${path}?token=${token}`;
}

function copySessionLink(token) {
  navigator.clipboard.writeText(buildTakeUrl(token));
  toast('Link copied!', 'success');
}

function copyLink() {
  navigator.clipboard.writeText(document.getElementById('generated-link-text').textContent);
  toast('Copied!', 'success');
}

async function sendLinkEmail(token, link, email) {
  const btn = document.getElementById('send-email-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await apiJSON('POST', `/api/session/${token}/send-email`, { link });
    toast(`Email sent to ${email}`, 'success');
    resetInviteForm();
    await loadSessions(currentInterviewId);
  } catch (e) {
    toast('Failed to send: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = '✉ Send Email';
  }
}

async function revokeSession(token, name) {
  if (!confirm(`Revoke ${name}'s invitation? Their interview link will stop working immediately.`)) return;
  try {
    await apiJSON('DELETE', `/api/session/${token}`);
    toast('Invitation revoked', 'success');
    await loadSessions(currentInterviewId);
  } catch (e) { toast(e.message, 'error'); }
}

// ── Review videos ─────────────────────────────────────────────

function starsHTML(n, max = 5) {
  return Array.from({ length: max }, (_, i) =>
    `<span style="color:${i < n ? '#f59e0b' : 'var(--border)'}">★</span>`
  ).join('');
}

const LEVEL_COLORS = {
  'Excellent':    '#16a34a',
  'Good':         '#2563eb',
  'Intermediate': '#d97706',
  'Basic':        '#dc2626',
  'Very limited': '#9ca3af',
};

function renderAnalysisPanel(analysis, token) {
  const overall = analysis.overall || {};
  const levelColor = LEVEL_COLORS[overall.level] || 'var(--accent)';
  const ts = analysis.analyzedAt
    ? new Date(analysis.analyzedAt).toLocaleString()
    : '';

  const qCards = (analysis.questions || []).map(q => `
    <div style="border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:6px">
        <div style="font-size:13px;font-weight:600;color:var(--text)">
          Q${q.questionIndex + 1}: ${esc(q.qText || '')}
        </div>
        <div style="flex-shrink:0;font-size:18px;line-height:1">${starsHTML(q.stars)}</div>
      </div>
      <p style="font-size:12px;color:var(--text);margin:0 0 8px">${esc(q.feedback || '')}</p>
      ${q.transcript ? `
        <details style="margin-top:4px">
          <summary style="font-size:11px;color:var(--muted);cursor:pointer;user-select:none">Show transcript</summary>
          <p style="font-size:11px;color:var(--muted);margin:6px 0 0;line-height:1.55;font-style:italic">"${esc(q.transcript)}"</p>
        </details>` : ''}
    </div>
  `).join('');

  return `
    <div id="analysis-panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h3 style="margin:0;font-size:15px">English Analysis</h3>
        <div style="display:flex;gap:8px;align-items:center">
          ${ts ? `<span style="font-size:11px;color:var(--muted)">${ts}</span>` : ''}
          <button class="btn btn-outline" style="padding:4px 12px;font-size:12px"
            onclick="runAnalysis('${token}')">Re-analyze</button>
        </div>
      </div>

      <!-- Overall badge -->
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:16px 20px;margin-bottom:16px;display:flex;gap:20px;align-items:center">
        <div style="text-align:center;flex-shrink:0">
          <div style="font-size:32px;line-height:1">${starsHTML(overall.stars)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px">${overall.stars || '?'} / 5</div>
        </div>
        <div>
          <span style="display:inline-block;background:${levelColor};color:#fff;font-size:11px;font-weight:700;padding:2px 10px;border-radius:20px;margin-bottom:6px">${esc(overall.level || '')}</span>
          <p style="font-size:13px;color:var(--text);margin:0;line-height:1.5">${esc(overall.summary || '')}</p>
        </div>
      </div>

      <!-- Per-question cards -->
      ${qCards}
    </div>`;
}

let _reviewDecision = null;

async function openReview(token, candidateName) {
  document.getElementById('review-candidate-name').textContent = candidateName;
  openModal('modal-review');
  const content = document.getElementById('review-content');
  content.style.cssText = 'flex:1;min-height:0;display:flex';
  content.innerHTML = '<div style="margin:auto" class="spinner"></div>';
  _reviewDecision = null;

  try {
    const [{ session, interview }, cachedAnalysis, resumeData, reviewData] = await Promise.all([
      fetch(`${WORKER_URL}/api/session/${token}`, { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json()),
      fetch(`${WORKER_URL}/api/session/${token}/analysis`,    { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json()).catch(() => ({ notFound: true })),
      fetch(`${WORKER_URL}/api/session/${token}/resume-url`,  { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json()).catch(() => ({ notFound: true })),
      fetch(`${WORKER_URL}/api/session/${token}/review`,      { headers: { 'X-Admin-Key': adminKey } }).then(r => r.json()).catch(() => ({ notFound: true })),
    ]);

    document.getElementById('review-interview-title').textContent = interview?.title || '';

    // ── Load video URLs ──
    const videoItems = session.responses?.length
      ? await Promise.all(session.responses.map(async r => {
          const q = interview?.questions?.[r.questionIndex];
          const { downloadUrl, webUrl } = await fetch(
            `${WORKER_URL}/api/session/${token}/video/${r.questionIndex}`,
            { headers: { 'X-Admin-Key': adminKey } }
          ).then(r => r.json()).catch(() => ({}));
          return { q, downloadUrl, webUrl, questionIndex: r.questionIndex };
        }))
      : [];

    // ── LEFT column: videos (4-column grid) + English analysis ──
    const videosHTML = videoItems.length
      ? `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
          ${videoItems.map(({ q, downloadUrl, webUrl, questionIndex }) => `
            <div style="display:flex;flex-direction:column;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg)">
              ${downloadUrl
                ? `<video src="${downloadUrl}" controls preload="metadata" style="width:100%;aspect-ratio:16/9;background:#000;display:block;flex-shrink:0"></video>`
                : `<div style="aspect-ratio:16/9;background:#111;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px">Unavailable</div>`
              }
              <div style="padding:8px 10px;display:flex;justify-content:space-between;align-items:flex-start;gap:4px">
                <div>
                  <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:2px">Q${questionIndex + 1}</div>
                  <div style="font-size:11px;color:var(--text);line-height:1.4">${q ? esc(q.text) : 'Question ' + (questionIndex + 1)}</div>
                </div>
                ${webUrl ? `<a href="${webUrl}" target="_blank" class="btn btn-ghost" style="font-size:10px;padding:2px 5px;flex-shrink:0">↗</a>` : ''}
              </div>
            </div>`).join('')}
        </div>`
      : `<div class="empty-state">No recordings yet</div>`;

    const analysisSection = cachedAnalysis?.notFound
      ? `<div style="margin-top:8px;text-align:center">
           <button class="btn btn-primary" onclick="runAnalysis('${token}')" id="analyze-btn">🤖 Analyze English Proficiency</button>
           <p class="text-muted text-sm" style="margin-top:6px">~20–40 s · transcribes &amp; rates all answers</p>
         </div>`
      : renderAnalysisPanel(cachedAnalysis, token);

    // ── RIGHT column: resume + review outcome ──
    let resumeSection = '';
    if (resumeData?.downloadUrl) {
      const ext = (resumeData.ext || 'pdf').toLowerCase();
      // OneDrive download URLs serve with Content-Disposition: attachment, which forces
      // download instead of inline display. Route through a viewer service instead.
      const enc = encodeURIComponent(resumeData.downloadUrl);
      const viewerSrc = (ext === 'doc' || ext === 'docx')
        ? `https://view.officeapps.live.com/op/embed.aspx?src=${enc}`
        : `https://docs.google.com/viewer?url=${enc}&embedded=true`;
      resumeSection = `
        <div style="flex:1;min-height:0;display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h3 style="margin:0;font-size:14px">Resume</h3>
            <a href="${resumeData.downloadUrl}" target="_blank" class="btn btn-ghost" style="font-size:11px;padding:2px 8px">Download ↗</a>
          </div>
          <iframe src="${viewerSrc}" style="flex:1;min-height:400px;border:1px solid var(--border);border-radius:8px;width:100%" frameborder="0" allowfullscreen></iframe>
        </div>`;
    } else {
      resumeSection = `<div class="empty-state" style="flex:none">No resume uploaded</div>`;
    }

    // Restore saved decision + stars
    if (reviewData && !reviewData.notFound) {
      _reviewDecision = reviewData.decision;
      _reviewStars    = reviewData.stars || 0;
    } else {
      _reviewStars = 0;
    }

    const decisionFwd = _reviewDecision === 'move_forward';
    const decisionRej = _reviewDecision === 'not_moving_forward';

    const reviewOutcome = `
      <div style="border-top:1px solid var(--border);padding-top:16px;flex-shrink:0">
        <h3 style="margin:0 0 12px;font-size:14px">Review Outcome</h3>
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
          <button id="btn-fwd" onclick="setReviewDecision('move_forward')"
            class="btn" style="font-size:12px;padding:7px 16px;transition:all 0.15s;
            ${decisionFwd ? 'background:#16a34a;color:#fff;border:1px solid #16a34a' : 'background:transparent;border:1px solid transparent;color:var(--muted)'}">
            ✓ Move Forward
          </button>
          <button id="btn-rej" onclick="setReviewDecision('not_moving_forward')"
            class="btn" style="font-size:12px;padding:7px 16px;transition:all 0.15s;
            ${decisionRej ? 'background:#dc2626;color:#fff;border:1px solid #dc2626' : 'background:transparent;border:1px solid transparent;color:var(--muted)'}">
            ✗ Not Moving Forward
          </button>
          <div id="star-picker" style="display:inline-flex;gap:2px;margin-left:6px;align-items:center">
            ${Array.from({length:5}, (_,i) =>
              `<span style="font-size:24px;cursor:pointer;color:${i < _reviewStars ? '#f59e0b' : 'var(--border)'};transition:color 0.1s;line-height:1;padding:0 1px"
                onmouseenter="highlightStars(${i+1})"
                onmouseleave="highlightStars(_reviewStars)"
                onclick="setReviewStars(${i+1})">★</span>`
            ).join('')}
          </div>
        </div>
        <textarea id="review-notes" placeholder="Notes about this candidate…"
          style="width:100%;min-height:90px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 12px;color:var(--text);font-size:13px;resize:vertical;box-sizing:border-box"
        >${reviewData?.notes ? esc(reviewData.notes) : ''}</textarea>
        <div style="margin-top:10px;text-align:right">
          <button class="btn btn-outline" style="padding:8px 20px;font-size:13px" onclick="saveReviewOutcome('${token}')">
            💾 Save Review
          </button>
        </div>
      </div>`;

    content.innerHTML = `
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;border-right:1px solid var(--border)">
        <div style="flex:1;overflow-y:auto;padding:20px 20px 12px">
          <h3 style="margin:0 0 12px;font-size:14px">Recordings</h3>
          ${videosHTML}
        </div>
        <div style="flex-shrink:0;padding:14px 20px;border-top:1px solid var(--border);background:var(--card)">
          ${analysisSection}
        </div>
      </div>
      <div style="flex:1;min-width:0;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px">
        ${resumeSection}
        ${reviewOutcome}
      </div>`;

  } catch (e) {
    content.innerHTML = `<div style="margin:auto;color:var(--red);font-size:13px">${e.message}</div>`;
  }
}

function setReviewDecision(decision) {
  _reviewDecision = decision;
  const fwd = document.getElementById('btn-fwd');
  const rej = document.getElementById('btn-rej');
  if (fwd) fwd.style.cssText = fwd.style.cssText.replace(/background:[^;]+;color:[^;]+;border:[^;]+/, '')
    + (decision === 'move_forward' ? ';background:#16a34a;color:#fff;border:1px solid #16a34a' : ';background:transparent;color:var(--muted);border:1px solid transparent');
  if (rej) rej.style.cssText = rej.style.cssText.replace(/background:[^;]+;color:[^;]+;border:[^;]+/, '')
    + (decision === 'not_moving_forward' ? ';background:#dc2626;color:#fff;border:1px solid #dc2626' : ';background:transparent;color:var(--muted);border:1px solid transparent');
}

async function saveReviewOutcome(token) {
  const notes    = document.getElementById('review-notes')?.value || '';
  const decision = _reviewDecision;
  const stars    = _reviewStars || 0;
  if (!decision) return toast('Please select a decision first', 'error');
  try {
    await apiJSON('POST', `/api/session/${token}/review`, { notes, decision, stars });
    toast('Review saved', 'success');
    closeModal('modal-review');
    // Refresh session list so decision badge + stars show on the card
    if (currentInterviewId) {
      switchSessionTab('candidates');
      await loadSessions(currentInterviewId);
    }
  } catch (e) { toast(e.message, 'error'); }
}

function highlightStars(n) {
  const container = document.getElementById('star-picker');
  if (!container) return;
  container.querySelectorAll('span').forEach((s, i) => {
    s.style.color = i < n ? '#f59e0b' : 'var(--border)';
  });
}

function setReviewStars(n) {
  _reviewStars = n;
  highlightStars(n);
}

async function runAnalysis(token) {
  const panel = document.getElementById('analysis-panel');
  const btn   = document.getElementById('analyze-btn');

  // Show loading state
  const loadingHTML = `
    <div id="analysis-panel" style="text-align:center">
      <div class="spinner" style="margin:0 auto 12px"></div>
      <p class="text-muted text-sm">Transcribing recordings and analyzing English…</p>
      <p class="text-muted" style="font-size:11px">This may take 20–40 seconds</p>
    </div>`;

  if (panel) {
    panel.outerHTML = loadingHTML;
  } else if (btn) {
    btn.closest('div').outerHTML = loadingHTML;
  }

  try {
    const res = await fetch(`${WORKER_URL}/api/session/${token}/analyze`, {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const newPanel = document.getElementById('analysis-panel');
    if (newPanel) newPanel.outerHTML = renderAnalysisPanel(data, token);
  } catch (e) {
    const newPanel = document.getElementById('analysis-panel');
    if (newPanel) newPanel.outerHTML = `
      <div id="analysis-panel">
        <p style="color:var(--red);font-size:13px">Analysis failed: ${esc(e.message)}</p>
        <button class="btn btn-outline" style="font-size:12px;padding:4px 12px"
          onclick="runAnalysis('${token}')">Try again</button>
      </div>`;
  }
}

// ── Edit interview ────────────────────────────────────────────

async function openEditInterview(id) {
  editInterviewId = id;
  try {
    const interview = await apiJSON('GET', `/api/interview/${id}`);
    document.getElementById('edit-title').value = interview.title;
    document.getElementById('edit-desc').value = interview.description || '';
    editQuestions = interview.questions.map(q => ({ ...q }));
    renderEditQuestions();
    openModal('modal-edit');
  } catch (e) { toast(e.message, 'error'); }
}

function addEditQuestion() {
  editQuestions.push({ text: '', duration: 120 });
  renderEditQuestions();
}

function removeEditQuestion(i) {
  if (editQuestions.length === 1) return toast('Need at least one question', 'error');
  editQuestions.splice(i, 1);
  renderEditQuestions();
}

function moveEditQuestion(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= editQuestions.length) return;
  [editQuestions[i], editQuestions[j]] = [editQuestions[j], editQuestions[i]];
  renderEditQuestions();
}

function renderEditQuestions() {
  const builder = document.getElementById('edit-questions-builder');
  builder.innerHTML = editQuestions.map((q, i) => `
    <div class="question-item">
      <div class="q-num">${i + 1}</div>
      <div class="q-fields">
        <input type="text" placeholder="Question text *" value="${esc(q.text)}"
          oninput="editQuestions[${i}].text = this.value" />
        <select onchange="editQuestions[${i}].duration = parseInt(this.value)">
          ${[30, 60, 90, 120, 180, 240, 300].map(s =>
            `<option value="${s}" ${q.duration === s ? 'selected' : ''}>${s}s (${s < 60 ? s + 's' : (s/60) + ' min'})</option>`
          ).join('')}
        </select>
      </div>
      <button class="btn btn-ghost" onclick="moveEditQuestion(${i}, -1)" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn btn-ghost" onclick="removeEditQuestion(${i})" style="color:var(--red)">✕</button>
    </div>
  `).join('');
}

async function submitEditInterview() {
  const title = document.getElementById('edit-title').value.trim();
  const description = document.getElementById('edit-desc').value.trim();
  if (!title) return toast('Title is required', 'error');
  if (editQuestions.some(q => !q.text.trim())) return toast('All questions need text', 'error');
  try {
    await apiJSON('PUT', `/api/interview/${editInterviewId}`, { title, description, questions: editQuestions });
    toast('Interview updated!', 'success');
    closeModal('modal-edit');
    loadInterviews();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Modals ────────────────────────────────────────────────────

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
});

// ── Toast ─────────────────────────────────────────────────────

let toastTimer;
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Utils ─────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Interview Script ──────────────────────────────────────────

let _currentScriptClientId = null;
let _addClientLogoFile = null;
let _cropper = null;
let _cropCallback = null;

// ── Level 1: Client list ──────────────────────────────────────

async function renderScriptPage() {
  _currentScriptClientId = null;
  const main = document.getElementById('admin-main');
  main.innerHTML = `
    <div style="max-width:720px">
      <div class="flex justify-between items-center mb-16">
        <h2>Interview Scripts</h2>
        <button class="btn btn-primary" onclick="promptAddClient()">+ Add Client</button>
      </div>
      <div id="script-clients-list"><div class="empty-state">Loading…</div></div>
    </div>
  `;
  await loadScriptClientsList();
}

async function loadScriptClientsList() {
  const el = document.getElementById('script-clients-list');
  if (!el) return;
  try {
    _scriptClients = await apiJSON('GET', '/api/script/clients');
    if (!_scriptClients.length) {
      el.innerHTML = `<div class="empty-state">No clients yet. Click "+ Add Client" to get started.</div>`;
      return;
    }
    el.innerHTML = `
      <div class="card" style="padding:0;overflow:hidden">
        ${_scriptClients.map((c, i) => {
          const initials = c.name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
          return `
          <div style="display:flex;align-items:center;gap:12px;padding:12px 20px;cursor:pointer;${i < _scriptClients.length - 1 ? 'border-bottom:1px solid var(--border)' : ''};transition:background 0.12s"
            onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background=''"
            onclick="openScriptClient('${c.id}')">
            <div id="cl-av-${c.id}" style="width:44px;height:44px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;font-size:13px;font-weight:700;color:#fff">${initials}</div>
            <div style="flex:1;font-size:14px;font-weight:600">${esc(c.name)}</div>
            <span style="color:var(--muted);font-size:20px;line-height:1;font-weight:300">›</span>
          </div>`;
        }).join('')}
      </div>
    `;
    // Lazy-load logos for clients that have one
    _scriptClients.filter(c => c.logoItemId).forEach(c => loadClientLogoAvatar(c.id, `cl-av-${c.id}`));
  } catch (e) {
    if (el) el.innerHTML = `<div class="empty-state" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

async function loadClientLogoAvatar(clientId, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  try {
    const data = await apiJSON('GET', `/api/script/client/${clientId}/logo-url`);
    if (data.downloadUrl) {
      el.style.background = '#fff';
      el.innerHTML = `<img src="${data.downloadUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block">`;
    }
  } catch { /* silently skip */ }
}

function updateClientLogo(clientId, input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  openCropModal(file, async blob => {
    const avEl = document.getElementById(`sc-hdr-av-${clientId}`);
    if (avEl) avEl.style.opacity = '0.4';
    try {
      const croppedFile = new File([blob], 'logo.jpg', { type: 'image/jpeg' });
      const form = new FormData();
      form.append('file', croppedFile);
      const res = await fetch(`${WORKER_URL}/api/script/client/${clientId}/upload-logo`, {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      toast('Logo updated', 'success');
      const c = _scriptClients.find(c => c.id === clientId);
      if (c) c.logoItemId = 'updated';
      if (avEl) {
        avEl.style.opacity = '1';
        avEl.style.background = 'transparent';
        avEl.innerHTML = `<img src="${URL.createObjectURL(blob)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block">`;
      }
    } catch (e) {
      toast(e.message, 'error');
      if (avEl) avEl.style.opacity = '1';
    }
  });
}

// ── Level 2: Positions inside a client ───────────────────────

async function openScriptClient(clientId) {
  _currentScriptClientId = clientId;
  const client = _scriptClients.find(c => c.id === clientId);
  const initials = (client?.name || '').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const main = document.getElementById('admin-main');
  main.innerHTML = `
    <div style="max-width:720px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
        <button class="btn btn-ghost" style="padding:5px 12px;font-size:13px" onclick="renderScriptPage()">← Interview Scripts</button>
        <span style="color:var(--muted);font-size:14px">›</span>
        <div style="position:relative;flex-shrink:0;width:44px;height:44px;cursor:pointer" title="Click to update logo"
          onclick="document.getElementById('hdr-logo-inp-${clientId}').click()"
          onmouseenter="document.getElementById('sc-hdr-ov-${clientId}').style.opacity='1'"
          onmouseleave="document.getElementById('sc-hdr-ov-${clientId}').style.opacity='0'">
          <div id="sc-hdr-av-${clientId}" style="width:44px;height:44px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:13px;font-weight:700;color:#fff">${initials}</div>
          <div id="sc-hdr-ov-${clientId}" style="position:absolute;inset:0;border-radius:50%;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.15s;pointer-events:none;font-size:15px">📷</div>
          <input type="file" id="hdr-logo-inp-${clientId}" accept="image/*" style="display:none"
            onchange="updateClientLogo('${clientId}', this)">
        </div>
        <span style="font-size:15px;font-weight:700">${esc(client?.name || '')}</span>
      </div>
      <div class="flex justify-between items-center mb-16">
        <h3 style="margin:0">Positions</h3>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-outline" onclick="promptAddPosition('${clientId}')">+ Add Position</button>
          <button class="btn btn-ghost" style="font-size:16px;padding:4px 10px" title="Delete this client"
            onclick="deleteScriptClient('${clientId}','${esc(client?.name || '').replace(/'/g, "\\'")}')">🗑</button>
        </div>
      </div>
      <div id="sc-positions-${clientId}"><div class="empty-state">Loading…</div></div>
    </div>
  `;
  if (client?.logoItemId) loadClientLogoAvatar(clientId, `sc-hdr-av-${clientId}`);
  await loadClientPositions(clientId);
}

async function loadClientPositions(clientId) {
  const el = document.getElementById(`sc-positions-${clientId}`);
  if (!el) return;
  try {
    const positions = await apiJSON('GET', `/api/script/client/${clientId}/positions`);
    if (!positions.length) {
      el.innerHTML = `<div class="empty-state">No positions yet. Click "+ Add Position" to add one.</div>`;
      return;
    }
    el.innerHTML = `<div class="card" style="padding:0;overflow:hidden">
      ${positions.map((p, i) => renderScriptPositionRow(p, i, positions.length)).join('')}
    </div>`;
  } catch (e) {
    if (el) el.innerHTML = `<div class="empty-state" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

function renderScriptPositionRow(p, idx, total) {
  const hasDoc = !!p.driveItemId;
  const uploadedDate = p.uploadedAt
    ? new Date(p.uploadedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;
  const notLast = idx < total - 1;
  return `
    <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;${notLast ? 'border-bottom:1px solid var(--border)' : ''}">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600">${esc(p.name)}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">
          ${hasDoc
            ? `📄 ${esc(p.fileName || 'Document')}${uploadedDate ? ' · ' + uploadedDate : ''}`
            : 'No document uploaded'}
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;align-items:center">
        ${hasDoc
          ? `<button class="btn btn-outline" style="font-size:12px;padding:4px 12px"
               onclick="viewScriptDoc('${p.id}','${esc(p.fileName || 'document')}')">View</button>
             <button class="btn btn-ghost" style="font-size:13px;padding:4px 10px" title="Download"
               onclick="downloadScriptDoc('${p.id}')">↓</button>`
          : ''}
        <label class="btn btn-outline" style="font-size:12px;padding:4px 14px;cursor:pointer;font-weight:600">
          ${hasDoc ? 'Replace' : 'Upload'}
          <input type="file" accept=".pdf,.doc,.docx" style="display:none"
            onchange="uploadScriptDoc('${p.id}', this)">
        </label>
        <button class="btn btn-ghost" style="font-size:16px;padding:4px 8px" title="Delete position"
          onclick="deleteScriptPosition('${p.id}','${esc(p.name).replace(/'/g, "\\'")}','${p.clientId}')">🗑</button>
      </div>
    </div>
  `;
}

// ── Script CRUD actions ───────────────────────────────────────

function promptAddClient() {
  _addClientLogoFile = null;
  document.getElementById('new-client-name').value = '';
  document.getElementById('client-logo-preview').innerHTML = '<span style="font-size:26px">🏢</span>';
  const inp = document.getElementById('client-logo-input');
  if (inp) inp.value = '';
  const btn = document.getElementById('add-client-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Add Client'; }
  openModal('modal-add-client');
  setTimeout(() => document.getElementById('new-client-name')?.focus(), 80);
}

function previewClientLogo(input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  openCropModal(file, blob => {
    _addClientLogoFile = new File([blob], 'logo.jpg', { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    document.getElementById('client-logo-preview').innerHTML =
      `<img src="${url}" style="width:100%;height:100%;object-fit:cover">`;
  });
}

// ── Logo crop helpers ─────────────────────────────────────────

function openCropModal(file, onApply) {
  _cropCallback = onApply;
  const reader = new FileReader();
  reader.onload = e => {
    const img = document.getElementById('crop-img');
    img.src = e.target.result;
    const btn = document.getElementById('apply-crop-btn');
    if (btn) { btn.disabled = false; btn.textContent = '✓ Apply'; }
    openModal('modal-crop-logo');
    setTimeout(() => {
      if (_cropper) { _cropper.destroy(); _cropper = null; }
      _cropper = new Cropper(img, {
        aspectRatio: 1,
        viewMode: 1,
        dragMode: 'move',
        guides: false,
        center: false,
        highlight: false,
        background: true,
        autoCropArea: 0.85,
        responsive: true,
      });
    }, 150);
  };
  reader.readAsDataURL(file);
}

function closeCropModal() {
  if (_cropper) { _cropper.destroy(); _cropper = null; }
  _cropCallback = null;
  closeModal('modal-crop-logo');
}

function applyCrop() {
  if (!_cropper || !_cropCallback) return;
  const btn = document.getElementById('apply-crop-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
  _cropper.getCroppedCanvas({ width: 320, height: 320 }).toBlob(blob => {
    const cb = _cropCallback;
    closeCropModal();
    cb(blob);
  }, 'image/jpeg', 0.92);
}

async function submitAddClient() {
  const name = document.getElementById('new-client-name').value.trim();
  if (!name) return toast('Client name is required', 'error');
  const btn = document.getElementById('add-client-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  try {
    const client = await apiJSON('POST', '/api/script/clients', { name });
    if (_addClientLogoFile) {
      try {
        const form = new FormData();
        form.append('file', _addClientLogoFile);
        const res = await fetch(`${WORKER_URL}/api/script/client/${client.id}/upload-logo`, {
          method: 'POST',
          headers: { 'X-Admin-Key': adminKey },
          body: form,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Logo upload failed');
      } catch (e) {
        toast('Client added but logo failed: ' + e.message, 'error');
      }
    }
    toast('Client added', 'success');
    closeModal('modal-add-client');
    await loadScriptClientsList();
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Add Client'; }
  }
}

async function deleteScriptClient(id, name) {
  if (!confirm(`Delete client "${name}"?\n\nThis will also delete all its positions and uploaded documents.`)) return;
  try {
    await apiJSON('DELETE', `/api/script/client/${id}`);
    toast('Client deleted', 'success');
    renderScriptPage();
  } catch (e) { toast(e.message, 'error'); }
}

async function promptAddPosition(clientId) {
  const name = prompt('Enter position / role name:');
  if (!name?.trim()) return;
  try {
    await apiJSON('POST', `/api/script/client/${clientId}/positions`, { name: name.trim() });
    toast('Position added', 'success');
    await loadClientPositions(clientId);
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteScriptPosition(id, name, clientId) {
  if (!confirm(`Delete position "${name}"?`)) return;
  try {
    await apiJSON('DELETE', `/api/script/position/${id}`);
    toast('Position deleted', 'success');
    await loadClientPositions(clientId);
  } catch (e) { toast(e.message, 'error'); }
}

async function uploadScriptDoc(positionId, input) {
  const file = input.files?.[0];
  if (!file) return;
  const label = input.closest('label');
  const origText = label?.textContent?.trim();
  if (label) { label.textContent = 'Uploading…'; label.style.pointerEvents = 'none'; label.style.opacity = '0.6'; }
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${WORKER_URL}/api/script/position/${positionId}/upload`, {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    toast('Document uploaded', 'success');
    if (_currentScriptClientId) await loadClientPositions(_currentScriptClientId);
  } catch (e) {
    toast(e.message, 'error');
    if (label) { label.textContent = origText || 'Upload'; label.style.pointerEvents = ''; label.style.opacity = ''; }
  }
}

async function viewScriptDoc(positionId, fileName) {
  try {
    const data = await apiJSON('GET', `/api/script/position/${positionId}/doc-url`);
    if (!data.downloadUrl) return toast('Document not available', 'error');
    const ext = (data.ext || fileName.split('.').pop() || 'pdf').toLowerCase();
    const enc = encodeURIComponent(data.downloadUrl);
    const viewerSrc = (ext === 'doc' || ext === 'docx')
      ? `https://view.officeapps.live.com/op/embed.aspx?src=${enc}`
      : `https://docs.google.com/viewer?url=${enc}&embedded=true`;
    window.open(viewerSrc, '_blank');
  } catch (e) { toast(e.message, 'error'); }
}

async function downloadScriptDoc(positionId) {
  try {
    const data = await apiJSON('GET', `/api/script/position/${positionId}/doc-url`);
    if (!data.downloadUrl) return toast('Document not available', 'error');
    window.open(data.downloadUrl, '_blank');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Booking Interview ─────────────────────────────────────────

let _bookingLinks = [];
let _editingSlotRules = [];
let _editingBookingToken = null;
let _inviteBookingToken = null;
let _biBulkRows = [], _biBulkHeaders = [], _biBulkNameCol = null, _biBulkEmailCol = null;

const BOOKING_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const BOOKING_DURATIONS = [15, 30, 45, 60, 90];
const BOOKING_DAYS_AHEAD = [7, 14, 21, 30, 60];
const BOOKING_MIN_NOTICE = [
  { value:  3, label: '3 Hours' },
  { value:  6, label: '6 Hours' },
  { value: 12, label: '12 Hours' },
  { value: 24, label: '24 Hours' },
  { value: 48, label: '48 Hours' },
];

async function renderBookingPage() {
  const main = document.getElementById('admin-main');
  main.innerHTML = `
    <div style="max-width:820px">
      <div class="flex justify-between items-center mb-16">
        <h2>Booking Interview</h2>
        <button class="btn btn-primary" onclick="gotoPage('booking-create')">+ New Booking Link</button>
      </div>
      <div id="booking-links-list"><div class="empty-state">Loading…</div></div>
    </div>
  `;
  await loadBookingLinks();
}

async function loadBookingLinks() {
  const el = document.getElementById('booking-links-list');
  if (!el) return;
  try {
    _bookingLinks = await apiJSON('GET', '/api/booking/links');
    if (!_bookingLinks.length) {
      el.innerHTML = `<div class="empty-state">No booking links yet. Click "+ New Booking Link" to create one.</div>`;
      return;
    }
    el.innerHTML = _bookingLinks.map(renderBookingLinkCard).join('');
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

function buildBookUrl(token) {
  const origin = window.location.origin;
  let path = window.location.pathname;
  if (path.includes('admin.html')) path = path.replace('admin.html', 'book.html');
  else path = path.replace(/\/?$/, '/') + 'book.html';
  return `${origin}${path}?t=${token}`;
}

function renderBookingLinkCard(link) {
  const created = new Date(link.createdAt).toLocaleDateString();
  const bookUrl = buildBookUrl(link.token);
  const activeStyle = link.active
    ? 'background:rgba(22,163,74,0.12);color:#16a34a'
    : 'background:rgba(148,163,184,0.12);color:var(--muted)';
  const activeDot = link.active ? '●' : '○';
  const daysLabel = BOOKING_DAYS.filter((_, i) => link.slotRules?.some(r => r.day === i)).join(', ') || '—';
  const tzLabel = formatTzOffset(link.tzOffset || 0);
  const noticeOpt   = BOOKING_MIN_NOTICE.find(o => o.value === (link.minNoticeHours ?? 24));
  const noticeLabel = noticeOpt ? noticeOpt.label : `${link.minNoticeHours ?? 24}h`;

  return `
    <div class="card" style="margin-bottom:10px">
      <div class="flex justify-between gap-12" style="align-items:stretch">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
            <span style="font-size:15px;font-weight:700">${esc(link.title)}</span>
            <span style="font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;${activeStyle}">${activeDot} ${link.active ? 'Active' : 'Inactive'}</span>
          </div>
          <div class="text-muted text-sm" style="margin-bottom:6px">
            ${link.clientName ? `<span>${esc(link.clientName)}</span> · ` : ''}
            ${link.position ? `<span>${esc(link.position)}</span> · ` : ''}
            <span>🟦 Microsoft Teams</span> · <span>${link.duration || 30} min</span>
          </div>
          <div style="font-size:11px;color:var(--muted)">
            Available: ${daysLabel} &nbsp;·&nbsp; ${tzLabel} &nbsp;·&nbsp; ${link.daysAhead || 14} days ahead
            &nbsp;·&nbsp; <span title="Minimum scheduling notice" style="color:#f59e0b">⏱ ${noticeLabel} notice</span>
            &nbsp;·&nbsp; Created ${created}
          </div>
          <div style="margin-top:8px;display:flex;align-items:center;gap:6px">
            <input type="text" value="${esc(bookUrl)}" readonly
              style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:5px 10px;color:var(--muted);font-size:11px;cursor:text"
              onclick="this.select()" />
            <button class="btn btn-ghost" style="padding:4px 10px;font-size:12px;flex-shrink:0"
              onclick="navigator.clipboard.writeText('${esc(bookUrl)}');toast('Link copied!','success')">Copy</button>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;align-items:flex-end">
          <button class="btn btn-outline" style="font-size:12px;padding:4px 14px;width:100%;text-align:center"
            onclick="viewLinkBookings('${link.token}')">View Bookings</button>
          <button class="btn btn-primary" style="font-size:12px;padding:4px 14px;width:100%;text-align:center"
            onclick="openBookingInviteModal('${link.token}')">Invite to Book</button>
          <div style="display:flex;flex-direction:row;gap:4px;justify-content:flex-end;margin-top:auto">
            <button class="btn btn-ghost" style="padding:4px 8px;font-size:15px" title="Edit"
              onclick="editBookingLink('${link.token}')"><span style="display:inline-block;transform:rotate(45deg)">✏</span></button>
            <button class="btn btn-ghost" style="padding:2px 4px;background:transparent;border:none" title="${link.active ? 'Deactivate' : 'Activate'}"
              onclick="toggleBookingLink('${link.token}',${!link.active})">
              ${link.active
                ? `<span style="display:inline-flex;align-items:center;background:#16a34a;border-radius:20px;padding:2px;width:38px;height:22px;justify-content:flex-end">
                     <span style="width:18px;height:18px;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;color:#16a34a;font-weight:700;line-height:1">✓</span>
                   </span>`
                : `<span style="display:inline-flex;align-items:center;background:#ef4444;border-radius:20px;padding:2px;width:38px;height:22px;justify-content:flex-start">
                     <span style="width:18px;height:18px;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;color:#ef4444;font-weight:700;line-height:1">✕</span>
                   </span>`}
            </button>
            <button class="btn btn-ghost" style="padding:4px 8px;font-size:15px" title="Delete link"
              onclick="deleteBookingLink('${link.token}','${esc(link.title).replace(/'/g,"\\'")}')">🗑</button>
          </div>
        </div>
      </div>
      <div id="bookings-detail-${link.token}" style="display:none;margin-top:14px;border-top:1px solid var(--border);padding-top:14px"></div>
    </div>
  `;
}

function formatTzOffset(offsetMin) {
  if (offsetMin === 0) return 'UTC';
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2,'0') : ''}`;
}

async function toggleBookingLink(token, active) {
  try {
    await apiJSON('PUT', `/api/booking/link/${token}`, { active });
    toast(active ? 'Link activated' : 'Link deactivated', 'success');
    await loadBookingLinks();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteBookingLink(token, title) {
  if (!confirm(`Delete booking link "${title}"?\n\nAll existing bookings for this link will also be deleted.`)) return;
  try {
    await apiJSON('DELETE', `/api/booking/link/${token}`);
    toast('Booking link deleted', 'success');
    await loadBookingLinks();
  } catch (e) { toast(e.message, 'error'); }
}

async function viewLinkBookings(token) {
  const el = document.getElementById(`bookings-detail-${token}`);
  if (!el) return;
  if (el.style.display === 'block') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = '<div class="empty-state">Loading bookings…</div>';
  try {
    const bookings = await apiJSON('GET', `/api/booking/link/${token}/bookings`);
    if (!bookings.length) {
      el.innerHTML = `<div class="empty-state" style="font-size:13px">No bookings yet for this link.</div>`;
      return;
    }
    bookings.sort((a, b) => a.slotStart - b.slotStart); // earliest first
    el.innerHTML = `
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:10px">
        Bookings (${bookings.length})
      </div>
      <div style="display:grid;gap:8px">
        ${bookings.map(b => {
          const dt = new Date(b.slotStart);
          const dateStr = dt.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric', year:'numeric' });
          const timeStr = dt.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
          const endStr  = new Date(b.slotEnd).toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
          const statusStyle = b.status === 'confirmed'
            ? 'background:rgba(22,163,74,0.12);color:#16a34a'
            : 'background:rgba(239,68,68,0.12);color:var(--red)';
          return `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--bg);border-radius:8px;border:1px solid var(--border)">
              <div style="flex:1">
                <div style="font-size:13px;font-weight:600">${esc(b.candidateName)}</div>
                <div style="font-size:11px;color:var(--muted)">${esc(b.candidateEmail)}</div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:12px;font-weight:600">${dateStr}</div>
                <div style="font-size:11px;color:var(--muted)">${timeStr} – ${endStr}</div>
              </div>
              <span style="font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;${statusStyle}">${b.status}</span>
              ${b.meetingLink
                ? `<a href="${esc(b.meetingLink)}" target="_blank" class="btn btn-outline" style="font-size:11px;padding:3px 12px;color:#6264a7;border-color:#6264a7;white-space:nowrap;flex-shrink:0">🟦 Join</a>`
                : ''}
              <button class="btn btn-ghost" style="font-size:14px;padding:3px 8px;flex-shrink:0" title="Cancel booking"
                onclick="cancelAdminBooking('${b.id}','${token}','${esc(b.candidateName).replace(/'/g,"\\'")}')">🗑</button>
            </div>`;
        }).join('')}
      </div>
    `;
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

async function cancelAdminBooking(bookingId, linkToken, name) {
  if (!confirm(`Cancel booking for ${name}?\nA cancellation email will be sent to the candidate.`)) return;
  try {
    const data = await apiJSON('DELETE', `/api/booking/booking/${bookingId}`);
    if (data.emailSent) {
      toast('Booking cancelled & candidate notified', 'success');
    } else {
      toast('Booking cancelled (email failed — check EMAIL_SENDER secret in Cloudflare)', 'warning');
    }
    await viewLinkBookings(linkToken);
  } catch (e) { toast(e.message, 'error'); }
}

// ── Create Booking Link page ──────────────────────────────────

function renderCreateBookingLinkPage() {
  // Default slot rules: Mon–Fri 9am–5pm
  _editingSlotRules = [1,2,3,4,5].map(d => ({ day: d, from: '09:00', to: '17:00' }));
  // Auto-detect browser timezone offset
  const tzOffset = -new Date().getTimezoneOffset();

  const main = document.getElementById('admin-main');
  main.innerHTML = `
    <div style="max-width:700px">
      <h2 class="mb-16">New Booking Link</h2>
      <div class="card">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div class="form-group" style="margin-bottom:0;grid-column:1/-1">
            <label>Link Title *</label>
            <input type="text" id="bl-title" placeholder="e.g. Initial Screening – P&O Cruises" autocomplete="off" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Client Name</label>
            <input type="text" id="bl-client" placeholder="e.g. P&O Cruises" autocomplete="off" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Position / Role</label>
            <input type="text" id="bl-position" placeholder="e.g. Waiter" autocomplete="off" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Slot Duration</label>
            <select id="bl-duration">
              ${BOOKING_DURATIONS.map(d => `<option value="${d}" ${d===30?'selected':''}>${d} minutes</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Timezone Offset</label>
            <select id="bl-tz">
              ${[-720,-660,-600,-570,-540,-480,-420,-360,-300,-240,-210,-180,-120,-60,0,60,120,180,210,240,270,300,330,345,360,390,420,480,510,525,540,570,600,630,660,720].map(o => {
                const selected = o === tzOffset ? 'selected' : '';
                return `<option value="${o}" ${selected}>${formatTzOffset(o)}</option>`;
              }).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Days Available Ahead</label>
            <select id="bl-days-ahead">
              ${BOOKING_DAYS_AHEAD.map(d => `<option value="${d}" ${d===14?'selected':''}>${d} days</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Scheduling Notice</label>
            <select id="bl-min-notice">
              ${BOOKING_MIN_NOTICE.map(o => `<option value="${o.value}" ${o.value===24?'selected':''}>${o.label}</option>`).join('')}
            </select>
          </div>
        </div>

        <hr class="divider" />
        <h3 style="margin-bottom:14px">Weekly Availability</h3>
        <div id="slot-rules-editor" style="display:grid;gap:8px">
          ${renderSlotRulesEditor()}
        </div>

        <div class="flex gap-8 items-center" style="margin-top:24px">
          <button class="btn btn-primary" id="bl-submit-btn" onclick="submitCreateBookingLink()">Create Booking Link</button>
          <button class="btn btn-outline" onclick="gotoPage('booking')">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function renderSlotRulesEditor() {
  return BOOKING_DAYS.map((dayName, dayIdx) => {
    const rules   = _editingSlotRules.filter(r => r.day === dayIdx);
    const enabled = rules.length > 0;
    return `
      <div style="padding:12px 14px;background:var(--bg);border-radius:8px;border:1px solid ${enabled ? 'var(--accent)' : 'var(--border)'}">
        <div style="display:flex;align-items:center;gap:10px;${enabled ? 'margin-bottom:10px' : ''}">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;min-width:60px">
            <input type="checkbox" ${enabled ? 'checked' : ''}
              onchange="toggleSlotDay(${dayIdx},this.checked)"
              style="accent-color:var(--accent);width:15px;height:15px;cursor:pointer" />
            <span style="font-size:13px;font-weight:600;${enabled ? '' : 'color:var(--muted)'}">${dayName}</span>
          </label>
          ${enabled ? `
            <div style="display:flex;gap:6px;margin-left:auto">
              <button type="button" class="btn btn-ghost" style="font-size:11px;padding:2px 10px;color:var(--muted)" onclick="applyRangesToAllDays(${dayIdx})" title="Copy this day's schedule to all enabled days">Apply to all</button>
              <button type="button" class="btn btn-ghost" style="font-size:11px;padding:2px 10px;color:var(--accent)" onclick="addDayRange(${dayIdx})">+ Add range</button>
            </div>` : ''}
        </div>
        ${enabled ? rules.map((rule, rIdx) => `
          <div style="display:flex;align-items:center;gap:8px;${rIdx > 0 ? 'margin-top:8px' : ''}">
            <input type="time" value="${rule.from}" onchange="updateSlotRange(${dayIdx},${rIdx},'from',this.value)"
              style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:5px 8px;color:var(--text);font-size:13px" />
            <span style="color:var(--muted);font-size:13px">to</span>
            <input type="time" value="${rule.to}" onchange="updateSlotRange(${dayIdx},${rIdx},'to',this.value)"
              style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:5px 8px;color:var(--text);font-size:13px" />
            ${rules.length > 1 ? `<button type="button" class="btn btn-ghost" style="font-size:16px;padding:2px 8px;color:var(--muted)" onclick="removeDayRange(${dayIdx},${rIdx})" title="Remove this range">×</button>` : ''}
          </div>
        `).join('') : ''}
      </div>
    `;
  }).join('');
}

function toggleSlotDay(dayIdx, enabled) {
  _editingSlotRules = _editingSlotRules.filter(r => r.day !== dayIdx);
  if (enabled) _editingSlotRules.push({ day: dayIdx, from: '09:00', to: '17:00' });
  document.getElementById('slot-rules-editor').innerHTML = renderSlotRulesEditor();
}

function addDayRange(dayIdx) {
  // Default the new range to start where the last range ends (or 13:00–17:00)
  const existing = _editingSlotRules.filter(r => r.day === dayIdx);
  const lastTo   = existing.length ? existing[existing.length - 1].to : '12:00';
  _editingSlotRules.push({ day: dayIdx, from: lastTo, to: '17:00' });
  document.getElementById('slot-rules-editor').innerHTML = renderSlotRulesEditor();
}

function removeDayRange(dayIdx, rangeIdx) {
  const dayRules = _editingSlotRules.filter(r => r.day === dayIdx);
  if (dayRules.length <= 1) return;
  const target    = dayRules[rangeIdx];
  const globalIdx = _editingSlotRules.indexOf(target);
  if (globalIdx !== -1) _editingSlotRules.splice(globalIdx, 1);
  document.getElementById('slot-rules-editor').innerHTML = renderSlotRulesEditor();
}

function updateSlotRange(dayIdx, rangeIdx, field, value) {
  const dayRules = _editingSlotRules.filter(r => r.day === dayIdx);
  if (dayRules[rangeIdx]) dayRules[rangeIdx][field] = value;
}

function applyRangesToAllDays(sourceDayIdx) {
  const sourceRanges = _editingSlotRules
    .filter(r => r.day === sourceDayIdx)
    .map(r => ({ from: r.from, to: r.to })); // copy only the times

  const enabledDays = [...new Set(_editingSlotRules.map(r => r.day))];

  // Replace all enabled days' ranges with the source day's ranges
  _editingSlotRules = _editingSlotRules.filter(r => !enabledDays.includes(r.day));
  for (const day of enabledDays) {
    for (const range of sourceRanges) {
      _editingSlotRules.push({ day, from: range.from, to: range.to });
    }
  }

  document.getElementById('slot-rules-editor').innerHTML = renderSlotRulesEditor();
  toast(`Applied ${BOOKING_DAYS[sourceDayIdx]}'s schedule to all ${enabledDays.length} enabled days`, 'success');
}

// ── Holiday & Closure Settings ────────────────────────────────

let _holidays        = [];
let _holidaySettings = {};

const COUNTRY_OPTIONS = [
  ['ID','Indonesia'],['US','United States'],['AU','Australia'],
  ['GB','United Kingdom'],['SG','Singapore'],['MY','Malaysia'],
  ['PH','Philippines'],['JP','Japan'],['CN','China'],['IN','India'],
];

async function renderHolidaysPage() {
  const main = document.getElementById('admin-main');
  main.innerHTML = `
    <div style="max-width:860px">
      <h2 class="mb-16">Holiday &amp; Closure Settings</h2>
      <div id="holidays-page-content"><div class="spinner" style="margin:60px auto"></div></div>
    </div>
  `;
  try {
    const [settings, holidays] = await Promise.all([
      apiJSON('GET', '/api/holidays/settings').catch(() => ({})),
      apiJSON('GET', '/api/holidays').catch(() => []),
    ]);
    _holidaySettings = settings;
    _holidays = holidays;
    renderHolidaysContent();
  } catch (e) {
    document.getElementById('holidays-page-content').innerHTML =
      `<div class="empty-state" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

function renderHolidaysContent() {
  const el = document.getElementById('holidays-page-content');
  if (!el) return;

  const s          = _holidaySettings;
  const autoBlock  = s.autoBlockNational !== false; // default ON
  const country    = s.country || 'ID';
  const syncedYears = (s.syncedYears || []).sort();
  const curYear    = new Date().getFullYear();

  const national = _holidays.filter(h => h.type === 'national').sort((a,b) => a.date.localeCompare(b.date));
  const custom   = _holidays.filter(h => h.type === 'custom').sort((a,b) => a.date.localeCompare(b.date));

  el.innerHTML = `

    <!-- ── Global Settings ────────────────────────────────── -->
    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:16px">Global Settings</h3>

      <!-- Auto-block toggle -->
      <div style="display:flex;align-items:flex-start;gap:14px;padding:14px 16px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:16px;cursor:pointer"
        onclick="document.getElementById('auto-block-cb').click()">
        <input type="checkbox" id="auto-block-cb" ${autoBlock ? 'checked' : ''}
          style="accent-color:var(--accent);width:18px;height:18px;flex-shrink:0;margin-top:2px;cursor:pointer"
          onclick="event.stopPropagation()"
          onchange="saveHolidaySettings({autoBlockNational:this.checked})" />
        <div style="flex:1">
          <div style="font-size:14px;font-weight:600">Automatically block bookings on all active holidays</div>
          <div style="font-size:12px;color:var(--muted);margin-top:3px;line-height:1.5">
            When enabled, all candidate-facing booking slots are <strong style="color:var(--text)">wiped for the entire day</strong>
            on any active holiday — no manual calendar changes needed.
          </div>
        </div>
        <span style="font-size:24px;margin-top:-2px;flex-shrink:0">${autoBlock ? '🛡️' : '⚠️'}</span>
      </div>

      <!-- Sync row -->
      <div style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap">
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);display:block;margin-bottom:5px">Country</label>
          <select id="sync-country"
            style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:7px 12px;color:var(--text);font-size:13px">
            ${COUNTRY_OPTIONS.map(([code, name]) =>
              `<option value="${code}" ${code === country ? 'selected' : ''}>${name} (${code})</option>`
            ).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);display:block;margin-bottom:5px">Year</label>
          <select id="sync-year"
            style="background:var(--card);border:1px solid var(--border);border-radius:6px;padding:7px 12px;color:var(--text);font-size:13px">
            ${[curYear-1, curYear, curYear+1].map(y =>
              `<option value="${y}" ${y === curYear ? 'selected' : ''}>${y}${syncedYears.includes(y) ? ' ✓' : ''}</option>`
            ).join('')}
          </select>
        </div>
        <!-- Button + status grouped so both bottom-align with the selects -->
        <div style="display:flex;align-items:center;gap:8px">
          <button class="btn btn-outline" id="sync-btn" onclick="syncHolidays()" style="font-size:13px;white-space:nowrap">
            🔄 Sync National Holidays
          </button>
          <span style="font-size:12px;color:var(--muted);white-space:nowrap">
            ${syncedYears.length
              ? `<span style="color:var(--green)">✓</span> Synced: ${syncedYears.join(', ')}`
              : 'No years synced yet'}
          </span>
        </div>
      </div>
      <p style="font-size:11px;color:var(--muted);margin-top:10px">
        Powered by <strong style="color:var(--text-2)">Nager.Date</strong> — free public holiday API, no key required.
      </p>
    </div>

    <!-- ── Custom Closures ─────────────────────────────────── -->
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div>
          <h3>Custom Closures</h3>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">Company outings, regional leaves, Cuti Bersama, unexpected office closures</div>
        </div>
        <button class="btn btn-outline" style="font-size:12px;padding:5px 14px;flex-shrink:0" onclick="toggleAddCustomForm()">+ Add Closure</button>
      </div>

      <div id="add-custom-form" style="display:none;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:14px">
        <div style="display:grid;grid-template-columns:1fr 180px auto auto;gap:10px;align-items:end">
          <div>
            <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);display:block;margin-bottom:5px">Closure Name *</label>
            <input type="text" id="custom-name" placeholder="e.g. Company Team Outing" autocomplete="off"
              style="width:100%;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:7px 12px;color:var(--text);font-size:13px"
              onkeydown="if(event.key==='Enter')submitCustomHoliday()" />
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);display:block;margin-bottom:5px">Date *</label>
            <input type="date" id="custom-date"
              style="width:100%;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:7px 12px;color:var(--text);font-size:13px" />
          </div>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding-bottom:2px;white-space:nowrap">
            <input type="checkbox" id="custom-recurring" style="accent-color:var(--accent);width:15px;height:15px;cursor:pointer" />
            <span style="font-size:13px">♻ Annual</span>
          </label>
          <button class="btn btn-primary" style="font-size:13px" onclick="submitCustomHoliday()">Add</button>
        </div>
      </div>

      ${!custom.length
        ? `<div class="empty-state" style="font-size:13px;padding:20px 0">No custom closures yet.</div>`
        : renderHolidayRows(custom)}
    </div>

    <!-- ── National Holidays ───────────────────────────────── -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div>
          <h3>National Holidays
            <span style="font-size:12px;font-weight:400;color:var(--muted);margin-left:6px">${national.length} loaded</span>
          </h3>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">Imported from Nager.Date — sync each year separately</div>
        </div>
        ${national.length ? `
          <div style="display:flex;gap:6px">
            <button class="btn btn-ghost" style="font-size:12px;padding:4px 12px" onclick="setBulkHolidayActive('national',true)">Enable All</button>
            <button class="btn btn-ghost" style="font-size:12px;padding:4px 12px" onclick="setBulkHolidayActive('national',false)">Disable All</button>
          </div>` : ''}
      </div>
      ${!national.length
        ? `<div class="empty-state" style="font-size:13px;padding:20px 0">
             No national holidays loaded yet.<br/>
             <span style="font-size:12px">Use the "Sync National Holidays" button above to import them.</span>
           </div>`
        : renderHolidayRows(national)}
    </div>
  `;
}

function renderHolidayRows(list) {
  return `<div style="display:grid;gap:6px">
    ${list.map(h => {
      // Use noon UTC to avoid date-flip on timezone boundaries
      const d       = new Date(h.date + 'T12:00:00Z');
      const dateStr = d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
      const dayStr  = d.toLocaleDateString(undefined, { weekday:'short' });
      const isWeekend = [0, 6].includes(d.getUTCDay());
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--bg);border-radius:8px;
          border:1px solid ${h.isActive ? 'var(--border)' : 'rgba(51,65,85,0.3)'};
          opacity:${h.isActive ? '1' : '0.55'};transition:opacity 0.15s">
          <div style="min-width:90px;flex-shrink:0">
            <div style="font-size:12px;font-weight:700;color:${h.isActive ? 'var(--accent)' : 'var(--muted)'}">${dateStr}</div>
            <div style="font-size:11px;color:${isWeekend ? 'var(--muted)' : 'var(--text-2)'}">${dayStr}</div>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(h.name)}</div>
            ${h.nameEn && h.nameEn !== h.name
              ? `<div style="font-size:11px;color:var(--muted)">${esc(h.nameEn)}</div>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
            ${h.isRecurring
              ? `<span style="font-size:10px;background:rgba(99,102,241,0.15);color:#a5b4fc;padding:2px 8px;border-radius:10px;font-weight:600">♻ Annual</span>` : ''}
            ${h.type === 'national'
              ? `<span style="font-size:10px;background:rgba(16,185,129,0.12);color:#34d399;padding:2px 8px;border-radius:10px;font-weight:600">🌏 National</span>`
              : `<span style="font-size:10px;background:rgba(245,158,11,0.15);color:#fbbf24;padding:2px 8px;border-radius:10px;font-weight:600">🏢 Custom</span>`}
            <button class="btn btn-ghost" style="font-size:11px;padding:3px 10px;border:1px solid var(--border);${h.isActive ? 'color:var(--green)' : 'color:var(--muted)'}"
              onclick="toggleHolidayActive('${h.id}',${!h.isActive})" title="${h.isActive ? 'Click to disable' : 'Click to enable'}">
              ${h.isActive ? '● Active' : '○ Off'}
            </button>
            <button class="btn btn-ghost" style="font-size:15px;padding:3px 8px" title="Delete"
              onclick="deleteHolidayEntry('${h.id}','${esc(h.name).replace(/'/g,"\\'")}')">🗑</button>
          </div>
        </div>
      `;
    }).join('')}
  </div>`;
}

// ── Holiday CRUD ──────────────────────────────────────────────

async function saveHolidaySettings(updates) {
  try {
    _holidaySettings = { ..._holidaySettings, ...updates };
    await apiJSON('PUT', '/api/holidays/settings', _holidaySettings);
    toast('Settings saved', 'success');
    renderHolidaysContent();
  } catch (e) { toast(e.message, 'error'); }
}

async function syncHolidays() {
  const year    = parseInt(document.getElementById('sync-year').value);
  const country = document.getElementById('sync-country').value;
  const btn     = document.getElementById('sync-btn');
  btn.disabled  = true;
  btn.textContent = '🔄 Syncing…';
  try {
    const res = await apiJSON('POST', '/api/holidays/sync', { year, country });
    toast(`✓ ${res.added} new holidays added for ${country} ${year}${res.skipped ? ` · ${res.skipped} already existed` : ''}`, 'success');
    const [settings, holidays] = await Promise.all([
      apiJSON('GET', '/api/holidays/settings'),
      apiJSON('GET', '/api/holidays'),
    ]);
    _holidaySettings = settings;
    _holidays = holidays;
    renderHolidaysContent();
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = '🔄 Sync National Holidays';
  }
}

function toggleAddCustomForm() {
  const f = document.getElementById('add-custom-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
  if (f.style.display === 'block') document.getElementById('custom-name').focus();
}

async function submitCustomHoliday() {
  const name      = document.getElementById('custom-name').value.trim();
  const date      = document.getElementById('custom-date').value;
  const recurring = document.getElementById('custom-recurring').checked;
  if (!name) return toast('Closure name is required', 'error');
  if (!date) return toast('Date is required', 'error');
  try {
    const h = await apiJSON('POST', '/api/holidays', { name, date, isRecurring: recurring, type: 'custom' });
    _holidays.unshift(h);
    toast('Custom closure added', 'success');
    document.getElementById('custom-name').value = '';
    document.getElementById('custom-date').value = '';
    document.getElementById('custom-recurring').checked = false;
    renderHolidaysContent();
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleHolidayActive(id, active) {
  try {
    const updated = await apiJSON('PUT', `/api/holiday/${id}`, { isActive: active });
    const idx = _holidays.findIndex(h => h.id === id);
    if (idx !== -1) _holidays[idx] = updated;
    renderHolidaysContent();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteHolidayEntry(id, name) {
  if (!confirm(`Delete "${name}"?`)) return;
  try {
    await apiJSON('DELETE', `/api/holiday/${id}`);
    _holidays = _holidays.filter(h => h.id !== id);
    toast('Deleted', 'success');
    renderHolidaysContent();
  } catch (e) { toast(e.message, 'error'); }
}

async function setBulkHolidayActive(type, active) {
  const targets = _holidays.filter(h => h.type === type);
  if (!targets.length) return;
  try {
    await Promise.all(targets.map(h => apiJSON('PUT', `/api/holiday/${h.id}`, { isActive: active })));
    targets.forEach(h => { h.isActive = active; });
    renderHolidaysContent();
    toast(`${active ? 'Enabled' : 'Disabled'} all ${type} holidays`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Booking Invite Modal ──────────────────────────────────────

function openBookingInviteModal(token) {
  _inviteBookingToken = token;
  const link = _bookingLinks.find(l => l.token === token);
  document.getElementById('bi-modal-title').textContent = 'Invite to Book';
  document.getElementById('bi-modal-sub').textContent = link ? link.title : '';
  // Reset state
  document.getElementById('bi-name').value = '';
  document.getElementById('bi-email').value = '';
  document.getElementById('bi-single-result').style.display = 'none';
  const sendBtn = document.getElementById('bi-send-btn');
  sendBtn.disabled = false; sendBtn.textContent = '✉ Send Invitation';
  resetBIBulkUpload();
  switchBIMode('single');
  openModal('modal-booking-invite');
  setTimeout(() => document.getElementById('bi-name')?.focus(), 80);
}

function switchBIMode(mode) {
  document.getElementById('bi-single-section').style.display = mode === 'single' ? 'block' : 'none';
  document.getElementById('bi-bulk-section').style.display   = mode === 'bulk'   ? 'block' : 'none';
  document.getElementById('bi-mode-single').classList.toggle('active', mode === 'single');
  document.getElementById('bi-mode-bulk').classList.toggle('active',   mode === 'bulk');
}

async function sendSingleBookingInvite() {
  const name  = document.getElementById('bi-name').value.trim();
  const email = document.getElementById('bi-email').value.trim();
  if (!name)  return toast('Candidate name is required', 'error');
  if (!email || !email.includes('@')) return toast('Valid email is required', 'error');

  const btn = document.getElementById('bi-send-btn');
  btn.disabled = true; btn.textContent = 'Sending…';

  try {
    await apiJSON('POST', `/api/booking/link/${_inviteBookingToken}/send-invite`, {
      candidateName:  name,
      candidateEmail: email,
      bookUrl:        buildBookUrl(_inviteBookingToken),
    });
    const result = document.getElementById('bi-single-result');
    result.style.display = 'block';
    result.innerHTML = `<div style="background:rgba(22,163,74,0.1);border:1px solid rgba(22,163,74,0.3);border-radius:8px;padding:10px 14px;font-size:13px;color:#16a34a">
      ✓ Invitation sent to <strong>${esc(name)}</strong> (${esc(email)})
    </div>`;
    document.getElementById('bi-name').value  = '';
    document.getElementById('bi-email').value = '';
    btn.disabled = false; btn.textContent = '✉ Send Another';
    toast(`Invitation sent to ${name}`, 'success');
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
    btn.disabled = false; btn.textContent = '✉ Send Invitation';
  }
}

// ── BI Bulk import ────────────────────────────────────────────

async function handleBIBulkFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  let rows, headers;
  try {
    if (ext === 'csv') {
      ({ rows, headers } = parseCsvText(await file.text()));
    } else if (ext === 'xlsx' || ext === 'xls') {
      if (typeof XLSX === 'undefined') return toast('Excel library not loaded — try CSV', 'error');
      ({ rows, headers } = parseXlsxBuffer(await file.arrayBuffer()));
    } else {
      return toast('Please upload .csv, .xlsx, or .xls', 'error');
    }
  } catch (e) { return toast('Could not read file: ' + e.message, 'error'); }
  if (!rows.length) return toast('No data rows found', 'error');

  _biBulkRows    = rows;
  _biBulkHeaders = headers;
  _biBulkNameCol  = detectBestCol(headers, ['full name','fullname','name','candidate']);
  if (!_biBulkNameCol) {
    const first = headers.find(h => /first.?name|fname/i.test(h));
    const last  = headers.find(h => /last.?name|lname|surname/i.test(h));
    if (first && last) _biBulkNameCol = `__concat__${first}__${last}`;
    else _biBulkNameCol = first || last || headers[0];
  }
  _biBulkEmailCol = detectBestCol(headers, ['email','e-mail','mail']);
  renderBIBulkPreview();
}

function getBIName(row) {
  if (_biBulkNameCol?.startsWith('__concat__')) {
    return _biBulkNameCol.slice('__concat__'.length).split('__').map(k => row[k]||'').filter(Boolean).join(' ');
  }
  return row[_biBulkNameCol] || '';
}
function getBIEmail(row) { return row[_biBulkEmailCol] || ''; }

function renderBIBulkPreview() {
  const section = document.getElementById('bi-bulk-preview');
  const first = _biBulkHeaders.find(h => /first.?name|fname/i.test(h));
  const last  = _biBulkHeaders.find(h => /last.?name|lname|surname/i.test(h));
  const concatKey = first && last ? `__concat__${first}__${last}` : null;

  const nameOpts = [
    ...(concatKey ? [`<option value="${esc(concatKey)}" ${_biBulkNameCol===concatKey?'selected':''}>First + Last Name</option>`] : []),
    ..._biBulkHeaders.map(h => `<option value="${esc(h)}" ${_biBulkNameCol===h?'selected':''}>${esc(h)}</option>`),
  ].join('');
  const emailOpts = _biBulkHeaders.map(h =>
    `<option value="${esc(h)}" ${_biBulkEmailCol===h?'selected':''}>${esc(h)}</option>`
  ).join('');

  const preview    = _biBulkRows.slice(0, 5);
  const validCount = _biBulkRows.filter(r => getBIName(r) && getBIEmail(r)).length;

  section.style.display = 'block';
  section.innerHTML = `
    <div style="margin-top:14px;padding:14px 16px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end;margin-bottom:14px">
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);display:block;margin-bottom:4px">Name Column</label>
          <select onchange="_biBulkNameCol=this.value;renderBIBulkPreview()"
            style="width:100%;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:13px;font-family:inherit">${nameOpts}</select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);display:block;margin-bottom:4px">Email Column</label>
          <select onchange="_biBulkEmailCol=this.value;renderBIBulkPreview()"
            style="width:100%;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:13px;font-family:inherit">${emailOpts}</select>
        </div>
        <button class="btn btn-ghost" style="font-size:12px" onclick="resetBIBulkUpload()">✕ Clear</button>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:6px">
        Preview — first 5 of <strong style="color:var(--text)">${_biBulkRows.length}</strong> rows
        ${validCount < _biBulkRows.length ? `<span style="color:var(--red)">&nbsp;·&nbsp; ${_biBulkRows.length - validCount} rows missing name or email</span>` : ''}
      </div>
      <div style="border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;padding:7px 12px;background:var(--card-2);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted)">
          <span>Name</span><span>Email</span>
        </div>
        ${preview.map(r => {
          const n = getBIName(r), e = getBIEmail(r);
          return `<div style="display:grid;grid-template-columns:1fr 1fr;padding:7px 12px;border-top:1px solid rgba(51,65,85,0.5);font-size:12px${!n||!e?';background:rgba(239,68,68,0.05)':''}">
            <span style="${!n?'color:var(--red)':''}">${n||'⚠ missing'}</span>
            <span style="${!e?'color:var(--red)':''}">${e||'⚠ missing'}</span>
          </div>`;
        }).join('')}
        ${_biBulkRows.length > 5 ? `<div style="padding:6px 12px;border-top:1px solid rgba(51,65,85,0.5);font-size:11px;color:var(--muted);text-align:center">and ${_biBulkRows.length-5} more…</div>` : ''}
      </div>
      <button class="btn btn-primary" onclick="runBulkBookingInvite()">✉ Send Invitations to ${validCount}</button>
    </div>`;
}

function resetBIBulkUpload() {
  _biBulkRows = []; _biBulkHeaders = []; _biBulkNameCol = null; _biBulkEmailCol = null;
  const preview  = document.getElementById('bi-bulk-preview');
  const progress = document.getElementById('bi-bulk-progress');
  if (preview)  { preview.style.display  = 'none'; preview.innerHTML  = ''; }
  if (progress) { progress.style.display = 'none'; progress.innerHTML = ''; }
  const fi = document.getElementById('bi-bulk-file');
  if (fi) fi.value = '';
}

async function runBulkBookingInvite() {
  const validRows = _biBulkRows.filter(r => getBIName(r) && getBIEmail(r));
  if (!validRows.length) return toast('No valid rows to import', 'error');

  document.getElementById('bi-bulk-preview').querySelectorAll('button,select').forEach(el => el.disabled = true);
  const progress = document.getElementById('bi-bulk-progress');
  progress.style.display = 'block';

  let done = 0, failed = 0;
  const errors = [];
  const total  = validRows.length;
  const bookUrl = buildBookUrl(_inviteBookingToken);

  const showProgress = () => {
    const pct = Math.round((done + failed) / total * 100);
    progress.innerHTML = `
      <div style="font-size:13px;color:var(--text-2);margin-bottom:8px">Sending invitations… <strong>${done+failed}</strong> / ${total}</div>
      <div style="background:var(--border);border-radius:4px;height:6px;overflow:hidden">
        <div style="background:var(--accent);height:100%;border-radius:4px;width:${pct}%;transition:width 0.15s"></div>
      </div>`;
  };
  showProgress();

  for (const row of validRows) {
    try {
      await apiJSON('POST', `/api/booking/link/${_inviteBookingToken}/send-invite`, {
        candidateName:  getBIName(row),
        candidateEmail: getBIEmail(row),
        bookUrl,
      });
      done++;
    } catch (e) { failed++; errors.push(e.message); }
    showProgress();
  }

  progress.innerHTML = `
    <div style="padding:14px 16px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">Done</div>
      <div class="flex gap-16">
        <span style="color:var(--green)">✓ ${done} invitations sent</span>
        ${failed ? `<span style="color:var(--red)">✗ ${failed} failed</span>` : ''}
      </div>
      ${errors.length ? `<div class="text-muted text-sm mt-8">${errors.slice(0,3).map(e=>`<div>• ${esc(e)}</div>`).join('')}${errors.length>3?`<div>…and ${errors.length-3} more</div>`:''}</div>` : ''}
      <button class="btn btn-outline mt-16" onclick="resetBIBulkUpload();switchBIMode('single')">Done</button>
    </div>`;
}

// ── Edit Booking Link ─────────────────────────────────────────

function editBookingLink(token) {
  _editingBookingToken = token;
  gotoPage('booking-edit');
}

async function renderEditBookingLinkPage(token) {
  const main = document.getElementById('admin-main');
  if (!token) { gotoPage('booking'); return; }

  // Find from cache or refresh
  let link = _bookingLinks.find(l => l.token === token);
  if (!link) {
    try {
      const links = await apiJSON('GET', '/api/booking/links');
      _bookingLinks = links;
      link = links.find(l => l.token === token);
    } catch (e) {
      main.innerHTML = `<div class="empty-state" style="color:var(--red)">${esc(e.message)}</div>`;
      return;
    }
  }
  if (!link) {
    main.innerHTML = `<div class="empty-state" style="color:var(--red)">Booking link not found.</div>`;
    return;
  }

  // Pre-populate slot rules state
  _editingSlotRules = (link.slotRules || []).map(r => ({ ...r }));
  const tzOffset = link.tzOffset ?? 0;

  main.innerHTML = `
    <div style="max-width:700px">
      <div style="margin-bottom:20px">
        <button class="btn btn-ghost" style="padding:5px 12px;font-size:13px" onclick="gotoPage('booking')">← Booking Interview</button>
      </div>
      <h2 class="mb-16">Edit Booking Link</h2>
      <div class="card">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div class="form-group" style="margin-bottom:0;grid-column:1/-1">
            <label>Link Title *</label>
            <input type="text" id="bl-title" value="${esc(link.title)}" placeholder="e.g. Initial Screening – P&O Cruises" autocomplete="off" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Client Name</label>
            <input type="text" id="bl-client" value="${esc(link.clientName || '')}" placeholder="e.g. P&O Cruises" autocomplete="off" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Position / Role</label>
            <input type="text" id="bl-position" value="${esc(link.position || '')}" placeholder="e.g. Waiter" autocomplete="off" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Slot Duration</label>
            <select id="bl-duration">
              ${BOOKING_DURATIONS.map(d => `<option value="${d}" ${d === (link.duration || 30) ? 'selected' : ''}>${d} minutes</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Timezone Offset</label>
            <select id="bl-tz">
              ${[-720,-660,-600,-570,-540,-480,-420,-360,-300,-240,-210,-180,-120,-60,0,60,120,180,210,240,270,300,330,345,360,390,420,480,510,525,540,570,600,630,660,720].map(o => {
                return `<option value="${o}" ${o === tzOffset ? 'selected' : ''}>${formatTzOffset(o)}</option>`;
              }).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Days Available Ahead</label>
            <select id="bl-days-ahead">
              ${BOOKING_DAYS_AHEAD.map(d => `<option value="${d}" ${d === (link.daysAhead || 14) ? 'selected' : ''}>${d} days</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label>Scheduling Notice</label>
            <select id="bl-min-notice">
              ${BOOKING_MIN_NOTICE.map(o => `<option value="${o.value}" ${o.value === (link.minNoticeHours ?? 24) ? 'selected' : ''}>${o.label}</option>`).join('')}
            </select>
          </div>
        </div>

        <hr class="divider" />
        <h3 style="margin-bottom:14px">Weekly Availability</h3>
        <div id="slot-rules-editor" style="display:grid;gap:8px">
          ${renderSlotRulesEditor()}
        </div>

        <div class="flex gap-8 items-center" style="margin-top:24px">
          <button class="btn btn-primary" id="bl-submit-btn" onclick="submitEditBookingLink('${token}')">Save Changes</button>
          <button class="btn btn-outline" onclick="gotoPage('booking')">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

async function submitEditBookingLink(token) {
  const title          = document.getElementById('bl-title').value.trim();
  const clientName     = document.getElementById('bl-client').value.trim();
  const position       = document.getElementById('bl-position').value.trim();
  const duration       = parseInt(document.getElementById('bl-duration').value);
  const tzOffset       = parseInt(document.getElementById('bl-tz').value);
  const daysAhead      = parseInt(document.getElementById('bl-days-ahead').value);
  const minNoticeHours = parseInt(document.getElementById('bl-min-notice').value);

  if (!title) return toast('Title is required', 'error');
  if (!_editingSlotRules.length) return toast('Please enable at least one day of availability', 'error');

  for (const r of _editingSlotRules) {
    const [fh, fm] = r.from.split(':').map(Number);
    const [th, tm] = r.to.split(':').map(Number);
    if (fh * 60 + fm >= th * 60 + tm) {
      return toast(`${BOOKING_DAYS[r.day]}: each "From" time must be before its "To" time`, 'error');
    }
  }

  const btn = document.getElementById('bl-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await apiJSON('PUT', `/api/booking/link/${token}`, {
      title, clientName, position, duration,
      tzOffset, daysAhead, minNoticeHours, slotRules: _editingSlotRules,
    });
    toast('Booking link updated!', 'success');
    gotoPage('booking');
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
  }
}

async function submitCreateBookingLink() {
  const title          = document.getElementById('bl-title').value.trim();
  const clientName     = document.getElementById('bl-client').value.trim();
  const position       = document.getElementById('bl-position').value.trim();
  const duration       = parseInt(document.getElementById('bl-duration').value);
  const tzOffset       = parseInt(document.getElementById('bl-tz').value);
  const daysAhead      = parseInt(document.getElementById('bl-days-ahead').value);
  const minNoticeHours = parseInt(document.getElementById('bl-min-notice').value);

  if (!title) return toast('Title is required', 'error');
  if (!_editingSlotRules.length) return toast('Please enable at least one day of availability', 'error');

  // Validate all ranges have valid from < to, and no overlaps within a day
  for (const r of _editingSlotRules) {
    const [fh, fm] = r.from.split(':').map(Number);
    const [th, tm] = r.to.split(':').map(Number);
    if (fh * 60 + fm >= th * 60 + tm) {
      return toast(`${BOOKING_DAYS[r.day]}: each "From" time must be before its "To" time`, 'error');
    }
  }

  const btn = document.getElementById('bl-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

  try {
    await apiJSON('POST', '/api/booking/links', {
      title, clientName, position, duration,
      tzOffset, daysAhead, minNoticeHours, slotRules: _editingSlotRules,
    });
    toast('Booking link created!', 'success');
    gotoPage('booking');
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Create Booking Link'; }
  }
}
