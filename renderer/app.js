import { initViewer3D, pickProceduralShape } from './viewer3d.js';

/* ====================== STATE ====================== */
const THEMES = [
  { name: 'teal', accent: '#35f4e0', accent2: '#8ffff2', dim: '#146b64', soft: 'rgba(53,244,224,.35)' },
  { name: 'amber', accent: '#ffb23d', accent2: '#ffe2a8', dim: '#7a5312', soft: 'rgba(255,178,61,.35)' },
  { name: 'violet', accent: '#b48bff', accent2: '#e3d4ff', dim: '#4a3373', soft: 'rgba(180,139,255,.35)' },
];

const AppState = {
  listening: false,
  speaking: false,
  working: false,
  themeIndex: 0,
  log: [], // {who:'user'|'jarvis', text, time}
  conversation: [], // running chat history sent to the AI brain, in-memory only (resets on restart)
  settings: {
    fishKey: '', fishVoiceId: '17e9990aa92c4da8b09ad3f0f2231e48', fishModel: 's2.1-pro-free',
    openaiKey: '', openaiModel: 'gpt-image-1', aiModel: 'gpt-5.6-luna',
    meshyKey: '',
    googleSpeechKey: '',
    imageSearchKey: '',
    pcControlEnabled: false,
    screenControlEnabled: false,
    googleClientId: '', googleClientSecret: '', microsoftClientId: '', spotifyClientId: '',
    gmailConnected: false, gmailEmail: '',
    outlookConnected: false, outlookEmail: '',
    spotifyConnected: false, spotifyDisplayName: '',
    muted: false, wakeMode: false,
    // Third-party account hub (Nylas) - can hold many connected accounts at
    // once, unlike the single-account fields above, so this is an array.
    nylasApiKey: '', nylasClientId: '', nylasClientSecret: '', nylasApiUri: 'https://api.us.nylas.com',
    nylasGrants: [],
    // Phone calling (Twilio + ConversationRelay) - off by default.
    callingEnabled: false,
    twilioAccountSid: '', twilioAuthToken: '', twilioPhoneNumber: '', userPhoneNumber: '',
    ngrokExePath: '', ngrokAuthtoken: '', ngrokStaticDomain: '',
  },
};

const $ = (sel) => document.querySelector(sel);
const el = {
  stage: $('#stage'), canvas: $('#scene'),
  statusText: $('#statusText'), transcript: $('#transcript'),
  micBtn: $('#micBtn'), micLabel: $('#micLabel'),
  helpBtn: $('#helpBtn'), infoBtn: $('#infoBtn'),
  historyBtn: $('#historyBtn'), shareBtn: $('#shareBtn'),
  settingsBtn: $('#settingsBtn'), themeBtn: $('#themeBtn'),
  typeDockBtn: $('#typeDockBtn'), searchDockBtn: $('#searchDockBtn'), muteDockBtn: $('#muteDockBtn'),
  overlay: $('#overlay'),
  settingsPanel: $('#settingsPanel'), historyPanel: $('#historyPanel'),
  helpPanel: $('#helpPanel'), typePanel: $('#typePanel'), resultPanel: $('#resultPanel'),
  logList: $('#logList'),
  fishKeyInput: $('#fishKeyInput'), fishVoiceInput: $('#fishVoiceInput'), fishModelInput: $('#fishModelInput'),
  openaiKeyInput: $('#openaiKeyInput'), openaiModelInput: $('#openaiModelInput'), aiModelInput: $('#aiModelInput'),
  meshyKeyInput: $('#meshyKeyInput'),
  googleSpeechKeyInput: $('#googleSpeechKeyInput'),
  imageSearchKeyInput: $('#imageSearchKeyInput'),
  pcControlSwitch: $('#pcControlSwitch'),
  screenControlSwitch: $('#screenControlSwitch'),
  googleClientIdInput: $('#googleClientIdInput'), googleClientSecretInput: $('#googleClientSecretInput'),
  microsoftClientIdInput: $('#microsoftClientIdInput'), spotifyClientIdInput: $('#spotifyClientIdInput'),
  connectGmailBtn: $('#connectGmailBtn'), gmailStatus: $('#gmailStatus'),
  connectOutlookBtn: $('#connectOutlookBtn'), outlookStatus: $('#outlookStatus'),
  connectSpotifyBtn: $('#connectSpotifyBtn'), spotifyStatus: $('#spotifyStatus'),
  nylasApiKeyInput: $('#nylasApiKeyInput'), nylasClientIdInput: $('#nylasClientIdInput'),
  nylasApiUriInput: $('#nylasApiUriInput'), connectNylasBtn: $('#connectNylasBtn'),
  nylasGrantsList: $('#nylasGrantsList'),
  callingSwitch: $('#callingSwitch'), callingStatus: $('#callingStatus'),
  twilioAccountSidInput: $('#twilioAccountSidInput'), twilioAuthTokenInput: $('#twilioAuthTokenInput'),
  twilioPhoneNumberInput: $('#twilioPhoneNumberInput'), userPhoneNumberInput: $('#userPhoneNumberInput'),
  ngrokExePathInput: $('#ngrokExePathInput'), ngrokAuthtokenInput: $('#ngrokAuthtokenInput'),
  ngrokStaticDomainInput: $('#ngrokStaticDomainInput'),
  testVoiceBtn: $('#testVoiceBtn'),
  wakeSwitch: $('#wakeSwitch'), muteSwitch: $('#muteSwitch'),
  voiceStatusHint: $('#voiceStatusHint'),
  typeInput: $('#typeInput'), typeSendBtn: $('#typeSendBtn'),
  clearLogBtn: $('#clearLogBtn'),
  resultTitle: $('#resultTitle'), resultSubtitle: $('#resultSubtitle'),
  resultText: $('#resultText'), resultImage: $('#resultImage'),
  result3dWrap: $('#result3dWrap'), result3dCanvas: $('#result3dCanvas'), result3dProgress: $('#result3dProgress'),
  resultImageGrid: $('#resultImageGrid'), resultEmailList: $('#resultEmailList'),
  resultComputerWrap: $('#resultComputerWrap'), resultComputerShot: $('#resultComputerShot'),
  resultComputerStep: $('#resultComputerStep'), resultComputerStatus: $('#resultComputerStatus'),
  resultSaveBtn: $('#resultSaveBtn'), resultLinkBtn: $('#resultLinkBtn'), resultStopBtn: $('#resultStopBtn'),
};

function applyTheme(i) {
  AppState.themeIndex = ((i % THEMES.length) + THEMES.length) % THEMES.length;
  const t = THEMES[AppState.themeIndex];
  const r = document.documentElement.style;
  r.setProperty('--accent', t.accent);
  r.setProperty('--accent-2', t.accent2);
  r.setProperty('--accent-dim', t.dim);
  r.setProperty('--accent-soft', t.soft);
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function suggestFileName(prompt, ext) {
  const slug = String(prompt).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'rex';
  return `${slug}.${ext}`;
}

/* ====================== VISUALIZER ====================== */
const ctx = el.canvas.getContext('2d');
let cw = 0, ch = 0, dpr = 1, cx = 0, cy = 0, baseR = 0;

function sizeCanvas() {
  const size = Math.max(240, Math.min(el.stage.clientWidth, el.stage.clientHeight) * 0.86);
  dpr = window.devicePixelRatio || 1;
  el.canvas.style.width = size + 'px';
  el.canvas.style.height = size + 'px';
  el.canvas.width = size * dpr;
  el.canvas.height = size * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cw = size; ch = size; cx = size / 2; cy = size / 2; baseR = size * 0.46;
}
window.addEventListener('resize', sizeCanvas);

const PARTICLE_COUNT = 140;
const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
  angle: (i / PARTICLE_COUNT) * Math.PI * 2, phase: Math.random() * Math.PI * 2,
  speed: 0.6 + Math.random() * 0.8, r: 0.9 + Math.random() * 0.9,
}));

const BAR_COUNT = 72;
const bars = Array.from({ length: BAR_COUNT }, (_, i) => ({
  angle: (i / BAR_COUNT) * Math.PI * 2, phase: Math.random() * Math.PI * 2, smooth: 0,
}));

function buildSphereLines() {
  const lines = [];
  const LONG = 9, LAT = 5, SEG = 36;
  for (let a = 0; a < LONG; a++) {
    const lon = (a / LONG) * Math.PI * 2;
    const pts = [];
    for (let s = 0; s <= SEG; s++) {
      const t = (s / SEG) * Math.PI - Math.PI / 2;
      pts.push([Math.cos(t) * Math.cos(lon), Math.sin(t), Math.cos(t) * Math.sin(lon)]);
    }
    lines.push(pts);
  }
  for (let a = 1; a < LAT; a++) {
    const t = (a / LAT) * Math.PI - Math.PI / 2;
    const rad = Math.cos(t), y = Math.sin(t);
    const pts = [];
    for (let s = 0; s <= SEG; s++) {
      const lon = (s / SEG) * Math.PI * 2;
      pts.push([rad * Math.cos(lon), y, rad * Math.sin(lon)]);
    }
    lines.push(pts);
  }
  return lines;
}
const sphereLines = buildSphereLines();
let sphereRotY = 0;

function rotatePoint(p, ry, rx) {
  const [x, y, z] = p;
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  const x1 = x * cosY + z * sinY;
  const z1 = -x * sinY + z * cosY;
  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const y1 = y * cosX - z1 * sinX;
  const z2 = y * sinX + z1 * cosX;
  return [x1, y1, z2];
}

let audioCtxRef = null, micAnalyser = null, micData = null, outAnalyser = null, outData = null;

async function ensureMicAudioGraph() {
  if (micAnalyser) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtxRef = audioCtxRef || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtxRef.state === 'suspended') await audioCtxRef.resume();
    const src = audioCtxRef.createMediaStreamSource(stream);
    micAnalyser = audioCtxRef.createAnalyser();
    micAnalyser.fftSize = 256;
    micAnalyser.smoothingTimeConstant = 0.6;
    micData = new Uint8Array(micAnalyser.frequencyBinCount);
    src.connect(micAnalyser);
    return true;
  } catch (err) {
    console.warn('Mic access failed:', err);
    return false;
  }
}
function ensureOutputAnalyser(audioEl) {
  audioCtxRef = audioCtxRef || new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtxRef.createMediaElementSource(audioEl);
  outAnalyser = audioCtxRef.createAnalyser();
  outAnalyser.fftSize = 256;
  outAnalyser.smoothingTimeConstant = 0.55;
  outData = new Uint8Array(outAnalyser.frequencyBinCount);
  src.connect(outAnalyser);
  outAnalyser.connect(audioCtxRef.destination);
}
function sampleBars(analyser, data, n) {
  if (!analyser || !data) return null;
  analyser.getByteFrequencyData(data);
  const out = new Array(n);
  const bucket = Math.floor(data.length / n) || 1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < bucket; j++) s += data[i * bucket + j] || 0;
    out[i] = s / bucket / 255;
  }
  return out;
}

function draw(t) {
  requestAnimationFrame(draw);
  if (!cw) return;
  ctx.clearRect(0, 0, cw, ch);

  const theme = THEMES[AppState.themeIndex];
  const time = t / 1000;
  const active = AppState.listening || AppState.speaking || AppState.working;
  const micBars = AppState.listening ? sampleBars(micAnalyser, micData, BAR_COUNT) : null;
  const outBars = AppState.speaking ? sampleBars(outAnalyser, outData, BAR_COUNT) : null;

  ctx.save();
  ctx.translate(cx, cy);
  const rot1 = time * 0.05;
  for (const p of particles) {
    const jig = Math.sin(time * p.speed + p.phase) * 3.2;
    const rr = baseR + jig;
    const a = p.angle + rot1;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    ctx.beginPath();
    ctx.arc(x, y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = theme.accent;
    ctx.globalAlpha = (active ? 0.75 : 0.4) * (0.5 + 0.5 * Math.sin(time * 1.3 + p.phase));
    ctx.shadowColor = theme.accent;
    ctx.shadowBlur = 6;
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 10]);
  ctx.lineDashOffset = -time * 22;
  ctx.beginPath(); ctx.arc(0, 0, baseR * 0.87, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([1, 7]);
  ctx.lineDashOffset = time * 30;
  ctx.beginPath(); ctx.arc(0, 0, baseR * 0.63, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  const rBase = baseR * 0.63;
  for (let i = 0; i < BAR_COUNT; i++) {
    const b = bars[i];
    let level;
    if (micBars) level = micBars[i];
    else if (outBars) level = outBars[i];
    else level = 0.14 + 0.1 * Math.sin(time * 1.6 + b.phase);
    b.smooth += (level - b.smooth) * 0.35;
    const len = 6 + b.smooth * 46;
    const a = b.angle + time * 0.02;
    const x1 = Math.cos(a) * rBase, y1 = Math.sin(a) * rBase;
    const x2 = Math.cos(a) * (rBase + len), y2 = Math.sin(a) * (rBase + len);
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = active ? '#ffffff' : theme.accent;
    ctx.globalAlpha = active ? 0.85 : 0.5;
    ctx.lineWidth = 2;
    ctx.shadowColor = theme.accent;
    ctx.shadowBlur = active ? 10 : 4;
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  const sphereR = baseR * 0.34;
  sphereRotY += 0.0032 + (active ? 0.004 : 0);
  const tilt = 0.55;

  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, sphereR * 1.6);
  grad.addColorStop(0, theme.soft);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.arc(0, 0, sphereR * 1.6, 0, Math.PI * 2); ctx.fill();

  for (const line of sphereLines) {
    ctx.beginPath();
    for (let i = 0; i < line.length; i++) {
      const rp = rotatePoint(line[i], sphereRotY, tilt);
      const scale = (rp[2] + 2) / 3;
      const x = rp[0] * sphereR * scale, y = rp[1] * sphereR * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = theme.accent2;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.8;
    ctx.shadowColor = theme.accent;
    ctx.shadowBlur = 5;
    ctx.stroke();
  }

  const pulse = active ? 0.7 + 0.3 * Math.sin(time * 8) : 0.5 + 0.15 * Math.sin(time * 1.2);
  ctx.beginPath();
  ctx.arc(0, 0, sphereR * 0.22 * pulse, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.85;
  ctx.shadowColor = theme.accent;
  ctx.shadowBlur = 20;
  ctx.fill();
  ctx.restore();

  ctx.globalAlpha = 1;
}

/* ====================== RESULT POPUP (long answers / images / 3D) ====================== */
let active3DHandle = null;
let activeMeshySubscription = null;
let currentResultSave = null;
let currentResultUrl = null;

function closeResultPopup() {
  if (active3DHandle) { try { active3DHandle.dispose(); } catch (e) {} active3DHandle = null; }
  if (activeMeshySubscription) { activeMeshySubscription(); activeMeshySubscription = null; }
}

function buildEmailRow(m) {
  const row = document.createElement('div');
  row.className = 'email-row' + (m.unread ? ' unread' : '');
  const subj = document.createElement('div'); subj.className = 'email-subject'; subj.textContent = m.subject || '(no subject)';
  const from = document.createElement('div'); from.className = 'email-from'; from.textContent = [m.account, m.from].filter(Boolean).join(' · ');
  const snip = document.createElement('div'); snip.className = 'email-snippet'; snip.textContent = m.snippet || '';
  row.appendChild(subj); row.appendChild(from); row.appendChild(snip);
  return row;
}

function openResultPopup({ type, title, subtitle, text, imageUrl, shapeSpec, saveName, sourceUrl, images, emailItems }) {
  closeResultPopup();

  el.resultTitle.textContent = title || 'RESPONSE';
  el.resultSubtitle.textContent = subtitle || '';
  el.resultText.hidden = true;
  el.resultImage.hidden = true;
  el.result3dWrap.hidden = true;
  el.result3dProgress.hidden = true;
  el.resultImageGrid.hidden = true;
  el.resultImageGrid.innerHTML = '';
  el.resultEmailList.hidden = true;
  el.resultEmailList.innerHTML = '';
  el.resultComputerWrap.hidden = true;
  el.resultComputerShot.hidden = true;
  el.resultSaveBtn.hidden = true;
  el.resultLinkBtn.hidden = true;
  el.resultStopBtn.hidden = true;
  currentResultSave = null;
  currentResultUrl = sourceUrl || null;

  if (type === 'text') {
    el.resultText.hidden = false;
    el.resultText.textContent = text || '';
  }
  if (type === 'image') {
    el.resultImage.hidden = false;
    el.resultImage.src = imageUrl;
    el.resultSaveBtn.hidden = false;
    currentResultSave = { kind: 'image', dataUrl: imageUrl, name: saveName || 'rex-image.png' };
  }
  if (type === 'image-grid') {
    el.resultImageGrid.hidden = false;
    for (const im of images || []) {
      const fig = document.createElement('button');
      fig.type = 'button';
      fig.className = 'grid-thumb';
      fig.title = im.title || 'Open image';
      const img = document.createElement('img');
      img.src = im.thumbnail || im.url;
      img.alt = im.title || '';
      img.loading = 'lazy';
      fig.appendChild(img);
      fig.addEventListener('click', () => window.jarvis.openExternal(im.url));
      el.resultImageGrid.appendChild(fig);
    }
  }
  if (type === 'email-list') {
    el.resultEmailList.hidden = false;
    if (!emailItems || !emailItems.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No messages to show.';
      el.resultEmailList.appendChild(empty);
    } else {
      for (const m of emailItems) el.resultEmailList.appendChild(buildEmailRow(m));
    }
  }
  if (type === '3d-procedural') {
    el.result3dWrap.hidden = false;
    requestAnimationFrame(() => { active3DHandle = initViewer3D(el.result3dCanvas, shapeSpec); });
  }
  if (type === '3d-meshy-loading') {
    el.result3dWrap.hidden = false;
    el.result3dProgress.hidden = false;
    el.result3dProgress.innerHTML = '<div class="spinner-ring"></div><div id="meshyProgressLabel">Starting&hellip;</div>';
  }
  if (type === 'computer') {
    el.resultComputerWrap.hidden = false;
    el.resultComputerStep.textContent = '';
    el.resultComputerStatus.textContent = 'Starting…';
    el.resultStopBtn.hidden = false;
  }
  if (sourceUrl) el.resultLinkBtn.hidden = false;

  openPanel(el.resultPanel);
}

function updateMeshyProgress(data) {
  const label = document.getElementById('meshyProgressLabel');
  if (!label) return;
  if (data.stage === 'creating') label.textContent = 'Creating task…';
  else if (data.stage === 'polling') label.textContent = `Building… ${data.progress || 0}%`;
  else if (data.stage === 'downloading') label.textContent = 'Downloading model…';
}

async function mountMeshyViewer(arrayBuffer, prompt, glbBase64) {
  el.result3dProgress.hidden = true;
  try {
    const { initMeshyViewer } = await import('./meshyViewer.js');
    const handle = initMeshyViewer(el.result3dCanvas, arrayBuffer);
    active3DHandle = handle;
    el.resultSaveBtn.hidden = false;
    currentResultSave = { kind: '3d', base64: glbBase64, name: suggestFileName(prompt, 'glb') };
    await handle.ready;
  } catch (err) {
    console.error('3D model view failed', err);
    showMeshyFallback(prompt, glbBase64, "Couldn't display this model in-app (three.js may not have installed correctly - try running the install step again). You can still save the file below and open it elsewhere.");
  }
}
function showMeshyFallback(prompt, glbBase64, message) {
  closeResultPopup();
  el.result3dWrap.hidden = true;
  el.resultText.hidden = false;
  el.resultText.textContent = message;
  el.resultSaveBtn.hidden = false;
  currentResultSave = { kind: '3d', base64: glbBase64, name: suggestFileName(prompt, 'glb') };
}

/* ====================== SPEECH RECOGNITION + COMMANDS ====================== */
const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognitionSupported = !!SRClass;
let recognition = null;
let manualStop = false;
let interimLineEl = null;

if (recognitionSupported) {
  recognition = new SRClass();
  recognition.lang = 'en-GB';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t; else interim += t;
    }
    if (interim) showInterim(interim);
    if (final) { clearInterim(); onFinalTranscript(final.trim()); }
  };
  recognition.onerror = (e) => {
    console.warn('recognition error', e.error);
    clearInterim();
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      addLine('sys', 'Microphone access was blocked. Allow the microphone permission for this app and try again.');
    } else if (e.error === 'network') {
      addLine('sys', 'Voice input needs a Google Speech API key in this build (Setup → Advanced) — see the README. Use the keyboard icon to type commands in the meantime.');
      openPanel(el.typePanel);
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      addLine('sys', 'Speech recognition error: ' + e.error);
    }
  };
  recognition.onend = () => {
    clearInterim();
    setListening(false);
    if (AppState.settings.wakeMode && !manualStop) {
      setTimeout(() => { if (AppState.settings.wakeMode && !AppState.listening) startListening(); }, 250);
    }
  };
}

function setListening(isOn) {
  AppState.listening = isOn;
  el.micBtn.classList.toggle('listening', isOn);
  el.statusText.textContent = isOn ? 'LISTENING ON' : 'LISTENING OFF';
  el.statusText.classList.toggle('live', isOn);
  el.micLabel.textContent = isOn ? 'STOP' : 'TALK';
}
function setWorking(isOn) {
  AppState.working = isOn;
  el.micBtn.classList.toggle('working', isOn);
}

async function startListening() {
  if (!recognitionSupported) {
    addLine('sys', "Speech recognition isn't supported in this build. Use the keyboard icon to type a command.");
    openPanel(el.typePanel);
    return;
  }
  manualStop = false;
  const ok = await ensureMicAudioGraph();
  if (!ok) {
    addLine('sys', 'Could not access your microphone. Check the permission prompt or your system privacy settings, then try again.');
    return;
  }
  try { recognition.start(); setListening(true); } catch (err) { /* already started */ }
}
function stopListening() {
  manualStop = true;
  if (recognition) { try { recognition.stop(); } catch (e) {} }
  setListening(false);
}

function onFinalTranscript(text) {
  // No wake-word gate: whatever comes back from speech recognition is acted
  // on directly, whether always-listening is on or this is a one-off Talk
  // click - see the ALWAYS-LISTENING hint in index.html for the trade-off.
  addLine('user', text);
  handleUserUtterance(text);
}

const SITE_MAP = {
  youtube: 'https://youtube.com', gmail: 'https://mail.google.com', google: 'https://google.com',
  github: 'https://github.com', maps: 'https://maps.google.com', 'google maps': 'https://maps.google.com',
  netflix: 'https://netflix.com', amazon: 'https://amazon.com', wikipedia: 'https://wikipedia.org',
  twitter: 'https://x.com', x: 'https://x.com', reddit: 'https://reddit.com', spotify: 'https://open.spotify.com',
  news: 'https://news.google.com', weather: 'https://weather.com',
};

function handleCommand(raw) {
  const cmd = raw.toLowerCase().trim().replace(/[.!?]+$/, '');
  if (!cmd) return;

  if (/^(hi|hello|hey)\b/.test(cmd) && cmd.length < 20) {
    respond(pick(['Hello, sir. How can I help?', 'At your service.', 'Good to hear from you.']));
    return;
  }
  if (/what('?s| is) the time|current time|what time is it/.test(cmd)) {
    respond(`It's ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, sir.`);
    return;
  }
  if (/what('?s| is) the date|today'?s date|what day is it/.test(cmd)) {
    respond(`Today is ${new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`);
    return;
  }
  if (/^(mute|be quiet|stop talking|silence|shut up)\b/.test(cmd)) {
    setMuted(true); addLine('jarvis', '(voice muted)'); return;
  }
  if (/^(unmute|speak up|voice on)\b/.test(cmd)) {
    setMuted(false); respond('Voice restored, sir.'); return;
  }
  if (/^(stop|cancel|never mind)$/.test(cmd)) { stopSpeaking(); return; }
  if (/what can you do|^help$|help me\b/.test(cmd)) {
    respond('I can search the web, generate images, build 3D models, tell you the time and date, open websites, and mute or unmute myself. Just ask.');
    return;
  }

  // 3D model requests - check before the image pattern (both can start with "generate")
  let m = cmd.match(/^(?:generate|create|make|build|render|show me)\s+(?:me\s+)?(?:an?\s+)?3d\s*(?:model|shape|object)?\s*(?:of\s+)?(.+)/);
  if (m) { generate3DModel(m[1].trim()); return; }

  // image requests
  m = cmd.match(/^(?:generate|create|make|draw|paint|imagine)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|drawing|painting)\s*(?:of\s+)?(.+)/);
  if (!m) m = cmd.match(/^draw\s+(?:me\s+)?(.+)/);
  if (m) { generateImage(m[1].trim()); return; }

  m = cmd.match(/^(?:open|go to|launch|take me to)\s+(.+)/);
  if (m) { openWebsite(m[1].trim()); return; }

  m = cmd.match(/^(?:search(?: the web)?(?: for)?|google|look up|find)\s+(.+)/);
  if (m) { webSearch(m[1].trim()); return; }

  m = cmd.match(/^(?:what is|what's|who is|who's|define|tell me about)\s+(.+)/);
  if (m) { webSearch(m[1].trim()); return; }

  webSearch(cmd); // fallback: treat the whole utterance as a search query
}

function openWebsite(name) {
  const key = name.toLowerCase().replace(/^(the|my)\s+/, '').trim();
  let url = SITE_MAP[key];
  if (!url && /^[\w-]+(\.[\w-]+)+/.test(key)) url = key.startsWith('http') ? key : `https://${key}`;
  if (url) {
    respond(`Opening ${name}, sir.`);
    window.jarvis.openExternal(url);
  } else {
    webSearch(name);
  }
}

/* ---- transcript UI ---- */
function showInterim(text) {
  if (!interimLineEl) {
    interimLineEl = document.createElement('div');
    interimLineEl.className = 'line user';
    interimLineEl.style.opacity = '0.55';
    el.transcript.appendChild(interimLineEl);
  }
  interimLineEl.textContent = '“' + text + '”';
  el.transcript.parentElement.scrollTop = el.transcript.parentElement.scrollHeight;
}
function clearInterim() { if (interimLineEl) { interimLineEl.remove(); interimLineEl = null; } }

function addLine(who, text) {
  const line = document.createElement('div');
  line.className = 'line ' + who;
  line.textContent = who === 'user' ? '“' + text + '”' : text;
  el.transcript.appendChild(line);
  trimTranscript();
  el.transcript.parentElement.scrollTop = el.transcript.parentElement.scrollHeight;
  if (who === 'user') logEntry(who, text);
}
function addSourceLink(url, label) {
  const wrap = document.createElement('div');
  wrap.className = 'line sys';
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = label || 'source: ' + url;
  a.addEventListener('click', (e) => { e.preventDefault(); window.jarvis.openExternal(url); });
  wrap.appendChild(a);
  el.transcript.appendChild(wrap);
  trimTranscript();
  el.transcript.parentElement.scrollTop = el.transcript.parentElement.scrollHeight;
}
function trimTranscript() {
  while (el.transcript.children.length > 6) el.transcript.removeChild(el.transcript.firstChild);
}

/* ====================== WEB SEARCH ====================== */
async function webSearch(query) {
  if (!query) return;
  addLine('sys', `Searching the web for “${query}”…`);
  const res = await window.jarvis.search(query);
  if (res.ok && res.answer) {
    respond(res.answer, { subtitle: query });
    if (res.sourceUrl) addSourceLink(res.sourceUrl, 'source: ' + res.sourceUrl);
    return;
  }
  const gurl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  respond(`I couldn't get a quick spoken answer for that, so here's a link to search results for “${query}”, sir.`, { subtitle: query });
  addSourceLink(gurl, 'open search results');
}

/* ====================== IMAGE GENERATION ====================== */
async function generateImage(prompt) {
  if (!AppState.settings.openaiKey) {
    respond("I don't have an OpenAI API key yet, sir. Add one in Setup to generate images.");
    return;
  }
  addLine('sys', `Generating an image of “${prompt}”…`);
  setWorking(true);
  const res = await window.jarvis.image.generate(prompt, {
    key: AppState.settings.openaiKey, model: AppState.settings.openaiModel,
  });
  setWorking(false);
  if (!res.ok) {
    addLine('sys', `Image generation failed: ${res.error}`);
    respond("I couldn't create that image, sir.");
    return;
  }
  respond('Here’s what I created, sir.', { noPopup: true });
  openResultPopup({
    type: 'image', title: 'GENERATED IMAGE', subtitle: `“${prompt}”`,
    imageUrl: res.dataUrl, saveName: suggestFileName(prompt, 'png'),
  });
}

/* ====================== 3D MODEL GENERATION ====================== */
let currentMeshyToken = null;

function generate3DModel(prompt) {
  if (AppState.settings.meshyKey) generateMeshyModel(prompt);
  else generateProceduralModel(prompt);
}
function generateProceduralModel(prompt) {
  const shape = pickProceduralShape(prompt);
  respond(`Rendering a procedural model for “${prompt}”, sir.`, { noPopup: true });
  openResultPopup({
    type: '3d-procedural', title: '3D MODEL (PROCEDURAL)', subtitle: `“${prompt}” · ${shape.type}`,
    shapeSpec: shape,
  });
}
function generateMeshyModel(prompt) {
  const token = Math.random().toString(36).slice(2);
  currentMeshyToken = token;

  addLine('sys', `Asking Meshy AI to build a 3D model of “${prompt}”… this can take a few minutes.`);
  respond(`Starting a real 3D build for “${prompt}”, sir. This will take a few minutes.`, { noPopup: true });
  openResultPopup({ type: '3d-meshy-loading', title: '3D MODEL (MESHY AI)', subtitle: `“${prompt}”` });

  if (activeMeshySubscription) { activeMeshySubscription(); activeMeshySubscription = null; }
  activeMeshySubscription = window.jarvis.model3d.onProgress(async (data) => {
    if (data.token !== token || token !== currentMeshyToken) return;
    updateMeshyProgress(data);
    if (data.stage === 'done') {
      activeMeshySubscription && activeMeshySubscription();
      activeMeshySubscription = null;
      const bytes = Uint8Array.from(atob(data.glbBase64), (c) => c.charCodeAt(0));
      mountMeshyViewer(bytes.buffer, prompt, data.glbBase64);
    } else if (data.stage === 'error') {
      activeMeshySubscription && activeMeshySubscription();
      activeMeshySubscription = null;
      addLine('sys', `Meshy AI failed: ${data.error}`);
      respond(`The real 3D build failed, sir: ${data.error}. Here's a procedural model instead.`, { noPopup: true });
      generateProceduralModel(prompt);
    }
  });
  window.jarvis.model3d.generateMeshy(prompt, { key: AppState.settings.meshyKey, token });
}

/* ====================== AI BRAIN (natural language + memory + tools) ======================
   When an OpenAI key is set, every utterance goes here instead of the fixed-phrase
   parser above: main.js runs a real tool-calling loop and returns a short natural
   reply plus any structured "actions" (search results, images, 3D models, email,
   music) for the HUD to render. AppState.conversation is the running memory that
   makes follow-up questions work. */

function hasVisualAction(actions) {
  // Anything that unconditionally opens its own result popup via applyAction
  // belongs here - otherwise a reply over 220 chars makes respond() open a
  // second, generic text popup right on top of it (see respond()), clobbering
  // the one applyAction just opened. call_started/call_action don't open a
  // popup themselves, so they're deliberately left out. web_search is its
  // own special case: applyAction only opens a popup for it when
  // action.answer is present - a plain type check here (ignoring that
  // condition) would wrongly set noPopup:true for a search with no answer,
  // silently losing respond()'s own popup for a long reply with nothing
  // else on screen to protect.
  return (actions || []).some((a) => {
    if (a.type === 'web_search') return !!a.answer;
    return ['image_gen', 'image_search', '3d_procedural', '3d_meshy_started', 'email_check', 'computer_task_result', 'calendar_check'].includes(a.type);
  });
}

function openMeshyLoadingPopup(prompt, taskId) {
  addLine('sys', `Asking Meshy AI to build a 3D model of “${prompt}”… this can take a few minutes.`);
  openResultPopup({ type: '3d-meshy-loading', title: '3D MODEL (MESHY AI)', subtitle: `“${prompt}”` });
  if (activeMeshySubscription) { activeMeshySubscription(); activeMeshySubscription = null; }
  activeMeshySubscription = window.jarvis.model3d.onProgress((data) => {
    if (data.token !== taskId) return;
    updateMeshyProgress(data);
    if (data.stage === 'done') {
      activeMeshySubscription && activeMeshySubscription();
      activeMeshySubscription = null;
      const bytes = Uint8Array.from(atob(data.glbBase64), (c) => c.charCodeAt(0));
      mountMeshyViewer(bytes.buffer, prompt, data.glbBase64);
    } else if (data.stage === 'error') {
      activeMeshySubscription && activeMeshySubscription();
      activeMeshySubscription = null;
      addLine('sys', `Meshy AI failed: ${data.error}`);
      respond(`The real 3D build failed, sir: ${data.error}. Here's a procedural model instead.`, { noPopup: true });
      generateProceduralModel(prompt);
    }
  });
}

function openEmailPopup(action) {
  const items = [];
  if (action.gmail) items.push(...action.gmail.map((m) => ({ ...m, account: 'Gmail' })));
  if (action.outlook) items.push(...action.outlook.map((m) => ({ ...m, account: 'Outlook' })));
  if (action.nylas) items.push(...action.nylas); // already carries its own per-grant m.account (the connected email)
  items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const errParts = [];
  if (action.gmailError) errParts.push('Gmail: ' + action.gmailError);
  if (action.outlookError) errParts.push('Outlook: ' + action.outlookError);
  if (action.nylasError) errParts.push('Other accounts: ' + action.nylasError);
  openResultPopup({
    type: 'email-list', title: 'INBOX',
    subtitle: items.length ? `${items.length} recent message${items.length === 1 ? '' : 's'}` : (errParts.join(' · ') || 'No messages'),
    emailItems: items,
  });
  if (errParts.length) addLine('sys', errParts.join(' · '));
}

function openCalendarPopup(action) {
  const events = action.events || [];
  const lines = events.map((e) => `${e.when || '(no time given)'} — ${e.title}${e.location ? ' @ ' + e.location : ''} (${e.account})`);
  openResultPopup({
    type: 'text', title: 'UPCOMING EVENTS',
    subtitle: events.length ? `${events.length} event${events.length === 1 ? '' : 's'} in the next two weeks` : 'No upcoming events',
    text: lines.join('\n') || 'Nothing on the calendar in the next two weeks.',
  });
  if (action.errors && action.errors.length) addLine('sys', action.errors.join(' · '));
}

function openComputerPopup(task) {
  addLine('sys', `Taking control of the screen: “${task}”…`);
  openResultPopup({ type: 'computer', title: 'SCREEN & INPUT CONTROL', subtitle: `“${task}”` });
}

function describeComputerAction(a) {
  if (a.action === 'left_click') return 'Clicking';
  if (a.action === 'double_click') return 'Double-clicking';
  if (a.action === 'right_click') return 'Right-clicking';
  if (a.action === 'move') return 'Moving the mouse';
  if (a.action === 'type_text') return `Typing “${a.text || ''}”`;
  if (a.action === 'key') return `Pressing ${a.text || ''}`;
  if (a.action === 'wait') return 'Waiting a moment';
  return a.action || 'Working';
}

// Fed by main.js's live 'computer:progress' stream while a computer_task
// runs - updates the popup in place (including the actual screenshot Rex
// is looking at) so nothing about what it's doing on your PC is hidden.
function updateComputerProgress(data) {
  if (!data) return;
  const focusNote = data.focusTitle ? ` (focused: “${data.focusTitle}”)` : '';
  if (data.stage === 'thinking') {
    if (data.screenshotDataUrl) { el.resultComputerShot.hidden = false; el.resultComputerShot.src = data.screenshotDataUrl; }
    el.resultComputerStep.textContent = `STEP ${data.step} / ${data.maxSteps}`;
    el.resultComputerStatus.textContent = 'Looking at the screen…' + focusNote;
  } else if (data.stage === 'acting') {
    el.resultComputerStep.textContent = `STEP ${data.step} / ${data.maxSteps}`;
    el.resultComputerStatus.textContent = describeComputerAction(data) + (data.reasoning ? ` — ${data.reasoning}` : '') + focusNote;
  } else if (data.stage === 'action_failed') {
    el.resultComputerStatus.textContent = `That step failed (${data.error}) — trying to recover…`;
  } else if (data.stage === 'done') {
    el.resultComputerStep.textContent = `FINISHED — ${data.step} step${data.step === 1 ? '' : 's'}`;
    el.resultComputerStatus.textContent = data.summary || 'Done.';
    el.resultStopBtn.hidden = true;
  } else if (data.stage === 'gave_up') {
    el.resultComputerStep.textContent = `STOPPED — ${data.step} step${data.step === 1 ? '' : 's'}`;
    el.resultComputerStatus.textContent = data.summary || "Couldn't complete that.";
    el.resultStopBtn.hidden = true;
  } else if (data.stage === 'aborted') {
    el.resultComputerStep.textContent = 'STOPPED';
    el.resultComputerStatus.textContent = 'Stopped, sir.';
    el.resultStopBtn.hidden = true;
  } else if (data.stage === 'error') {
    el.resultComputerStep.textContent = 'ERROR';
    el.resultComputerStatus.textContent = data.error || 'Something went wrong.';
    el.resultStopBtn.hidden = true;
  }
}

// Calls, like reminders, happen without the renderer asking for them - an
// inbound call can arrive at any time, and even an outbound one (started
// from a tool call in the main chat) finishes on its own schedule as a real
// live conversation Rex has separately from this chat. Both ends of a call
// are pushed here unprompted, same spirit as reminders.onFire below.
function handleCallStarted(data) {
  if (data.direction !== 'inbound') return; // outbound already gets a reply via the make_call tool result
  respond(`Incoming call from ${data.from || 'an unknown number'}, sir — I'm screening it now.`, { noPopup: true, title: 'INCOMING CALL' });
}

function formatCallTranscript(data) {
  return (data.transcript || []).map((t) => `${t.role === 'caller' ? 'Caller' : t.role === 'rex' ? 'Rex' : t.role}: ${t.text}`).join('\n') || '(no conversation was recorded)';
}

function handleCallEnded(data) {
  const mins = Math.floor((data.durationMs || 0) / 60000);
  const secs = Math.round(((data.durationMs || 0) % 60000) / 1000);
  const durText = data.durationMs > 1000 ? ` (${mins > 0 ? mins + 'm ' : ''}${secs}s)` : '';
  const who = data.direction === 'outbound' ? data.to : data.from;
  let summary;
  if (data.direction === 'outbound') {
    summary = `That call to ${who || 'the number you gave me'} has ended, sir.`;
  } else {
    const actionText = data.endedAction === 'forward' ? 'I connected them through to you.' : 'I took a message and ended the call.';
    summary = `That screened call from ${who || 'an unknown number'} has ended, sir. ${actionText}`;
  }
  respond(summary, { noPopup: true, title: 'CALL ENDED' });
  openResultPopup({
    type: 'text', title: 'CALL TRANSCRIPT',
    subtitle: `${data.direction === 'outbound' ? 'To' : 'From'} ${who || 'unknown'}${durText}`,
    text: formatCallTranscript(data),
  });
}

function applyAction(action) {
  switch (action.type) {
    case 'web_search':
      addLine('sys', `Searching the web for “${action.query}”…`);
      if (action.answer) {
        openResultPopup({ type: 'text', title: 'SEARCH RESULT', subtitle: `“${action.query}”`, text: action.answer, sourceUrl: action.sourceUrl });
      }
      if (action.sourceUrl) addSourceLink(action.sourceUrl, 'source: ' + action.sourceUrl);
      break;
    case 'image_search':
      openResultPopup({ type: 'image-grid', title: 'IMAGES FROM THE WEB', subtitle: `“${action.query}”`, images: action.images });
      break;
    case 'image_gen':
      openResultPopup({ type: 'image', title: 'GENERATED IMAGE', subtitle: `“${action.prompt}”`, imageUrl: action.dataUrl, saveName: suggestFileName(action.prompt, 'png') });
      break;
    case '3d_procedural':
      generateProceduralModel(action.prompt);
      break;
    case '3d_meshy_started':
      openMeshyLoadingPopup(action.prompt, action.taskId);
      break;
    case 'pc_command':
      if (action.result && action.result.ok) {
        addLine('sys', `Ran: ${action.command}${action.result.output ? ' → ' + action.result.output : action.result.note ? ' → ' + action.result.note : ''}`);
      } else {
        addLine('sys', `Command failed: ${(action.result && action.result.error) || 'unknown error'}`);
      }
      break;
    case 'email_check':
      openEmailPopup(action);
      break;
    case 'music':
      if (action.result && action.result.ok) {
        addLine('sys', action.result.track ? `Now playing: ${action.result.track}` : `Spotify: ${action.actionTaken}`);
      } else {
        addLine('sys', `Spotify error: ${(action.result && action.result.error) || 'unknown error'}`);
      }
      break;
    case 'open_website':
      window.jarvis.openExternal(action.url);
      addLine('sys', `Opened ${action.url}`);
      break;
    case 'set_muted':
      setMuted(!!action.muted);
      break;
    case 'reminder_set':
      addLine('sys', `Reminder set for ${new Date(action.whenISO).toLocaleString()}: ${action.message}`);
      break;
    case 'computer_task_result':
      if (action.result && action.result.ok) {
        addLine('sys', `Screen control finished (${action.result.steps || 0} step${action.result.steps === 1 ? '' : 's'}): ${action.result.summary || 'done'}`);
      } else {
        addLine('sys', `Screen control stopped: ${(action.result && action.result.error) || 'unknown error'}`);
      }
      break;
    case 'calendar_check':
      openCalendarPopup(action);
      break;
    case 'call_started':
      addLine('sys', `Calling ${action.to}…`);
      break;
    case 'call_action':
      addLine('sys', action.action === 'forward' ? `Connecting the call from ${action.from} through to you now…` : `Declining the call from ${action.from}.`);
      break;
  }
}

async function sendToAI(text) {
  AppState.conversation.push({ role: 'user', content: text });
  setWorking(true);
  let res;
  try {
    res = await window.jarvis.ai.chat(AppState.conversation, AppState.settings);
  } catch (err) {
    res = { ok: false, error: String(err) };
  }
  setWorking(false);

  if (!res || !res.ok) {
    const errText = (res && res.error) || 'unknown error';
    addLine('sys', 'AI error: ' + errText);
    respond("I'm having trouble reaching my AI backend, sir.", { noPopup: true });
    AppState.conversation.pop(); // don't poison memory with a turn that never got a real reply
    return;
  }

  if (res.newMessages && res.newMessages.length) AppState.conversation.push(...res.newMessages);

  for (const action of res.actions || []) applyAction(action);

  if (res.reply) respond(res.reply, { noPopup: hasVisualAction(res.actions) });
}

function handleUserUtterance(text) {
  const bare = text.toLowerCase().trim().replace(/[.!?]+$/, '');
  // Interrupting speech needs to be instant, not wait on a round-trip - kept local for that reason only.
  // Also interrupts a computer_task in progress, if any (harmless no-op otherwise).
  if (/^(stop|cancel|never mind|shut up)$/.test(bare)) {
    stopSpeaking();
    if (window.jarvis.computer && window.jarvis.computer.abort) window.jarvis.computer.abort();
    addLine('sys', '(stopped)');
    return;
  }
  if (AppState.settings.openaiKey) sendToAI(text);
  else handleCommand(text); // no AI key yet - fall back to the built-in fixed-phrase commands
}

/* ====================== TEXT TO SPEECH ====================== */
let speakQueue = Promise.resolve();
let currentAudioEl = null;

// The AI's replies are meant to be *spoken*, not rendered as formatted text
// - but left to its own habits a model will still reach for markdown
// (**bold**, "- " bullets, ...) sometimes despite the system prompt asking
// it not to. This is the backstop: strip anything that slipped through so
// it's never displayed or read aloud as literal asterisks/underscores.
function cleanAiText(text) {
  if (!text) return text;
  return String(text)
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_#`~]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function respond(text, opts = {}) {
  const clean = cleanAiText(text);
  addLine('jarvis', clean);
  logEntry('jarvis', clean);
  speak(clean);
  if (!opts.noPopup && clean.length > 220) {
    openResultPopup({ type: 'text', title: opts.title || 'RESPONSE', subtitle: opts.subtitle || '', text: clean });
  }
}

function setMuted(m) {
  AppState.settings.muted = m;
  saveSettingsPatch({ muted: m });
  el.muteDockBtn.classList.toggle('active', m);
  el.muteSwitch.classList.toggle('on', m);
  updateMuteIcon();
}
function speak(text) {
  if (!text || AppState.settings.muted) return;
  speakQueue = speakQueue.then(() => doSpeak(text)).catch((e) => console.warn(e));
}
function stopSpeaking() {
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {}
  if (currentAudioEl) { try { currentAudioEl.pause(); } catch (e) {} }
  setSpeaking(false);
}
function setSpeaking(isOn) {
  AppState.speaking = isOn;
  el.micBtn.classList.toggle('speaking', isOn);
}

async function doSpeak(text) {
  setSpeaking(true);
  try {
    if (AppState.settings.fishKey) await speakWithFishAudio(text);
    else await speakWithBrowser(text);
  } catch (err) {
    console.warn('Fish Audio speech failed, falling back to browser voice:', err);
    addLine('sys', 'Fish Audio voice failed (check your API key, voice ID, or network) — used your system voice instead.');
    try { await speakWithBrowser(text); } catch (e2) { console.warn(e2); }
  } finally {
    setSpeaking(false);
  }
}
function speakWithBrowser(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => /UK English Male|Daniel|Arthur|Oliver/i.test(v.name)) ||
      voices.find((v) => v.lang === 'en-GB') ||
      voices.find((v) => /^en-/i.test(v.lang)) ||
      voices[0];
    if (preferred) u.voice = preferred;
    u.rate = 1.0; u.pitch = 0.85;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}
async function speakWithFishAudio(text) {
  const res = await window.jarvis.tts.fishAudio(text, {
    key: AppState.settings.fishKey, voiceId: AppState.settings.fishVoiceId, model: AppState.settings.fishModel,
  });
  if (!res.ok) throw new Error(res.error || 'Fish Audio request failed');
  await playAudio(res.dataUrl);
}
function playAudio(url) {
  return new Promise((resolve, reject) => {
    const audioEl = new Audio(url);
    currentAudioEl = audioEl;
    try { ensureOutputAnalyser(audioEl); } catch (e) { console.warn('output analyser unavailable', e); }
    audioEl.onended = () => { currentAudioEl = null; resolve(); };
    audioEl.onerror = (e) => { currentAudioEl = null; reject(e); };
    audioEl.play().catch(reject);
  });
}

/* ====================== UI WIRING / INIT ====================== */
function logEntry(who, text) {
  AppState.log.push({ who, text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  if (AppState.log.length > 200) AppState.log.shift();
  renderLog();
}
function renderLog() {
  if (AppState.log.length === 0) { el.logList.innerHTML = '<div class="empty">Nothing logged yet, sir.</div>'; return; }
  el.logList.innerHTML = '';
  for (const entry of AppState.log) {
    const row = document.createElement('div');
    row.className = 'log-entry';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = (entry.who === 'user' ? 'YOU' : 'REX') + ' · ' + entry.time;
    const txt = document.createElement('div');
    txt.textContent = entry.text;
    row.appendChild(who); row.appendChild(txt);
    el.logList.appendChild(row);
  }
}

function openPanel(panel) { closeAllPanels(); el.overlay.classList.add('show'); panel.classList.add('show'); }
function closeAllPanels() {
  el.overlay.classList.remove('show');
  document.querySelectorAll('.panel.show').forEach((p) => p.classList.remove('show'));
  closeResultPopup();
}
el.overlay.addEventListener('click', closeAllPanels);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeAllPanels));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllPanels(); });
document.querySelectorAll('[data-ext]').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); window.jarvis.openExternal(a.dataset.ext); });
});

function updateMuteIcon() {
  const wave1 = document.getElementById('wave1');
  const wave2 = document.getElementById('wave2');
  const disp = AppState.settings.muted ? 'none' : '';
  if (wave1) wave1.style.display = disp;
  if (wave2) wave2.style.display = disp;
}

function saveSettingsPatch(patch) {
  window.jarvis.settings.set(patch).catch((e) => console.warn('settings save failed', e));
}

el.micBtn.addEventListener('click', () => {
  audioCtxRef = audioCtxRef || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtxRef.state === 'suspended') audioCtxRef.resume();
  if (AppState.listening) stopListening(); else startListening();
});

el.helpBtn.addEventListener('click', () => openPanel(el.helpPanel));
el.infoBtn.addEventListener('click', () => openPanel(el.helpPanel));
el.historyBtn.addEventListener('click', () => { renderLog(); openPanel(el.historyPanel); });
el.settingsBtn.addEventListener('click', () => openPanel(el.settingsPanel));
el.typeDockBtn.addEventListener('click', () => {
  openPanel(el.typePanel);
  el.typeInput.placeholder = 'e.g. generate a 3d model of a crystal';
  el.typeInput.focus();
});
el.searchDockBtn.addEventListener('click', () => {
  openPanel(el.typePanel);
  el.typeInput.placeholder = 'search for …';
  el.typeInput.focus();
});
el.muteDockBtn.addEventListener('click', () => setMuted(!AppState.settings.muted));
el.themeBtn.addEventListener('click', () => applyTheme(AppState.themeIndex + 1));

el.shareBtn.addEventListener('click', async () => {
  const text = AppState.log.length
    ? AppState.log.map((l) => `[${l.time}] ${l.who === 'user' ? 'You' : 'Rex'}: ${l.text}`).join('\n')
    : 'No conversation yet.';
  try {
    await navigator.clipboard.writeText(text);
    addLine('sys', 'Transcript copied to clipboard.');
  } catch (e) {
    addLine('sys', 'Could not copy automatically — opening the log so you can copy it manually.');
    openPanel(el.historyPanel);
  }
});
el.clearLogBtn.addEventListener('click', () => {
  AppState.log = [];
  AppState.conversation = [];
  renderLog();
  addLine('sys', 'Log and memory cleared.');
});

el.typeSendBtn.addEventListener('click', sendTyped);
el.typeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTyped(); });
function sendTyped() {
  const v = el.typeInput.value.trim();
  if (!v) return;
  el.typeInput.value = '';
  closeAllPanels();
  addLine('user', v);
  handleUserUtterance(v);
}

el.resultSaveBtn.addEventListener('click', async () => {
  if (!currentResultSave) return;
  let r;
  if (currentResultSave.kind === 'image') r = await window.jarvis.image.save(currentResultSave.dataUrl, currentResultSave.name);
  else if (currentResultSave.kind === '3d') r = await window.jarvis.model3d.saveGlb(currentResultSave.base64, currentResultSave.name);
  if (r && r.ok) addLine('sys', `Saved to ${r.filePath}`);
});
el.resultLinkBtn.addEventListener('click', () => { if (currentResultUrl) window.jarvis.openExternal(currentResultUrl); });

/* ---- settings panel wiring (persist on change) ---- */
el.fishKeyInput.addEventListener('change', () => { AppState.settings.fishKey = el.fishKeyInput.value.trim(); saveSettingsPatch({ fishKey: AppState.settings.fishKey }); updateVoiceHint(); });
el.fishVoiceInput.addEventListener('change', () => { AppState.settings.fishVoiceId = el.fishVoiceInput.value.trim(); saveSettingsPatch({ fishVoiceId: AppState.settings.fishVoiceId }); });
el.fishModelInput.addEventListener('change', () => { AppState.settings.fishModel = el.fishModelInput.value.trim(); saveSettingsPatch({ fishModel: AppState.settings.fishModel }); });
el.openaiKeyInput.addEventListener('change', () => { AppState.settings.openaiKey = el.openaiKeyInput.value.trim(); saveSettingsPatch({ openaiKey: AppState.settings.openaiKey }); });
el.openaiModelInput.addEventListener('change', () => { AppState.settings.openaiModel = el.openaiModelInput.value.trim(); saveSettingsPatch({ openaiModel: AppState.settings.openaiModel }); });
el.meshyKeyInput.addEventListener('change', () => { AppState.settings.meshyKey = el.meshyKeyInput.value.trim(); saveSettingsPatch({ meshyKey: AppState.settings.meshyKey }); });
el.googleSpeechKeyInput.addEventListener('change', () => {
  AppState.settings.googleSpeechKey = el.googleSpeechKeyInput.value.trim();
  saveSettingsPatch({ googleSpeechKey: AppState.settings.googleSpeechKey });
  addLine('sys', 'Saved. Restart Rex for the speech recognition key to take effect.');
});
el.aiModelInput.addEventListener('change', () => { AppState.settings.aiModel = el.aiModelInput.value.trim(); saveSettingsPatch({ aiModel: AppState.settings.aiModel }); });
el.imageSearchKeyInput.addEventListener('change', () => { AppState.settings.imageSearchKey = el.imageSearchKeyInput.value.trim(); saveSettingsPatch({ imageSearchKey: AppState.settings.imageSearchKey }); });
el.pcControlSwitch.addEventListener('click', () => {
  AppState.settings.pcControlEnabled = !AppState.settings.pcControlEnabled;
  saveSettingsPatch({ pcControlEnabled: AppState.settings.pcControlEnabled });
  el.pcControlSwitch.classList.toggle('on', AppState.settings.pcControlEnabled);
});
el.screenControlSwitch.addEventListener('click', () => {
  AppState.settings.screenControlEnabled = !AppState.settings.screenControlEnabled;
  saveSettingsPatch({ screenControlEnabled: AppState.settings.screenControlEnabled });
  el.screenControlSwitch.classList.toggle('on', AppState.settings.screenControlEnabled);
});
el.resultStopBtn.addEventListener('click', () => {
  if (window.jarvis.computer && window.jarvis.computer.abort) window.jarvis.computer.abort();
  el.resultComputerStatus.textContent = 'Stopping…';
});
el.googleClientIdInput.addEventListener('change', () => { AppState.settings.googleClientId = el.googleClientIdInput.value.trim(); saveSettingsPatch({ googleClientId: AppState.settings.googleClientId }); });
el.googleClientSecretInput.addEventListener('change', () => { AppState.settings.googleClientSecret = el.googleClientSecretInput.value.trim(); saveSettingsPatch({ googleClientSecret: AppState.settings.googleClientSecret }); });
el.microsoftClientIdInput.addEventListener('change', () => { AppState.settings.microsoftClientId = el.microsoftClientIdInput.value.trim(); saveSettingsPatch({ microsoftClientId: AppState.settings.microsoftClientId }); });
el.spotifyClientIdInput.addEventListener('change', () => { AppState.settings.spotifyClientId = el.spotifyClientIdInput.value.trim(); saveSettingsPatch({ spotifyClientId: AppState.settings.spotifyClientId }); });
el.nylasApiKeyInput.addEventListener('change', () => { AppState.settings.nylasApiKey = el.nylasApiKeyInput.value.trim(); saveSettingsPatch({ nylasApiKey: AppState.settings.nylasApiKey }); });
el.nylasClientIdInput.addEventListener('change', () => { AppState.settings.nylasClientId = el.nylasClientIdInput.value.trim(); saveSettingsPatch({ nylasClientId: AppState.settings.nylasClientId }); });
el.nylasApiUriInput.addEventListener('change', () => { AppState.settings.nylasApiUri = el.nylasApiUriInput.value.trim() || 'https://api.us.nylas.com'; saveSettingsPatch({ nylasApiUri: AppState.settings.nylasApiUri }); });
el.twilioAccountSidInput.addEventListener('change', () => { AppState.settings.twilioAccountSid = el.twilioAccountSidInput.value.trim(); saveSettingsPatch({ twilioAccountSid: AppState.settings.twilioAccountSid }); });
el.twilioAuthTokenInput.addEventListener('change', () => { AppState.settings.twilioAuthToken = el.twilioAuthTokenInput.value.trim(); saveSettingsPatch({ twilioAuthToken: AppState.settings.twilioAuthToken }); });
el.twilioPhoneNumberInput.addEventListener('change', () => { AppState.settings.twilioPhoneNumber = el.twilioPhoneNumberInput.value.trim(); saveSettingsPatch({ twilioPhoneNumber: AppState.settings.twilioPhoneNumber }); });
el.userPhoneNumberInput.addEventListener('change', () => { AppState.settings.userPhoneNumber = el.userPhoneNumberInput.value.trim(); saveSettingsPatch({ userPhoneNumber: AppState.settings.userPhoneNumber }); });
el.ngrokExePathInput.addEventListener('change', () => { AppState.settings.ngrokExePath = el.ngrokExePathInput.value.trim(); saveSettingsPatch({ ngrokExePath: AppState.settings.ngrokExePath }); });
el.ngrokAuthtokenInput.addEventListener('change', () => { AppState.settings.ngrokAuthtoken = el.ngrokAuthtokenInput.value.trim(); saveSettingsPatch({ ngrokAuthtoken: AppState.settings.ngrokAuthtoken }); });
el.ngrokStaticDomainInput.addEventListener('change', () => { AppState.settings.ngrokStaticDomain = el.ngrokStaticDomainInput.value.trim(); saveSettingsPatch({ ngrokStaticDomain: AppState.settings.ngrokStaticDomain }); });

function renderConnectionStatus() {
  el.gmailStatus.textContent = AppState.settings.gmailConnected ? `Connected as ${AppState.settings.gmailEmail || 'unknown'}` : 'Not connected';
  el.connectGmailBtn.textContent = AppState.settings.gmailConnected ? 'DISCONNECT' : 'CONNECT GMAIL';
  el.outlookStatus.textContent = AppState.settings.outlookConnected ? `Connected as ${AppState.settings.outlookEmail || 'unknown'}` : 'Not connected';
  el.connectOutlookBtn.textContent = AppState.settings.outlookConnected ? 'DISCONNECT' : 'CONNECT OUTLOOK';
  el.spotifyStatus.textContent = AppState.settings.spotifyConnected ? `Connected as ${AppState.settings.spotifyDisplayName || 'unknown'}` : 'Not connected';
  el.connectSpotifyBtn.textContent = AppState.settings.spotifyConnected ? 'DISCONNECT' : 'CONNECT SPOTIFY';
}

async function handleConnectClick(provider, btn) {
  const original = btn.textContent;
  btn.textContent = 'CONNECTING…';
  btn.disabled = true;
  let res;
  try {
    res = await window.jarvis.oauth.connect(provider);
  } catch (err) {
    res = { ok: false, error: String(err) };
  }
  btn.disabled = false;
  if (res.ok) {
    Object.assign(AppState.settings, res.settings);
    renderConnectionStatus();
    addLine('sys', `Connected: ${res.email || 'account linked'}.`);
  } else {
    btn.textContent = original;
    addLine('sys', `Connection failed: ${res.error}`);
  }
}
async function handleDisconnectClick(provider) {
  const res = await window.jarvis.oauth.disconnect(provider);
  if (res.ok) { Object.assign(AppState.settings, res.settings); renderConnectionStatus(); }
}
el.connectGmailBtn.addEventListener('click', () => {
  if (AppState.settings.gmailConnected) handleDisconnectClick('google');
  else handleConnectClick('google', el.connectGmailBtn);
});
el.connectOutlookBtn.addEventListener('click', () => {
  if (AppState.settings.outlookConnected) handleDisconnectClick('microsoft');
  else handleConnectClick('microsoft', el.connectOutlookBtn);
});
el.connectSpotifyBtn.addEventListener('click', () => {
  if (AppState.settings.spotifyConnected) handleDisconnectClick('spotify');
  else handleConnectClick('spotify', el.connectSpotifyBtn);
});

/* ---- Nylas (third-party account hub): a growing list, not a single on/off connection ---- */
function renderNylasGrants() {
  el.nylasGrantsList.innerHTML = '';
  const grants = AppState.settings.nylasGrants || [];
  if (!grants.length) {
    const empty = document.createElement('div');
    empty.className = 'connect-status';
    empty.textContent = 'No accounts connected yet.';
    el.nylasGrantsList.appendChild(empty);
    return;
  }
  for (const grant of grants) {
    const row = document.createElement('div');
    row.className = 'connect-row';
    row.style.marginTop = '6px';
    const label = document.createElement('div');
    label.className = 'connect-status';
    label.style.margin = '0';
    label.style.flex = '1'; // .connect-row's flex:1 rule only targets <input> - this row uses a div instead
    label.textContent = `${grant.email} (${grant.provider})`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'DISCONNECT';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      let res;
      try { res = await window.jarvis.nylas.disconnectGrant(grant.grantId); }
      catch (err) { res = { ok: false, error: String(err) }; }
      if (res.ok) { Object.assign(AppState.settings, res.settings); renderNylasGrants(); }
      else btn.disabled = false;
    });
    row.appendChild(label);
    row.appendChild(btn);
    el.nylasGrantsList.appendChild(row);
  }
}
el.connectNylasBtn.addEventListener('click', async () => {
  const btn = el.connectNylasBtn;
  const original = btn.textContent;
  btn.textContent = 'CONNECTING…';
  btn.disabled = true;
  let res;
  try { res = await window.jarvis.oauth.connect('nylas'); }
  catch (err) { res = { ok: false, error: String(err) }; }
  btn.disabled = false;
  btn.textContent = original;
  if (res.ok) {
    Object.assign(AppState.settings, res.settings);
    renderNylasGrants();
    addLine('sys', `Connected: ${res.email || 'account linked'}.`);
  } else {
    addLine('sys', `Connection failed: ${res.error}`);
  }
});

/* ---- Calling (Twilio + ConversationRelay): starting/stopping is async and can fail ---- */
function renderCallingStatus(data) {
  if (!data) return;
  if (data.error) el.callingStatus.textContent = `Off — ${data.error}`;
  else if (data.running) el.callingStatus.textContent = `On — ${data.publicUrl}`;
  else el.callingStatus.textContent = 'Off';
  AppState.settings.callingEnabled = !!data.running;
  el.callingSwitch.classList.toggle('on', !!data.running);
}
el.callingSwitch.addEventListener('click', async () => {
  const next = !AppState.settings.callingEnabled;
  el.callingSwitch.disabled = true;
  el.callingStatus.textContent = next ? 'Starting…' : 'Stopping…';
  let res;
  try { res = await window.jarvis.calling.setEnabled(next); }
  catch (err) { res = { ok: false, error: String(err) }; }
  el.callingSwitch.disabled = false;
  if (res.settings) Object.assign(AppState.settings, res.settings);
  el.callingSwitch.classList.toggle('on', !!AppState.settings.callingEnabled);
  if (next && !res.ok) {
    addLine('sys', `Calling failed to start: ${res.error}`);
    el.callingStatus.textContent = `Off — ${res.error}`;
  } else if (next && res.ok) {
    addLine('sys', `Calling is on. Public URL: ${res.publicUrl}`);
    el.callingStatus.textContent = `On — ${res.publicUrl}`;
  } else {
    el.callingStatus.textContent = 'Off';
  }
});
el.testVoiceBtn.addEventListener('click', () => speak('Sir, all systems are functioning within normal parameters.'));
el.wakeSwitch.addEventListener('click', () => {
  AppState.settings.wakeMode = !AppState.settings.wakeMode;
  saveSettingsPatch({ wakeMode: AppState.settings.wakeMode });
  el.wakeSwitch.classList.toggle('on', AppState.settings.wakeMode);
  if (AppState.settings.wakeMode && !AppState.listening) startListening();
  if (!AppState.settings.wakeMode && AppState.listening) stopListening();
});
el.muteSwitch.addEventListener('click', () => setMuted(!AppState.settings.muted));

function updateVoiceHint() {
  el.voiceStatusHint.textContent = AppState.settings.fishKey
    ? 'Voice: Fish Audio (your cloned voice).'
    : "Voice: your system's built-in speech synthesis — add a Fish Audio API key above to switch.";
}

/* ---- boot ---- */
async function init() {
  sizeCanvas();
  applyTheme(0);

  try {
    const loaded = await window.jarvis.settings.get();
    AppState.settings = { ...AppState.settings, ...loaded };
  } catch (e) {
    console.warn('Could not load saved settings, using defaults.', e);
  }

  el.fishKeyInput.value = AppState.settings.fishKey || '';
  el.fishVoiceInput.value = AppState.settings.fishVoiceId;
  el.fishModelInput.value = AppState.settings.fishModel;
  el.openaiKeyInput.value = AppState.settings.openaiKey || '';
  el.openaiModelInput.value = AppState.settings.openaiModel;
  el.meshyKeyInput.value = AppState.settings.meshyKey || '';
  el.googleSpeechKeyInput.value = AppState.settings.googleSpeechKey || '';
  el.aiModelInput.value = AppState.settings.aiModel || 'gpt-5.6-luna';
  el.imageSearchKeyInput.value = AppState.settings.imageSearchKey || '';
  el.pcControlSwitch.classList.toggle('on', !!AppState.settings.pcControlEnabled);
  el.screenControlSwitch.classList.toggle('on', !!AppState.settings.screenControlEnabled);
  el.googleClientIdInput.value = AppState.settings.googleClientId || '';
  el.googleClientSecretInput.value = AppState.settings.googleClientSecret || '';
  el.microsoftClientIdInput.value = AppState.settings.microsoftClientId || '';
  el.spotifyClientIdInput.value = AppState.settings.spotifyClientId || '';
  el.nylasApiKeyInput.value = AppState.settings.nylasApiKey || '';
  el.nylasClientIdInput.value = AppState.settings.nylasClientId || '';
  el.nylasApiUriInput.value = AppState.settings.nylasApiUri || 'https://api.us.nylas.com';
  el.twilioAccountSidInput.value = AppState.settings.twilioAccountSid || '';
  el.twilioAuthTokenInput.value = AppState.settings.twilioAuthToken || '';
  el.twilioPhoneNumberInput.value = AppState.settings.twilioPhoneNumber || '';
  el.userPhoneNumberInput.value = AppState.settings.userPhoneNumber || '';
  el.ngrokExePathInput.value = AppState.settings.ngrokExePath || '';
  el.ngrokAuthtokenInput.value = AppState.settings.ngrokAuthtoken || '';
  el.ngrokStaticDomainInput.value = AppState.settings.ngrokStaticDomain || '';
  el.callingSwitch.classList.toggle('on', !!AppState.settings.callingEnabled);
  el.callingStatus.textContent = AppState.settings.callingEnabled ? 'On' : 'Off';
  el.wakeSwitch.classList.toggle('on', !!AppState.settings.wakeMode);
  el.muteSwitch.classList.toggle('on', !!AppState.settings.muted);
  el.muteDockBtn.classList.toggle('active', !!AppState.settings.muted);

  updateVoiceHint();
  updateMuteIcon();
  renderConnectionStatus();
  renderNylasGrants();
  renderLog();
  addLine('sys', AppState.settings.openaiKey
    ? 'Rex is online. Click the mic and just talk naturally, or use the keyboard icon to type.'
    : 'Rex is online. Add an OpenAI key in Setup to give Rex a real AI brain — until then I only understand a few fixed phrases (see Help).');
  if (!recognitionSupported) {
    addLine('sys', "Heads up: speech recognition isn't available in this build environment — you can still type commands.");
  }

  // Reminders fire unprompted, whenever their time comes - not in reply to
  // anything typed or spoken. This is Rex speaking on its own.
  if (window.jarvis.reminders && window.jarvis.reminders.onFire) {
    window.jarvis.reminders.onFire((data) => {
      respond(`Reminder, sir — ${data.message}`, { title: 'REMINDER' });
    });
  }

  // Live step-by-step progress for computer_task - registered once (not
  // per-call) since only one screen-control task ever runs at a time; the
  // first event of each new run is always 'starting', which is what opens
  // the popup fresh.
  if (window.jarvis.computer && window.jarvis.computer.onProgress) {
    window.jarvis.computer.onProgress((data) => {
      if (data && data.stage === 'starting') openComputerPopup(data.task);
      else updateComputerProgress(data);
    });
  }

  // Calls start/end on their own schedule (an inbound one can arrive any
  // time; an outbound one runs its own live conversation) - see the
  // handlers above for why these are unprompted, same as reminders.onFire.
  if (window.jarvis.calling) {
    if (window.jarvis.calling.onCallStarted) window.jarvis.calling.onCallStarted(handleCallStarted);
    if (window.jarvis.calling.onCallEnded) window.jarvis.calling.onCallEnded(handleCallEnded);
    if (window.jarvis.calling.onStatus) window.jarvis.calling.onStatus((data) => renderCallingStatus(data));
  }

  requestAnimationFrame(draw);
}
document.addEventListener('DOMContentLoaded', init);
