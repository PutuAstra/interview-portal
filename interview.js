// ─────────────────────────────────────────────────────────────
//  Candidate Interview Recording Page
//  Update WORKER_URL after deploying your Cloudflare Worker
// ─────────────────────────────────────────────────────────────

const WORKER_URL = 'https://interview-api.putuastrawijaya.workers.dev';

// ── State ─────────────────────────────────────────────────────
let session = null;
let interview = null;
let branding = {};
let currentQ = 0;
let retakesUsed = {}; // { [questionIndex]: number }
let mediaStream = null;
let recorder = null;
let chunks = [];
let recordingTimer = null;
let timeLeft = 0;

// ── Setup / virtual bg state ───────────────────────────────────
let bgMode = 'none';
let bgCanvas = null;
let bgCtx = null;
let segReady = false;
let segModel = null;
let segLoopId = null;
let lastSendTs = 0;
let lastSegMask = null;   // stores latest segmentation mask for use in draw loop
let tmpCanvas = null;     // reusable off-screen canvas (avoid creating per-frame)
let tmpCtx = null;
let canvasStream = null;
let micAnalyser = null;
let micMeterFrameId = null;
let setupAudioCtx = null;
const BG_FILLS = { white: '#f0ede8', navy: '#1a2744', slate: '#374151' };
let logoImg = null;
let blurMaskCanvas = null;  // cached ellipse mask for applySimpleBlur
let bgVid = null;           // persistent hidden video — lives on document.body, survives DOM swaps

const token = new URLSearchParams(location.search).get('token');
const main = () => document.getElementById('take-main');

// ── Boot ──────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  if (!token) return showError('No interview token found in the URL.');
  try {
    const res = await fetch(`${WORKER_URL}/api/session/${token}`);
    if (!res.ok) return showError('This interview link is invalid or has expired.');
    const data = await res.json();
    session   = data.session;
    interview = data.interview;
    branding  = data.branding || {};

    applyBranding(branding);

    if (session.status === 'completed') return showThankYou(true);
    if (session.expiresAt && Date.now() > session.expiresAt) return showExpired();
    showIntro();
  } catch {
    showError('Could not connect to the interview server. Please try again later.');
  }
});

// ── Screens ───────────────────────────────────────────────────

function showError(msg) {
  main().innerHTML = `
    <div class="thankyou-screen">
      <div class="thankyou-icon">⚠️</div>
      <h2 style="color:var(--red)">Something went wrong</h2>
      <p class="mt-8">${msg}</p>
    </div>`;
}

function showExpired() {
  main().innerHTML = `
    <div class="thankyou-screen">
      <div class="thankyou-icon">⏰</div>
      <h2 style="color:var(--muted)">Interview Closed</h2>
      <p class="mt-8">The submission deadline for this interview has passed.</p>
      <p class="text-muted text-sm mt-8">Please contact your recruiter if you believe this is an error.</p>
    </div>`;
}

function applyBranding(b) {
  if (!b) return;
  // Apply accent color
  if (b.brandColor) {
    document.documentElement.style.setProperty('--accent', b.brandColor);
    document.documentElement.style.setProperty('--red', b.brandColor);
  }
  // Update topbar brand name
  if (b.brandName) {
    const topbarBrand = document.querySelector('.topbar-brand');
    if (topbarBrand) {
      for (const node of topbarBrand.childNodes) {
        if (node.nodeType === 3 && node.textContent.trim()) {
          node.textContent = '\n    ' + b.brandName + '\n  ';
          break;
        }
      }
    }
    document.title = b.brandName;
  }
}

function showIntro() {
  const totalDuration = interview.questions.reduce((s, q) => s + q.duration, 0);
  const mins = Math.ceil(totalDuration / 60);

  main().innerHTML = `
    <div class="card" style="max-width:560px;width:100%;text-align:center">
      <div style="font-size:40px;margin-bottom:16px">🎙️</div>
      <h1>${esc(interview.title)}</h1>
      <p class="mt-8">Hello, <strong>${esc(session.candidateName)}</strong> 👋</p>

      ${branding.brandWelcomeMsg ? `<p class="mt-16" style="color:var(--accent);font-style:italic;font-size:14px">${esc(branding.brandWelcomeMsg)}</p>` : ''}
      ${interview.description ? `<p class="mt-16" style="color:var(--text-2)">${esc(interview.description)}</p>` : ''}

      <div class="card" style="background:var(--bg);margin-top:20px;text-align:left">
        <p class="text-sm text-muted mb-8">Before you start:</p>
        <ul style="list-style:disc;padding-left:18px;display:flex;flex-direction:column;gap:6px;color:var(--text-2);font-size:13px">
          <li>You will answer <strong>${interview.questions.length} question${interview.questions.length !== 1 ? 's' : ''}</strong>, taking around <strong>~${mins} min</strong></li>
          <li>Each question has a time limit — recording stops automatically</li>
          <li>Make sure your camera and microphone are ready</li>
          <li>Find a quiet place with good lighting</li>
          <li>Once you start a question you cannot redo it</li>
        </ul>
      </div>

      <button class="btn btn-primary btn-lg mt-24"
        onclick="${session.profilePhotoItemId && session.resumeItemId ? 'showSetup()' : 'showProfileUpload()'}">
        ${session.profilePhotoItemId && session.resumeItemId ? 'Setup &amp; Preview' : 'Continue →'}
      </button>
    </div>`;
}

// ── Profile Upload Step ───────────────────────────────────────

function showProfileUpload() {
  document.getElementById('topbar-progress').textContent = 'Step 1 of 2 — Your Profile';
  main().innerHTML = `
    <div class="card" style="max-width:520px;width:100%">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:36px;margin-bottom:8px">📋</div>
        <h2 style="margin:0">Your Profile</h2>
        <p class="text-muted text-sm mt-8">Upload your photo and resume before starting the interview</p>
      </div>

      <!-- Profile photo -->
      <div style="margin-bottom:24px;text-align:center">
        <p style="font-size:13px;font-weight:600;margin-bottom:12px">Profile Photo <span style="color:var(--red)">*</span></p>
        <div id="photo-circle"
          onclick="document.getElementById('photo-file-input').click()"
          style="width:110px;height:110px;border-radius:50%;border:2px dashed var(--border);background:var(--bg);margin:0 auto;cursor:pointer;display:flex;align-items:center;justify-content:center;overflow:hidden;transition:border-color 0.2s;font-size:13px;color:var(--muted)">
          📷 Add Photo
        </div>
        <input type="file" id="photo-file-input" accept="image/*" style="display:none"
          onchange="if(this.files[0]) showCropUI(this.files[0])" />
        <p class="text-muted" style="font-size:11px;margin-top:8px">JPG, PNG · max 5 MB</p>
      </div>

      <!-- Resume -->
      <div style="margin-bottom:28px">
        <p style="font-size:13px;font-weight:600;margin-bottom:10px">Resume / CV <span style="color:var(--red)">*</span></p>
        <div id="resume-drop"
          onclick="document.getElementById('resume-file-input').click()"
          style="border:2px dashed var(--border);border-radius:10px;padding:20px;text-align:center;cursor:pointer;transition:border-color 0.2s;background:var(--bg)"
          ondragover="event.preventDefault();this.style.borderColor='var(--accent)'"
          ondragleave="this.style.borderColor='var(--border)'"
          ondrop="event.preventDefault();this.style.borderColor='var(--border)';handleResumeFile(event.dataTransfer.files[0])">
          <div id="resume-drop-label" style="color:var(--muted);font-size:13px">
            📄 Click or drag your resume here<br>
            <span style="font-size:11px">PDF, DOC, DOCX · max 10 MB</span>
          </div>
        </div>
        <input type="file" id="resume-file-input" accept=".pdf,.doc,.docx" style="display:none"
          onchange="handleResumeFile(this.files[0])" />
      </div>

      <button class="btn btn-primary btn-lg" style="width:100%" onclick="submitProfileUpload()">
        Continue to Setup →
      </button>
    </div>`;
}

// ── Photo crop UI ─────────────────────────────────────────────

let _crop = null; // { img, objUrl, tx, ty, zoom, minZoom, size, blob }
let _cropMouseHandlers = null;

function showCropUI(file) {
  const img = new Image();
  const objUrl = URL.createObjectURL(file);
  img.onload = () => {
    const size = 280;
    const minZoom = Math.max(size / img.naturalWidth, size / img.naturalHeight);
    _crop = { img, objUrl, size, minZoom, zoom: minZoom, blob: null,
      tx: (size - img.naturalWidth * minZoom) / 2,
      ty: (size - img.naturalHeight * minZoom) / 2 };
    _buildCropOverlay();
    _drawCrop();
  };
  img.src = objUrl;
}

function _buildCropOverlay() {
  const existing = document.getElementById('crop-overlay');
  if (existing) existing.remove();

  const ov = document.createElement('div');
  ov.id = 'crop-overlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:20px';
  ov.innerHTML = `
    <p style="color:#fff;font-weight:700;font-size:15px;margin:0">Crop your photo</p>
    <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:-12px 0 0">Drag to reposition · use the slider to zoom</p>
    <div style="position:relative;flex-shrink:0">
      <canvas id="crop-canvas" width="280" height="280"
        style="display:block;border-radius:50%;cursor:grab;touch-action:none"></canvas>
      <div style="position:absolute;inset:0;border-radius:50%;
        box-shadow:0 0 0 2000px rgba(0,0,0,0.55);pointer-events:none"></div>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <span style="font-size:18px">🔍</span>
      <input type="range" id="crop-zoom-slider" min="0" max="3" step="0.01" value="0"
        style="width:200px;accent-color:#B01A18"
        oninput="_onCropZoom(+this.value)" />
    </div>
    <div style="display:flex;gap:10px">
      <button id="crop-confirm-btn"
        style="background:#B01A18;color:#fff;border:none;border-radius:8px;padding:11px 28px;font-size:14px;font-weight:600;cursor:pointer">
        ✓ Use Photo
      </button>
      <button onclick="_cancelCrop()"
        style="background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:11px 20px;font-size:14px;cursor:pointer">
        Choose Different
      </button>
    </div>`;
  document.body.appendChild(ov);

  document.getElementById('crop-confirm-btn').onclick = _confirmCrop;

  // Mouse drag
  const canvas = document.getElementById('crop-canvas');
  let dragging = false, lx = 0, ly = 0;
  const onDown = e => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.style.cursor = 'grabbing'; e.preventDefault(); };
  const onMove = e => { if (!dragging) return; _moveCrop(e.clientX - lx, e.clientY - ly); lx = e.clientX; ly = e.clientY; };
  const onUp   = () => { dragging = false; canvas.style.cursor = 'grab'; };
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup',   onUp);

  // Touch drag
  canvas.addEventListener('touchstart', e => { const t = e.touches[0]; lx = t.clientX; ly = t.clientY; }, { passive: true });
  canvas.addEventListener('touchmove',  e => {
    const t = e.touches[0];
    _moveCrop(t.clientX - lx, t.clientY - ly);
    lx = t.clientX; ly = t.clientY;
    e.preventDefault();
  }, { passive: false });

  // Store handlers for cleanup
  _cropMouseHandlers = { onMove, onUp };
}

function _drawCrop() {
  const canvas = document.getElementById('crop-canvas');
  if (!canvas || !_crop) return;
  const { img, tx, ty, zoom, size } = _crop;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, tx, ty, img.naturalWidth * zoom, img.naturalHeight * zoom);
}

function _moveCrop(dx, dy) {
  if (!_crop) return;
  const { img, zoom, size } = _crop;
  const iw = img.naturalWidth  * zoom;
  const ih = img.naturalHeight * zoom;
  let tx = _crop.tx + dx;
  let ty = _crop.ty + dy;
  if (iw >= size) { tx = Math.min(tx, 0); tx = Math.max(tx, size - iw); } else { tx = (size - iw) / 2; }
  if (ih >= size) { ty = Math.min(ty, 0); ty = Math.max(ty, size - ih); } else { ty = (size - ih) / 2; }
  _crop.tx = tx;
  _crop.ty = ty;
  _drawCrop();
}

function _onCropZoom(val) {
  if (!_crop) return;
  const newZoom = _crop.minZoom * (1 + val);
  // Keep center point stable
  const { size, zoom, tx, ty } = _crop;
  const cx = (size / 2 - tx) / zoom;
  const cy = (size / 2 - ty) / zoom;
  _crop.zoom = newZoom;
  _crop.tx = size / 2 - cx * newZoom;
  _crop.ty = size / 2 - cy * newZoom;
  _moveCrop(0, 0); // re-clamp
  _drawCrop();
}

function _cancelCrop() {
  _cleanupCropOverlay();
  window._croppedPhotoBlob = null;
  // Reset and re-open file picker
  const inp = document.getElementById('photo-file-input');
  if (inp) { inp.value = ''; inp.click(); }
}

function _confirmCrop() {
  if (!_crop) return;
  const outSize = 400;
  const out = document.createElement('canvas');
  out.width = out.height = outSize;
  const scale = outSize / _crop.size;
  out.getContext('2d').drawImage(
    _crop.img,
    _crop.tx * scale, _crop.ty * scale,
    _crop.img.naturalWidth * _crop.zoom * scale,
    _crop.img.naturalHeight * _crop.zoom * scale
  );
  out.toBlob(blob => {
    window._croppedPhotoBlob = blob;
    // Update circle preview
    const circle = document.getElementById('photo-circle');
    if (circle) {
      const url = URL.createObjectURL(blob);
      circle.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      circle.style.border = '2px solid var(--accent)';
    }
    _cleanupCropOverlay();
  }, 'image/jpeg', 0.92);
}

function _cleanupCropOverlay() {
  if (_cropMouseHandlers) {
    window.removeEventListener('mousemove', _cropMouseHandlers.onMove);
    window.removeEventListener('mouseup',   _cropMouseHandlers.onUp);
    _cropMouseHandlers = null;
  }
  if (_crop?.objUrl) URL.revokeObjectURL(_crop.objUrl);
  _crop = null;
  const ov = document.getElementById('crop-overlay');
  if (ov) ov.remove();
}

function handleResumeFile(file) {
  if (!file) return;
  const label = document.getElementById('resume-drop-label');
  if (label) label.innerHTML = `✅ <strong>${esc(file.name)}</strong> (${(file.size/1024).toFixed(0)} KB)`;
  // Store file reference on input element for later use
  const input = document.getElementById('resume-file-input');
  if (input && !input.files.length) {
    // Was a drag-drop — create a DataTransfer to assign
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
  }
}

async function submitProfileUpload() {
  const photoBlob   = window._croppedPhotoBlob;   // set by crop confirm
  const resumeInput = document.getElementById('resume-file-input');
  const resumeFile  = resumeInput?.files?.[0];

  if (!photoBlob)  return toast('Please upload and crop your profile photo', 'error');
  if (!resumeFile) return toast('Please upload your resume', 'error');
  if (resumeFile.size > 10 * 1024 * 1024) return toast('Resume must be under 10 MB', 'error');

  main().innerHTML = `
    <div class="card" style="max-width:400px;width:100%;text-align:center;padding:48px 32px">
      <div class="spinner" style="margin:0 auto 16px"></div>
      <p style="font-weight:600">Uploading your profile…</p>
      <p class="text-muted text-sm mt-8">This only takes a moment</p>
    </div>`;

  try {
    // Upload cropped photo via FormData (avoids CORS preflight)
    const photoForm = new FormData();
    photoForm.append('file', photoBlob, 'profile.jpg');
    const photoRes = await fetch(`${WORKER_URL}/api/session/${token}/upload-photo`, {
      method: 'POST',
      body: photoForm,
    });
    if (!photoRes.ok) {
      const err = await photoRes.json().catch(() => ({}));
      throw new Error(err.error || `Photo upload failed (${photoRes.status})`);
    }

    // Upload resume via FormData
    const resumeForm = new FormData();
    resumeForm.append('file', resumeFile, resumeFile.name);
    const resumeRes = await fetch(`${WORKER_URL}/api/session/${token}/upload-resume`, {
      method: 'POST',
      body: resumeForm,
    });
    if (!resumeRes.ok) {
      const err = await resumeRes.json().catch(() => ({}));
      throw new Error(err.error || `Resume upload failed (${resumeRes.status})`);
    }

    session.profilePhotoItemId = true;
    session.resumeItemId = true;
    window._croppedPhotoBlob = null;

    showSetup();
  } catch (e) {
    main().innerHTML = `
      <div class="card" style="max-width:400px;width:100%;text-align:center;padding:48px 32px">
        <p style="color:var(--red);font-weight:600">Upload failed</p>
        <p class="text-muted text-sm mt-8">${e.message}</p>
        <button class="btn btn-primary mt-16" onclick="showProfileUpload()">Try Again</button>
      </div>`;
  }
}

async function requestCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
    });
    showQuestion(0);
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      showError('Camera and microphone access was denied. Please allow access in your browser settings and reload the page.');
    } else {
      showError('Could not access your camera or microphone: ' + e.message);
    }
  }
}

// ── Setup screen ──────────────────────────────────────────────

async function showSetup() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
    });
  } catch (e) {
    return showError(e.name === 'NotAllowedError'
      ? 'Camera and microphone access was denied. Please allow access in your browser settings and reload the page.'
      : 'Could not access your camera or microphone: ' + e.message);
  }

  // Create a persistent hidden video element attached directly to document.body.
  // This is the KEY fix for the frozen camera bug: when showQuestion() replaces
  // main().innerHTML, any <video> inside that div is removed from the DOM and
  // Chrome suspends its playback, freezing the canvas loop. By living on body
  // it survives all DOM swaps inside #take-main.
  if (!bgVid) {
    bgVid = document.createElement('video');
    bgVid.autoplay = true;
    bgVid.muted    = true;
    bgVid.setAttribute('playsinline', '');
    bgVid.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;pointer-events:none';
    document.body.appendChild(bgVid);
  }
  bgVid.srcObject = mediaStream;
  await bgVid.play();

  main().innerHTML = `
    <div style="max-width:820px;width:100%">
      <div style="text-align:center;margin-bottom:20px">
        <h2>Setup &amp; Preview</h2>
        <p class="text-muted text-sm mt-4">Check your camera, microphone, and background before starting</p>
      </div>
      <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:20px;align-items:start">
        <div style="position:relative">
          <canvas id="bg-canvas" style="width:100%;border-radius:12px;background:#111;display:block"></canvas>
        </div>
        <div style="display:flex;flex-direction:column;gap:14px">

          <div class="card" style="padding:16px">
            <p class="setup-section-label">🖼 Virtual Background</p>
            <div id="bg-opts" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
              <button class="bg-opt active" data-bg="none" onclick="setBg('none')">None</button>
              <button class="bg-opt"        data-bg="blur" onclick="setBg('blur')">Blur</button>
              <button class="bg-swatch" data-bg="white" onclick="setBg('white')" style="background:#f0ede8" title="Light"></button>
              <button class="bg-swatch" data-bg="navy"  onclick="setBg('navy')"  style="background:#1a2744" title="Navy"></button>
              <button class="bg-swatch" data-bg="slate" onclick="setBg('slate')" style="background:#374151" title="Slate"></button>
            </div>
            <p id="seg-status" style="font-size:11px;color:var(--muted)">Loading AI segmentation…</p>
          </div>

          <div class="card" style="padding:16px">
            <p class="setup-section-label">🎤 Microphone</p>
            <div style="height:8px;background:var(--bg);border-radius:4px;overflow:hidden;margin-bottom:6px">
              <div id="mic-bar" style="height:100%;width:0%;background:var(--accent);border-radius:4px;transition:width 0.07s linear"></div>
            </div>
            <p style="font-size:12px;color:var(--muted)">Speak to test your microphone</p>
          </div>

          <div class="card" style="padding:16px">
            <p class="setup-section-label">🔊 Speakers</p>
            <button class="btn btn-outline" style="width:100%;font-size:13px" onclick="testSpeakers()">▶ Play Test Sound</button>
          </div>

        </div>
      </div>
      <div style="text-align:center;margin-top:24px">
        <button class="btn btn-primary btn-lg" onclick="continueToInterview()">Continue to Interview →</button>
      </div>
    </div>`;

  bgCanvas = document.getElementById('bg-canvas');
  bgCtx = bgCanvas.getContext('2d');
  // Set canvas resolution from live video dimensions
  bgVid.addEventListener('loadedmetadata', () => {
    bgCanvas.width  = bgVid.videoWidth  || 640;
    bgCanvas.height = bgVid.videoHeight || 360;
    blurMaskCanvas  = null; // invalidate cached mask when resolution changes
  }, { once: true });
  bgCanvas.width  = bgVid.videoWidth  || 640;
  bgCanvas.height = bgVid.videoHeight || 360;

  // Preload CTI logo for watermark
  if (!logoImg) {
    logoImg = new Image();
    logoImg.src = 'cti-logo.png';
  }

  startBgLoop(bgVid);
  startMicMeter();
  loadSegmentation(bgVid);
}

async function loadSegmentation(vid) {
  const status = document.getElementById('seg-status');
  const MP_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation';
  try {
    // Dynamically load MediaPipe so we can catch failures cleanly
    if (typeof SelfieSegmentation === 'undefined') {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = MP_CDN + '/selfie_segmentation.js';
        s.crossOrigin = 'anonymous';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Script load failed'));
        document.head.appendChild(s);
      });
    }
    if (typeof SelfieSegmentation === 'undefined') throw new Error('SelfieSegmentation not defined');
    segModel = new SelfieSegmentation({ locateFile: f => `${MP_CDN}/${f}` });
    segModel.setOptions({ modelSelection: 1 });
    segModel.onResults(handleSegResults);
    await segModel.initialize();
    segReady = true;
    if (status) { status.textContent = '✓ AI ready — select a background above'; status.style.color = '#22c55e'; }
  } catch (e) {
    console.warn('[VirtualBg]', e.message);
    // Blur works without AI (portrait-mode fallback); only colour swatches need AI
    if (status) status.textContent = 'Blur ✓ (no AI) · Solid colours need AI (unavailable)';
    document.querySelectorAll('.bg-swatch').forEach(b => {
      b.style.opacity = '0.35'; b.style.pointerEvents = 'none';
    });
  }
}

function drawWatermark() {
  if (!logoImg || !logoImg.complete || !bgCtx || !bgCanvas) return;
  const logoH = Math.round(bgCanvas.height * 0.07); // ~7% of canvas height
  const logoW = Math.round(logoImg.naturalWidth * (logoH / logoImg.naturalHeight));
  const pad = Math.round(bgCanvas.width * 0.02);
  bgCtx.save();
  bgCtx.globalAlpha = 0.72;
  bgCtx.drawImage(logoImg, bgCanvas.width - logoW - pad, pad, logoW, logoH);
  bgCtx.restore();
}

// Ensure a reusable temp canvas the right size
function ensureTmp(w, h) {
  if (!tmpCanvas) { tmpCanvas = document.createElement('canvas'); tmpCtx = tmpCanvas.getContext('2d'); }
  if (tmpCanvas.width !== w) tmpCanvas.width = w;
  if (tmpCanvas.height !== h) tmpCanvas.height = h;
  return { tc: tmpCtx, tw: w, th: h };
}

// Build (or retrieve cached) elliptical alpha mask for the blur fallback.
// Uses canvas.ellipse() + blur so the shape is properly elliptical, not circular.
function ensureBlurMask(w, h) {
  if (blurMaskCanvas && blurMaskCanvas.width === w && blurMaskCanvas.height === h) {
    return blurMaskCanvas;
  }
  blurMaskCanvas = document.createElement('canvas');
  blurMaskCanvas.width  = w;
  blurMaskCanvas.height = h;
  const mc = blurMaskCanvas.getContext('2d');
  mc.clearRect(0, 0, w, h);
  // Ellipse strategy:
  //   Vertical (ry=0.62h, cy=0.48h): bottom at 1.10h, top at -0.14h → head and
  //     hands are always inside the opaque zone regardless of camera distance.
  //   Horizontal (rx=0.44w): stops at 6% from each edge (~38px at 640px canvas).
  //     That 6% strip stays transparent → blurred background is visible at sides.
  //   blur(12px): smooth ~24px transition. Less blur = less inward shrinkage.
  mc.save();
  mc.filter = 'blur(12px)';
  mc.fillStyle = 'black';
  mc.beginPath();
  mc.ellipse(
    w * 0.50, h * 0.48,  // center slightly above midpoint
    w * 0.44, h * 0.62,  // rx inside canvas edges; ry well past top/bottom
    0, 0, 2 * Math.PI
  );
  mc.fill();
  mc.restore();
  return blurMaskCanvas;
}

// Portrait-mode blur — no AI required; uses proper ellipse (not a circle)
function applySimpleBlur(vid, w, h) {
  // 1. Draw strongly blurred background (overscan avoids dark border artifacts)
  bgCtx.save();
  bgCtx.filter = 'blur(28px)';
  bgCtx.drawImage(vid, -36, -36, w + 72, h + 72);
  bgCtx.restore();

  // 2. Composite sharp person through the pre-built elliptical mask
  const { tc } = ensureTmp(w, h);
  tc.clearRect(0, 0, w, h);
  tc.drawImage(vid, 0, 0, w, h);                  // sharp video
  tc.globalCompositeOperation = 'destination-in';
  tc.drawImage(ensureBlurMask(w, h), 0, 0);        // keep only inside ellipse
  tc.globalCompositeOperation = 'source-over';
  bgCtx.drawImage(tmpCanvas, 0, 0, w, h);
}

// Draw frame using the stored AI segmentation mask (handles both blur and solid BG)
function drawWithMask(vid, w, h) {
  if (!lastSegMask) {
    // Mask not yet arrived — blur fallback for blur mode, raw video for solid colours
    if (bgMode === 'blur') { applySimpleBlur(vid, w, h); }
    else { bgCtx.drawImage(vid, 0, 0, w, h); }
    return;
  }
  // ── Background layer ─────────────────────────────────────────
  if (bgMode === 'blur') {
    // Blur the full frame — AI mask will cut out the sharp person on top
    bgCtx.save();
    bgCtx.filter = 'blur(28px)';
    bgCtx.drawImage(vid, -36, -36, w + 72, h + 72);
    bgCtx.restore();
  } else if (BG_FILLS[bgMode]) {
    bgCtx.fillStyle = BG_FILLS[bgMode];
    bgCtx.fillRect(0, 0, w, h);
  }
  // ── Sharp person cutout via AI mask ──────────────────────────
  const { tc } = ensureTmp(w, h);
  tc.clearRect(0, 0, w, h);
  tc.save();
  tc.filter = 'blur(2px)';          // minimal feather — no body ghosting
  // Draw mask 4px oversize on all sides so the blur kernel blends with real mask
  // content rather than the transparent canvas boundary — this eliminates the
  // faint bright halo/line that appears at canvas edges (most visible over white bg)
  tc.drawImage(lastSegMask, -4, -4, w + 8, h + 8);
  tc.restore();
  tc.globalCompositeOperation = 'source-in';
  tc.drawImage(vid, 0, 0, w, h);
  tc.globalCompositeOperation = 'source-over';
  bgCtx.drawImage(tmpCanvas, 0, 0, w, h);
}

function startBgLoop(vid) {
  function loop(ts) {
    if (!bgCanvas || !bgCtx) return;
    const w = bgCanvas.width, h = bgCanvas.height;
    if (!vid.videoWidth) { segLoopId = requestAnimationFrame(loop); return; }

    if (bgMode === 'none') {
      bgCtx.drawImage(vid, 0, 0, w, h);
    } else if (bgMode === 'blur' && !segReady) {
      // AI not ready — portrait-oval fallback so blur option isn't completely dead
      applySimpleBlur(vid, w, h);
    } else if (segReady) {
      // AI ready — handles both Blur and solid colours with proper person/BG separation
      if (ts - lastSendTs >= 66 && segModel) {
        lastSendTs = ts;
        segModel.send({ image: vid }).catch(() => {});
      }
      drawWithMask(vid, w, h);
    } else {
      bgCtx.drawImage(vid, 0, 0, w, h);
    }
    drawWatermark();
    segLoopId = requestAnimationFrame(loop);
  }
  segLoopId = requestAnimationFrame(loop);
}

function handleSegResults(results) {
  // Just store the mask; drawing happens in the animation loop every frame
  lastSegMask = results.segmentationMask;
}

function setBg(mode) {
  bgMode = mode;
  document.querySelectorAll('.bg-opt, .bg-swatch').forEach(b =>
    b.classList.toggle('active', b.dataset.bg === mode)
  );
}

function startMicMeter() {
  try {
    setupAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    micAnalyser = setupAudioCtx.createAnalyser();
    micAnalyser.fftSize = 512;
    setupAudioCtx.createMediaStreamSource(mediaStream).connect(micAnalyser);
    const buf = new Uint8Array(micAnalyser.frequencyBinCount);
    function tick() {
      if (!micAnalyser) return;
      micAnalyser.getByteFrequencyData(buf);
      const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
      const bar = document.getElementById('mic-bar');
      if (!bar) return;
      bar.style.width = Math.min(100, avg * 3) + '%';
      micMeterFrameId = requestAnimationFrame(tick);
    }
    micMeterFrameId = requestAnimationFrame(tick);
  } catch (e) {}
}

function testSpeakers() {
  // Use TTS for the speaker test — same audio path as the real interview,
  // sounds natural on all speakers, and lets the candidate hear the actual voice.
  if (!('speechSynthesis' in window)) {
    // Fallback: oscillator beep if TTS not available
    try {
      const ctx = new AudioContext();
      ctx.resume().then(() => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + 0.02);
        gain.gain.setValueAtTime(0.4, ctx.currentTime + 0.3);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.35);
        osc.frequency.value = 523;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
        setTimeout(() => ctx.close().catch(() => {}), 600);
      }).catch(() => {});
    } catch (e) { console.warn('testSpeakers:', e); }
    return;
  }

  window.speechSynthesis.cancel();

  // Pick the same recruiter voice used during the interview
  function pickVoice(voices) {
    const tests = [
      v => /\bonline\b/i.test(v.name) && /en[-_]US/i.test(v.lang),
      v => /\bonline\b/i.test(v.name) && v.lang.startsWith('en'),
      v => /google.*us.*english|google.*english.*us/i.test(v.name),
      v => /google/i.test(v.name) && v.lang.startsWith('en'),
      v => /\b(samantha|alex|karen|daniel)\b/i.test(v.name),
      v => /en[-_]US/i.test(v.lang),
      v => v.lang.startsWith('en'),
    ];
    for (const t of tests) { const m = voices.find(t); if (m) return m; }
    return null;
  }

  function doTest(voice) {
    const utt = new SpeechSynthesisUtterance(
      'Speaker test. If you can hear this clearly, your audio is working correctly.'
    );
    if (voice) utt.voice = voice;
    utt.rate   = 0.88;
    utt.pitch  = 0.95;
    utt.volume = 1;
    window.speechSynthesis.speak(utt);
  }

  const voices = window.speechSynthesis.getVoices();
  if (voices.length) {
    doTest(pickVoice(voices));
  } else {
    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.onvoiceschanged = null;
      doTest(pickVoice(window.speechSynthesis.getVoices()));
    };
  }
}

function continueToInterview() {
  // Stop mic meter
  cancelAnimationFrame(micMeterFrameId); micMeterFrameId = null;
  if (micAnalyser) { micAnalyser.disconnect(); micAnalyser = null; }
  if (setupAudioCtx) { setupAudioCtx.close().catch(() => {}); setupAudioCtx = null; }

  // Capture stream while bgCanvas is still in the DOM (setup screen).
  // showQuestion() immediately re-inserts bgCanvas into the camera-wrap div
  // so it stays composited — Chrome only pushes captureStream frames from
  // canvases that are actively rendered in the page compositor. Off-screen
  // or detached canvases produce no frames regardless of JS draw calls.
  canvasStream = bgCanvas.captureStream(30);
  mediaStream.getAudioTracks().forEach(t => canvasStream.addTrack(t));

  showQuestion(0);
}

function showQuestion(index) {
  currentQ = index;
  const q = interview.questions[index];
  const total = interview.questions.length;
  updateProgress(index, total);

  main().innerHTML = `
    <div class="question-card" style="max-width:720px;width:100%">
      <div class="question-header">
        <span class="text-muted text-sm">Question ${index + 1} of ${total}</span>
        <span class="text-sm" style="color:var(--text-2)">Time limit: ${formatTime(q.duration)}</span>
      </div>

      <div class="question-body">
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" id="progress-fill" style="width:${((index) / total) * 100}%"></div>
        </div>

        <div id="question-text" style="filter:blur(7px);user-select:none;transition:filter 0.4s ease">
          <p style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Question ${index + 1}</p>
          <p class="question-text">${esc(q.text)}</p>
        </div>
        <p id="question-hint" class="text-sm text-muted" style="margin-top:-4px;margin-bottom:4px">
          🔒 Question will be revealed when you press Record
        </p>

        <div class="camera-wrap" id="camera-wrap">
          <!-- bgCanvas is inserted here programmatically after innerHTML is set -->
          <div id="timer-overlay" class="timer-overlay" style="display:none"></div>
          <div id="overlay"></div>
        </div>

        <div id="controls" class="flex gap-12 justify-between items-center mt-16">
          <div>
            <p class="text-muted text-sm">Press Record when you're ready. You have ${formatTime(q.duration)}.</p>
            ${q.thinkTime ? `<p class="text-muted text-sm" style="margin-top:3px">💭 ${q.thinkTime}s think time before recording starts.</p>` : ''}
            ${(q.maxRetakes || 0) > 0 ? `<p class="text-muted text-sm" style="margin-top:3px">🔄 ${(q.maxRetakes || 0) - (retakesUsed[index] || 0)} retake${((q.maxRetakes || 0) - (retakesUsed[index] || 0)) !== 1 ? 's' : ''} remaining.</p>` : ''}
          </div>
          <button class="btn btn-primary btn-lg" id="record-btn" onclick="startCountdown()">
            ● Record
          </button>
        </div>
      </div>
    </div>`;

  // Place bgCanvas as the first child of camera-wrap so it fills the preview area.
  // It MUST be in the visible DOM — Chrome only composites (and thus captureStream-
  // captures) canvases that are part of the rendered page. The draw loop keeps
  // writing to it every rAF tick, so the user sees the live watermarked feed and
  // the recording bakes the logo in. Timer/overlay divs sit on top via z-index.
  const camWrap = document.getElementById('camera-wrap');
  if (bgCanvas && camWrap) {
    bgCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    camWrap.insertBefore(bgCanvas, camWrap.firstChild);
  }
}

function updateProgress(index, total) {
  document.getElementById('topbar-progress').textContent =
    `Question ${index + 1} of ${total}`;
}

// ── Recording flow ────────────────────────────────────────────

function startCountdown() {
  // Reveal the question now that candidate has committed to record
  const qText = document.getElementById('question-text');
  if (qText) { qText.style.filter = 'none'; qText.style.userSelect = ''; }
  const hint = document.getElementById('question-hint');
  if (hint) hint.remove();

  const recordBtn = document.getElementById('record-btn');
  if (recordBtn) recordBtn.disabled = true;

  const q = interview.questions[currentQ];

  // ── Step 3: 3-2-1 countdown → start recording ────────────────
  function beginCountdown() {
    let count = 3;
    showOverlay(`
      <div class="countdown-overlay" id="countdown-overlay">
        <div class="countdown-number" id="countdown-num">${count}</div>
        <div class="countdown-label">Get ready…</div>
      </div>`);

    const tick = setInterval(() => {
      count--;
      const numEl = document.getElementById('countdown-num');
      if (!numEl) return clearInterval(tick);
      if (count <= 0) {
        clearInterval(tick);
        clearOverlay();
        startRecording();
      } else {
        numEl.textContent = count;
      }
    }, 1000);
  }

  // ── Step 1: think time (optional) → then read + countdown ──────
  function beginThinkTime(onDone) {
    const thinkSecs = q.thinkTime || 0;
    if (!thinkSecs) { onDone(); return; }

    let remaining = thinkSecs;
    showOverlay(`
      <div class="countdown-overlay" id="countdown-overlay">
        <div style="font-size:28px;margin-bottom:6px">💭</div>
        <div class="countdown-number" id="think-num">${remaining}</div>
        <div class="countdown-label">Think time — prepare your answer</div>
      </div>`);

    const tick = setInterval(() => {
      remaining--;
      const el = document.getElementById('think-num');
      if (!el) { clearInterval(tick); return; }
      if (remaining <= 0) {
        clearInterval(tick);
        clearOverlay();
        onDone();
      } else {
        el.textContent = remaining;
      }
    }, 1000);
  }

  // ── Step 2: read question aloud, then countdown ───────────────
  function startTTS() {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();

      showOverlay(`
        <div class="countdown-overlay" id="countdown-overlay">
          <div style="font-size:36px;margin-bottom:8px">🔊</div>
          <div class="countdown-label">Reading question…</div>
        </div>`);

      // Pick the best available recruiter-style voice.
      // Preference order: Windows Neural Online → Google Neural → macOS natural → any en-US
      function pickVoice(voices) {
        const tests = [
          v => /\bonline\b/i.test(v.name) && /en[-_]US/i.test(v.lang),
          v => /\bonline\b/i.test(v.name) && v.lang.startsWith('en'),
          v => /google.*us.*english|google.*english.*us/i.test(v.name),
          v => /google/i.test(v.name) && v.lang.startsWith('en'),
          v => /\b(samantha|alex|karen|daniel|moira|kate|victoria)\b/i.test(v.name),
          v => /en[-_]US/i.test(v.lang),
          v => v.lang.startsWith('en'),
        ];
        for (const t of tests) {
          const m = voices.find(t);
          if (m) return m;
        }
        return null;
      }

      function doSpeak(voice) {
        const numWords = ['one','two','three','four','five','six','seven','eight','nine','ten'];
        const qNum = numWords[currentQ] || String(currentQ + 1);
        const utt = new SpeechSynthesisUtterance(
          `Question number ${qNum}... ${q.text || ''}`
        );
        if (voice) utt.voice = voice;
        utt.rate   = 0.88;
        utt.pitch  = 0.95;
        utt.volume = 1;
        utt.onend   = () => beginCountdown();
        utt.onerror = () => beginCountdown();
        window.speechSynthesis.speak(utt);
      }

      const voices = window.speechSynthesis.getVoices();
      if (voices.length) {
        doSpeak(pickVoice(voices));
      } else {
        window.speechSynthesis.onvoiceschanged = () => {
          window.speechSynthesis.onvoiceschanged = null;
          doSpeak(pickVoice(window.speechSynthesis.getVoices()));
        };
        setTimeout(() => {
          if (document.getElementById('countdown-num')) return;
          window.speechSynthesis.cancel();
          beginCountdown();
        }, 2000);
      }
    } else {
      beginCountdown();
    }
  }

  // Run think time first (if set), then TTS → 3-2-1 → record
  beginThinkTime(startTTS);
}

function startRecording() {
  const q = interview.questions[currentQ];
  chunks = [];

  recorder = new MediaRecorder(canvasStream || mediaStream, {
    mimeType: getSupportedMimeType(),
    videoBitsPerSecond: 2500000,   // 2.5 Mbps — good 720p quality
    audioBitsPerSecond: 128000,    // 128 kbps audio
  });
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = handleRecordingStop;
  recorder.start(1000);

  // Show timer
  timeLeft = q.duration;
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = '0%';
  const timerEl = document.getElementById('timer-overlay');
  timerEl.style.display = 'block';
  updateTimerDisplay();

  // Controls: show stop button
  document.getElementById('controls').innerHTML = `
    <div class="flex items-center gap-8">
      <span class="rec-dot"></span>
      <span style="color:var(--red);font-size:13px;font-weight:600">Recording</span>
    </div>
    <button class="btn btn-outline" onclick="stopRecording()">■ Stop Early</button>`;

  recordingTimer = setInterval(() => {
    timeLeft--;
    updateTimerDisplay();
    if (timeLeft <= 0) {
      clearInterval(recordingTimer);
      stopRecording();
    }
  }, 1000);
}

function updateTimerDisplay() {
  const el = document.getElementById('timer-overlay');
  if (!el) return;
  el.textContent = formatTime(timeLeft);
  el.className = 'timer-overlay' +
    (timeLeft <= 10 ? ' danger' : timeLeft <= 30 ? ' warning' : '');

  // Drive the recording progress bar
  const q = interview.questions[currentQ];
  const fill = document.getElementById('progress-fill');
  if (fill && q) {
    const elapsed = q.duration - timeLeft;
    fill.style.width = `${(elapsed / q.duration) * 100}%`;
  }
}

function stopRecording() {
  clearInterval(recordingTimer);
  if (recorder?.state !== 'inactive') recorder.stop();
}

async function handleRecordingStop() {
  document.getElementById('controls').innerHTML = '';

  showOverlay(`
    <div class="upload-overlay">
      <div class="spinner"></div>
      <p style="color:var(--muted);font-size:13px">Uploading your answer…</p>
    </div>`);

  const blob = new Blob(chunks, { type: getSupportedMimeType() });

  try {
    const res = await fetch(`${WORKER_URL}/api/session/${token}/upload/${currentQ}`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/webm' },
      body: blob,
    });
    if (!res.ok) throw new Error('Upload failed');
    clearOverlay();
    showAfterRecording();
  } catch {
    clearOverlay();
    showOverlay(`
      <div class="upload-overlay" style="gap:16px">
        <p style="color:var(--red)">Upload failed. Please retry.</p>
        <button class="btn btn-primary" onclick="retryUpload()">Retry</button>
      </div>`);
  }
}

async function retryUpload() {
  showOverlay(`
    <div class="upload-overlay">
      <div class="spinner"></div>
      <p style="color:var(--muted);font-size:13px">Retrying upload…</p>
    </div>`);

  const blob = new Blob(chunks, { type: getSupportedMimeType() });
  try {
    const res = await fetch(`${WORKER_URL}/api/session/${token}/upload/${currentQ}`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/webm' },
      body: blob,
    });
    if (!res.ok) throw new Error('Upload failed');
    clearOverlay();
    showAfterRecording();
  } catch {
    clearOverlay();
    showOverlay(`
      <div class="upload-overlay" style="gap:16px">
        <p style="color:var(--red)">Upload failed again. Check your connection.</p>
        <button class="btn btn-primary" onclick="retryUpload()">Retry</button>
      </div>`);
  }
}

function showAfterRecording() {
  const total = interview.questions.length;
  const isLast = currentQ === total - 1;
  const q = interview.questions[currentQ];
  const maxRetakes  = q.maxRetakes || 0;
  const usedRetakes = retakesUsed[currentQ] || 0;
  const canRetake   = usedRetakes < maxRetakes;

  document.getElementById('controls').innerHTML = `
    <p class="text-muted text-sm" style="color:var(--green)">✓ Answer saved${maxRetakes > 0 ? ` &nbsp;·&nbsp; ${maxRetakes - usedRetakes} retake${(maxRetakes - usedRetakes) !== 1 ? 's' : ''} remaining` : ''}</p>
    <div class="flex gap-8">
      ${canRetake ? `<button class="btn btn-outline" onclick="retakeAnswer()">↩ Retake</button>` : ''}
      <button class="btn btn-primary btn-lg" onclick="${isLast ? 'finishInterview()' : `showQuestion(${currentQ + 1})`}">
        ${isLast ? 'Finish Interview' : 'Next Question →'}
      </button>
    </div>`;
}

function retakeAnswer() {
  retakesUsed[currentQ] = (retakesUsed[currentQ] || 0) + 1;
  chunks = [];
  // Clear the saved state and re-enter countdown flow
  document.getElementById('controls').innerHTML = '';
  startCountdown();
}

async function finishInterview() {
  main().innerHTML = `<div class="spinner" style="margin:auto"></div>`;
  try {
    await fetch(`${WORKER_URL}/api/session/${token}/complete`, { method: 'POST' });
  } catch {}
  stopStream();
  showThankYou(false);
}

function showThankYou(alreadyDone) {
  document.getElementById('topbar-progress').textContent = '';
  main().innerHTML = `
    <div class="thankyou-screen">
      <div class="thankyou-icon">${alreadyDone ? '✅' : '🎉'}</div>
      <h1>${alreadyDone ? 'Already Submitted' : 'Thank You!'}</h1>
      <p class="mt-8">
        ${alreadyDone
          ? 'This interview has already been completed.'
          : `Your interview has been submitted, <strong>${esc(session?.candidateName || '')}</strong>. The CTI Group team will review your responses and be in touch.`}
      </p>
      <p class="mt-16 text-muted text-sm">You may now close this tab.</p>
    </div>`;
}

// ── Overlay helpers ───────────────────────────────────────────

function showOverlay(html) {
  const el = document.getElementById('overlay');
  if (el) el.innerHTML = html;
}

function clearOverlay() {
  const el = document.getElementById('overlay');
  if (el) el.innerHTML = '';
}

// ── Utilities ─────────────────────────────────────────────────

function stopStream() {
  if (segLoopId) { cancelAnimationFrame(segLoopId); segLoopId = null; }
  if (segModel) { try { segModel.close(); } catch (e) {} segModel = null; }
  bgCanvas = null; bgCtx = null; canvasStream = null;
  blurMaskCanvas = null;
  if (bgVid) { bgVid.srcObject = null; bgVid.remove(); bgVid = null; }
  mediaStream?.getTracks().forEach(t => t.stop());
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function getSupportedMimeType() {
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let toastTimer;
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
