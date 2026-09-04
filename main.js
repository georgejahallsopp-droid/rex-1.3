// Rex - Electron main process.
// Owns the window, all network calls (so the renderer never needs raw
// internet access or exposes API keys in page JS), and settings storage.
// This file also hosts the AI "brain" (OpenAI chat completions + tool
// calling), the web/OAuth integrations (Gmail, Outlook/Hotmail, Spotify),
// web image search, and local PC command execution.

const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, session, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { exec, spawn } = require('child_process');
const WebSocket = require('ws');
const twilio = require('twilio');

const SECRET_FIELDS = [
  'openaiKey', 'fishKey', 'meshyKey', 'googleSpeechKey', 'imageSearchKey', 'googleClientSecret',
  'gmailRefreshToken', 'outlookRefreshToken', 'spotifyRefreshToken',
  'twilioAuthToken', 'ngrokAuthtoken', 'nylasApiKey', 'nylasClientSecret',
];
// These hold real OAuth refresh tokens. Unlike the API-key fields above
// (which the renderer needs verbatim to populate its Setup inputs), the
// renderer only ever needs to know WHETHER an account is connected - so
// cleanForRenderer() below swaps these for plain booleans instead of
// sending the raw token down to page JS.
const OAUTH_TOKEN_FIELDS = ['gmailRefreshToken', 'outlookRefreshToken', 'spotifyRefreshToken'];

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Packaged Electron apps use plain Chromium, which (unlike official Google
// Chrome) doesn't ship the API key Chromium's built-in speech recognition
// service needs - without it, the mic can fail with a "network" error even
// though it worked fine in a regular browser. If the user has hit that and
// pasted a free Google Cloud API key into Setup, apply it as early as
// possible (before the window/renderer exists) so it actually takes effect.
// See README "Troubleshooting" and Setup > Advanced.
try {
  const early = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'));
  if (early && early.googleSpeechKey && !early.googleSpeechKey_enc) {
    process.env.GOOGLE_API_KEY = early.googleSpeechKey;
  } else if (early && early.googleSpeechKey && early.googleSpeechKey_enc && safeStorage.isEncryptionAvailable()) {
    process.env.GOOGLE_API_KEY = safeStorage.decryptString(Buffer.from(early.googleSpeechKey, 'base64'));
  }
} catch (err) {
  // no settings file yet (first run) - nothing to apply
}

function loadSettingsFromDisk() {
  let obj = {};
  try {
    obj = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch (err) {
    return {}; // first run, or unreadable - start fresh
  }
  for (const field of SECRET_FIELDS) {
    if (obj[field] && obj[field + '_enc']) {
      try {
        obj[field] = safeStorage.decryptString(Buffer.from(obj[field], 'base64'));
      } catch (err) {
        obj[field] = ''; // key was encrypted on a different machine/user - can't recover it
      }
    }
  }
  return obj;
}

function writeSettingsToDisk(obj) {
  const toWrite = { ...obj };
  for (const field of SECRET_FIELDS) {
    if (toWrite[field] && safeStorage.isEncryptionAvailable()) {
      toWrite[field] = safeStorage.encryptString(toWrite[field]).toString('base64');
      toWrite[field + '_enc'] = true;
    } else if (toWrite[field]) {
      toWrite[field + '_enc'] = false; // OS-level encryption unavailable - stored as plain text, still local-only
    }
  }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(toWrite, null, 2), 'utf-8');
}

let settingsCache = null;
function getSettings() {
  if (!settingsCache) settingsCache = loadSettingsFromDisk();
  return settingsCache;
}
function setSettings(patch) {
  settingsCache = { ...getSettings(), ...patch };
  writeSettingsToDisk(settingsCache);
  return settingsCache;
}
function cleanForRenderer(obj) {
  const clean = { ...obj };
  for (const field of SECRET_FIELDS) delete clean[field + '_enc'];
  clean.gmailConnected = !!clean.gmailRefreshToken;
  clean.outlookConnected = !!clean.outlookRefreshToken;
  clean.spotifyConnected = !!clean.spotifyRefreshToken;
  for (const field of OAUTH_TOKEN_FIELDS) delete clean[field];
  return clean;
}

// Kept so the reminder scheduler (below) can push an unprompted event to the
// renderer at an arbitrary future time, independent of any particular IPC
// call - unlike the Meshy progress stream, which piggybacks on the sender
// of the request that started it.
let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#020605',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  return win;
}

app.whenReady().then(() => {
  // The renderer asks for the microphone (Web Speech API / getUserMedia).
  // Auto-allow it for our own app window - there's no third-party content
  // in this app, so there's nothing to gate per-site here.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Give the renderer a moment to load and register its listener, then
  // start checking for due reminders - see the REMINDERS section below.
  setTimeout(checkReminders, 3000);
  setInterval(checkReminders, REMINDER_CHECK_INTERVAL_MS);

  // Calling was left on from a previous run - bring the tunnel + Twilio
  // webhook back up automatically rather than making the user re-toggle it
  // every launch. Fire-and-forget: startCallServer() reports failures via
  // the same calling:status event the Setup panel already listens for.
  if (getSettings().callingEnabled) startCallServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Best-effort cleanup so a normal quit doesn't leave the ngrok tunnel
// holding the static domain open (which would surface as ERR_NGROK_334 on
// the next launch - see startNgrokTunnel). Not awaited/blocking: if it
// doesn't finish in time, worst case is that one-time friendly error
// message pointing at Task Manager, not a stuck app.
app.on('before-quit', () => { stopCallServer(); });

/* -------------------------------- reminders --------------------------------
   "Remind me to X at 11" - the AI tool below (set_reminder) resolves the
   user's phrasing into an exact local date-time and stores it in settings.
   This timer independently checks, on a plain interval (robust to the PC
   sleeping - a single long setTimeout would not survive that), whether any
   are now due, and if so pushes an unprompted event to the renderer so
   Rex can speak up on its own, not just in reply to something asked. */
const REMINDER_CHECK_INTERVAL_MS = 20 * 1000;

function checkReminders() {
  try {
    const current = getSettings();
    const reminders = Array.isArray(current.reminders) ? current.reminders : [];
    if (!reminders.length) return;
    const now = Date.now();
    const due = reminders.filter((r) => !r.fired && new Date(r.whenISO).getTime() <= now);
    if (!due.length) return;
    // Mark fired first (persisted immediately) so a reminder can never be
    // spoken twice, even if the app restarts mid-way through this tick.
    const updated = reminders.map((r) => (due.includes(r) ? { ...r, fired: true } : r));
    setSettings({ reminders: updated });
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const r of due) mainWindow.webContents.send('reminder:fire', { id: r.id, message: r.message, whenISO: r.whenISO });
    }
  } catch (err) {
    console.warn('checkReminders failed:', err);
  }
}

/* ---------------------------- settings IPC ---------------------------- */

ipcMain.handle('settings:get', () => cleanForRenderer(getSettings()));
ipcMain.handle('settings:set', (evt, patch) => cleanForRenderer(setSettings(patch || {})));

/* ------------------------------ shell IPC ------------------------------ */

ipcMain.handle('shell:openExternal', (evt, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false, error: 'invalid url' };
});

/* ------------------------------ web search ------------------------------
   Free DuckDuckGo Instant Answer API, no key required. Runs here (not in
   the renderer) so it works regardless of any browser-side CORS policy. */

async function doWebSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('bad status ' + res.status);
    const data = await res.json();
    const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics.find((x) => x && x.Text) : null;
    const answer = data.AbstractText || data.Answer || (related && related.Text) || '';
    const sourceUrl = data.AbstractURL || (related && related.FirstURL) || '';
    return { ok: true, answer, sourceUrl };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
ipcMain.handle('net:search', (evt, query) => doWebSearch(query));

/* -------------------------------- Fish Audio TTS -------------------------------- */

ipcMain.handle('net:speakFishAudio', async (evt, { text, key, voiceId, model }) => {
  if (!key) return { ok: false, error: 'No Fish Audio API key set.' };
  try {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        model: model || 's1',
      },
      body: JSON.stringify({ text, reference_id: voiceId, format: 'mp3' }),
    });
    if (!res.ok) {
      let msg = `Fish Audio API error ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.message) msg += `: ${j.message}`;
      } catch (e) {}
      return { ok: false, error: msg };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, dataUrl: `data:audio/mpeg;base64,${buf.toString('base64')}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/* -------------------------------- OpenAI images -------------------------------- */

async function doGenerateImage({ prompt, key, model, size }) {
  if (!key) return { ok: false, error: 'No OpenAI API key set.' };
  try {
    const body = { model: model || 'gpt-image-1', prompt, size: size || '1024x1024', n: 1 };
    // Newer gpt-image-* models always return base64 and reject response_format;
    // only send it for the older dall-e-* models that require it.
    if (/^dall-e/i.test(body.model)) body.response_format = 'b64_json';

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      return { ok: false, error: msg };
    }
    const item = data && data.data && data.data[0];
    const b64 = item && item.b64_json;
    const url = item && item.url;
    if (b64) return { ok: true, dataUrl: `data:image/png;base64,${b64}` };
    if (url) return { ok: true, dataUrl: url };
    return { ok: false, error: 'No image returned.' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
ipcMain.handle('net:generateImage', (evt, args) => doGenerateImage(args));

/* -------------------------------- web image search --------------------------------
   Real photos from the open web (distinct from AI image generation above).
   Uses Serper.dev - free-tier signup, no card required, simplest current
   option after Bing Search API's 2025 retirement and Google Custom Search's
   2026 "whole web" restriction for new accounts. See README for setup. */

async function doSearchImages({ query, key }) {
  if (!key) return { ok: false, error: 'No image search API key set.' };
  try {
    const res = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 8 }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: (data && data.message) || `HTTP ${res.status}` };
    const images = ((data && data.images) || []).slice(0, 8).map((im) => ({
      url: im.imageUrl, thumbnail: im.thumbnailUrl || im.imageUrl, title: im.title || '', source: im.source || im.link || '',
    }));
    return { ok: true, images };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
ipcMain.handle('net:searchImages', (evt, args) => doSearchImages(args));

// Legacy direct-call path, used only by the built-in fixed-phrase fallback
// (renderer/app.js's generateMeshyModel()) for when no OpenAI key is set
// and the AI tool loop below never runs. Thin wrapper over the same
// startMeshyTask/pollMeshyTaskAndStream used by the AI path - it just
// re-keys progress events to the caller's own correlation token instead of
// the real Meshy task id, since that's what the legacy renderer code expects.
ipcMain.on('model3d:generateMeshy', async (evt, { prompt, key, token }) => {
  const realSender = evt.sender;
  const sendErr = (error) => { if (!realSender.isDestroyed()) realSender.send('model3d:progress', { stage: 'error', error, token }); };
  if (!key) { sendErr('No Meshy AI API key set.'); return; }
  const r = await startMeshyTask(prompt, key);
  if (!r.ok) { sendErr(r.error); return; }
  const bridgingSender = {
    isDestroyed: () => realSender.isDestroyed(),
    send: (channel, payload) => realSender.send(channel, { ...payload, token }),
  };
  pollMeshyTaskAndStream(r.taskId, key, bridgingSender);
});

/* -------------------------------- Meshy AI 3D --------------------------------
   Long-running (can take minutes). Split into a fast "start" call (used
   synchronously inside the AI tool loop below) and a background poller that
   streams progress back over 'model3d:progress' events keyed by the real
   Meshy task id. Preview-quality (untextured) mesh only, to keep cost/time
   down - see README to extend to a textured "refine" pass. */

async function startMeshyTask(prompt, key) {
  try {
    const createRes = await fetch('https://api.meshy.ai/openapi/v2/text-to-3d', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'preview', prompt: String(prompt).slice(0, 600) }),
    });
    const data = await createRes.json().catch(() => null);
    if (!createRes.ok || !data || !data.result) {
      return { ok: false, error: (data && (data.message || data.error)) || `HTTP ${createRes.status}` };
    }
    return { ok: true, taskId: data.result };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function pollMeshyTaskAndStream(taskId, key, sender) {
  const send = (payload) => {
    if (sender && !sender.isDestroyed()) sender.send('model3d:progress', { ...payload, token: taskId });
  };
  (async () => {
    try {
      let finalStatus = null;
      const maxAttempts = 120; // ~10 minutes at 5s intervals
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const stRes = await fetch(`https://api.meshy.ai/openapi/v2/text-to-3d/${taskId}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        const st = await stRes.json().catch(() => null);
        if (!stRes.ok || !st) continue;
        send({ stage: 'polling', progress: st.progress || 0 });
        if (st.status === 'SUCCEEDED') { finalStatus = st; break; }
        if (st.status === 'FAILED' || st.status === 'CANCELED') { send({ stage: 'error', error: 'Meshy task ' + st.status }); return; }
      }
      if (!finalStatus) { send({ stage: 'error', error: 'Timed out waiting for Meshy AI.' }); return; }

      const glbUrl = finalStatus.model_urls && finalStatus.model_urls.glb;
      if (!glbUrl) { send({ stage: 'error', error: 'Meshy AI did not return a model file.' }); return; }

      send({ stage: 'downloading' });
      const glbRes = await fetch(glbUrl);
      const buf = Buffer.from(await glbRes.arrayBuffer());
      send({ stage: 'done', glbBase64: buf.toString('base64'), thumbnailUrl: finalStatus.thumbnail_url || null });
    } catch (err) {
      send({ stage: 'error', error: String(err) });
    }
  })();
}

/* -------------------------------- PC command execution --------------------------------
   Lets Rex act like a VBS/batch script would - e.g. "open lunar client
   then launch minecraft". Off by default; the user must explicitly enable
   it in Setup > Advanced. Every command run is echoed back so it's never
   silent. Uses cmd.exe (Node's default shell on Windows) which is exactly
   what classic Windows automation (VBScript's WScript.Shell.Run, .bat
   files) has always used. */

function doRunPcCommand(command, enabled) {
  return new Promise((resolve) => {
    if (!enabled) {
      resolve({ ok: false, error: "PC control is turned off. Enable it in Setup → Advanced if this is your own trusted PC." });
      return;
    }
    if (!command || typeof command !== 'string') {
      resolve({ ok: false, error: 'No command given.' });
      return;
    }
    // Timeout is a safety cap on how long we WAIT for a result, not a hard
    // kill of whatever got launched - `start` (which we tell the AI to use
    // for launching apps) detaches immediately, so it finishes long before
    // this fires. If something doesn't detach and we do hit the timeout, we
    // report it as "may still be starting" rather than as a failure.
    exec(command, { timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ ok: true, note: 'Command sent - it may still be starting up (this is normal for launching an app).' });
        return;
      }
      if (error) {
        resolve({ ok: false, error: String(stderr || error.message || error).slice(0, 500) });
        return;
      }
      resolve({ ok: true, output: String(stdout || '').slice(0, 500) });
    });
  });
}
ipcMain.handle('pc:runCommand', (evt, { command, enabled }) => doRunPcCommand(command, enabled));

/* -------------------------------- OAuth (Gmail / Outlook / Spotify) --------------------------------
   All three use Authorization Code + PKCE via a local loopback redirect
   (RFC 8252) - the standard, no-embedded-browser, no-client-secret pattern
   for native/desktop apps. Client IDs are the user's own (they register a
   free app with each provider - see README); client IDs are not secret and
   are stored as plain settings. Only the resulting refresh token is
   sensitive, so that's the part that's encrypted at rest and never sent
   back to the renderer (see cleanForRenderer above). */

const OAUTH_PORT = 53682;
const OAUTH_REDIRECT = `http://127.0.0.1:${OAUTH_PORT}/callback`;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function waitForOAuthRedirect(expectedState) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error('Timed out waiting for sign-in (5 minutes).'))), 5 * 60 * 1000);
    const server = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, `http://127.0.0.1:${OAUTH_PORT}`); } catch (e) { res.writeHead(400); res.end(); return; }
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="background:#020605;color:#35f4e0;font-family:sans-serif;text-align:center;padding-top:80px;"><h2>REX</h2><p>Signed in — you can close this tab and return to the app.</p></body></html>');
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      const error = u.searchParams.get('error_description') || u.searchParams.get('error');
      finish(() => {
        if (error) return reject(new Error(error));
        if (state !== expectedState) return reject(new Error('Security check failed (state mismatch) - please try again.'));
        if (!code) return reject(new Error('No authorization code received.'));
        resolve(code);
      });
    });
    function finish(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch (e) {}
      fn();
    }
    server.on('error', (err) => finish(() => reject(new Error(
      err.code === 'EADDRINUSE'
        ? `Port ${OAUTH_PORT} is already in use on this PC - close whatever else is using it and try again.`
        : String(err)
    ))));
    server.listen(OAUTH_PORT, '127.0.0.1');
  });
}

async function connectProvider(provider) {
  const s = getSettings();

  if (provider === 'google') {
    const clientId = s.googleClientId;
    if (!clientId) throw new Error('Add your Google Client ID in Setup first (see README for how to get one).');
    const { verifier, challenge } = makePkce();
    const state = crypto.randomBytes(12).toString('hex');
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.search = new URLSearchParams({
      client_id: clientId, redirect_uri: OAUTH_REDIRECT, response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email',
      code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'consent', access_type: 'offline',
    }).toString();
    const waitPromise = waitForOAuthRedirect(state);
    shell.openExternal(authUrl.toString());
    const code = await waitPromise;
    // Google's documented Desktop-app PKCE flow needs no client secret, but a
    // few real-world client registrations have been reported to require one
    // anyway - this stays blank/unused unless the user hits that and adds one.
    const googleTokenBody = { client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: OAUTH_REDIRECT };
    if (s.googleClientSecret) googleTokenBody.client_secret = s.googleClientSecret;
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(googleTokenBody),
    });
    const tok = await tokRes.json().catch(() => null);
    if (!tokRes.ok || !tok || !tok.refresh_token) {
      throw new Error((tok && (tok.error_description || tok.error)) || 'Google did not return a refresh token - if you\'ve connected before, remove this app\'s access at myaccount.google.com/permissions and try again.');
    }
    let email = '';
    try {
      const uiRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const ui = await uiRes.json().catch(() => null);
      email = (ui && ui.email) || '';
    } catch (e) {}
    setSettings({ gmailRefreshToken: tok.refresh_token, gmailEmail: email });
    tokenCache.google = { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 };
    return { email };
  }

  if (provider === 'microsoft') {
    const clientId = s.microsoftClientId;
    if (!clientId) throw new Error('Add your Microsoft Client ID in Setup first (see README for how to get one).');
    const { verifier, challenge } = makePkce();
    const state = crypto.randomBytes(12).toString('hex');
    const scope = 'offline_access User.Read Mail.Read';
    const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    authUrl.search = new URLSearchParams({
      client_id: clientId, redirect_uri: OAUTH_REDIRECT, response_type: 'code',
      scope, code_challenge: challenge, code_challenge_method: 'S256', state,
    }).toString();
    const waitPromise = waitForOAuthRedirect(state);
    shell.openExternal(authUrl.toString());
    const code = await waitPromise;
    const tokRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: OAUTH_REDIRECT, scope }),
    });
    const tok = await tokRes.json().catch(() => null);
    if (!tokRes.ok || !tok || !tok.refresh_token) {
      throw new Error((tok && (tok.error_description || tok.error)) || 'Microsoft sign-in failed.');
    }
    let email = '';
    try {
      const meRes = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const me = await meRes.json().catch(() => null);
      email = (me && (me.mail || me.userPrincipalName)) || '';
    } catch (e) {}
    setSettings({ outlookRefreshToken: tok.refresh_token, outlookEmail: email });
    tokenCache.microsoft = { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 };
    return { email };
  }

  if (provider === 'spotify') {
    const clientId = s.spotifyClientId;
    if (!clientId) throw new Error('Add your Spotify Client ID in Setup first (see README for how to get one).');
    const { verifier, challenge } = makePkce();
    const state = crypto.randomBytes(12).toString('hex');
    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.search = new URLSearchParams({
      client_id: clientId, redirect_uri: OAUTH_REDIRECT, response_type: 'code',
      scope: 'user-read-playback-state user-modify-playback-state user-read-currently-playing',
      code_challenge: challenge, code_challenge_method: 'S256', state,
    }).toString();
    const waitPromise = waitForOAuthRedirect(state);
    shell.openExternal(authUrl.toString());
    const code = await waitPromise;
    const tokRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: OAUTH_REDIRECT }),
    });
    const tok = await tokRes.json().catch(() => null);
    if (!tokRes.ok || !tok || !tok.refresh_token) {
      throw new Error((tok && (tok.error_description || tok.error)) || 'Spotify sign-in failed.');
    }
    let displayName = '';
    try {
      const meRes = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const me = await meRes.json().catch(() => null);
      displayName = (me && me.display_name) || '';
    } catch (e) {}
    setSettings({ spotifyRefreshToken: tok.refresh_token, spotifyDisplayName: displayName });
    tokenCache.spotify = { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 };
    return { email: displayName };
  }

  if (provider === 'nylas') {
    // Nylas is the "account hub" - unlike the three providers above (one
    // direct connection each), Nylas can hold many connected mailboxes/
    // calendars at once (one "grant" per account), and it's a confidential
    // client (the Nylas API key doubles as client_secret in the token
    // exchange), so PKCE here is defense-in-depth rather than the load-
    // bearing security it is for Google/Microsoft/Spotify above - reusing
    // makePkce() anyway since it's free and only makes this safer.
    // Deliberately NOT passing `provider=` on the auth URL: Nylas then shows
    // its own hosted picker (Google/Microsoft/etc.), which is exactly the
    // "connect all my socials in one place" hub experience being built here,
    // without this app needing a separate button per provider.
    const clientId = s.nylasClientId;
    const apiKey = s.nylasApiKey;
    if (!clientId) throw new Error('Add your Nylas Client ID in Setup first (see README for how to get one).');
    if (!apiKey) throw new Error('Add your Nylas API Key in Setup first (see README for how to get one).');
    const apiUri = (s.nylasApiUri || 'https://api.us.nylas.com').replace(/\/$/, '');
    const { verifier, challenge } = makePkce();
    const state = crypto.randomBytes(12).toString('hex');
    const authUrl = new URL(`${apiUri}/v3/connect/auth`);
    authUrl.search = new URLSearchParams({
      client_id: clientId, redirect_uri: OAUTH_REDIRECT, response_type: 'code',
      access_type: 'online', state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    const waitPromise = waitForOAuthRedirect(state);
    shell.openExternal(authUrl.toString());
    const code = await waitPromise;
    const tokRes = await fetch(`${apiUri}/v3/connect/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: apiKey, grant_type: 'authorization_code', code, redirect_uri: OAUTH_REDIRECT, code_verifier: verifier }),
    });
    const tok = await tokRes.json().catch(() => null);
    if (!tokRes.ok || !tok || !tok.grant_id) {
      throw new Error((tok && (tok.error_description || tok.error || tok.message)) || 'Nylas sign-in failed.');
    }
    let email = tok.email || '';
    let acctProvider = tok.provider || '';
    if (!email) {
      // Nylas's own docs disagree on whether the token response includes
      // `email` - fall back to fetching the grant itself when it's missing
      // rather than showing the user a blank account name.
      try {
        const gRes = await fetch(`${apiUri}/v3/grants/${tok.grant_id}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
        const gData = await gRes.json().catch(() => null);
        const g = gData && gData.data;
        if (g) { email = g.email || ''; acctProvider = acctProvider || g.provider || ''; }
      } catch (e) {}
    }
    const current = getSettings();
    const existingGrants = Array.isArray(current.nylasGrants) ? current.nylasGrants : [];
    const grant = { grantId: tok.grant_id, email: email || '(connected account)', provider: acctProvider || 'unknown' };
    setSettings({ nylasGrants: [...existingGrants.filter((g) => g.grantId !== grant.grantId), grant] });
    return { email: grant.email };
  }

  throw new Error('Unknown provider: ' + provider);
}

const PROVIDER_TOKEN_CONFIG = {
  google: { label: 'Gmail', tokenUrl: 'https://oauth2.googleapis.com/token', refreshField: 'gmailRefreshToken', clientIdField: 'googleClientId', secretField: 'googleClientSecret' },
  microsoft: { label: 'Outlook/Hotmail', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', refreshField: 'outlookRefreshToken', clientIdField: 'microsoftClientId' },
  spotify: { label: 'Spotify', tokenUrl: 'https://accounts.spotify.com/api/token', refreshField: 'spotifyRefreshToken', clientIdField: 'spotifyClientId' },
};
let tokenCache = { google: null, microsoft: null, spotify: null };

async function getValidAccessToken(provider) {
  const cfg = PROVIDER_TOKEN_CONFIG[provider];
  const s = getSettings();
  const refreshToken = s[cfg.refreshField];
  if (!refreshToken) throw new Error(`${cfg.label} isn’t connected. Connect it in Setup first.`);
  const cached = tokenCache[provider];
  if (cached && cached.expiresAt > Date.now() + 30000) return cached.accessToken;

  const clientId = s[cfg.clientIdField];
  if (!clientId) throw new Error(`Missing ${cfg.label} Client ID in Setup.`);
  const refreshBody = { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken };
  if (cfg.secretField && s[cfg.secretField]) refreshBody.client_secret = s[cfg.secretField];
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(refreshBody),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    if (data && data.error === 'invalid_grant') {
      setSettings({ [cfg.refreshField]: '' });
      throw new Error(`Your ${cfg.label} connection expired. Reconnect it in Setup.`);
    }
    throw new Error((data && (data.error_description || data.error)) || `${cfg.label} token refresh failed.`);
  }
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  tokenCache[provider] = { accessToken: data.access_token, expiresAt };
  if (data.refresh_token) setSettings({ [cfg.refreshField]: data.refresh_token }); // Spotify rotates these
  return data.access_token;
}

ipcMain.handle('oauth:connect', async (evt, provider) => {
  try {
    const r = await connectProvider(provider);
    return { ok: true, ...r, settings: cleanForRenderer(getSettings()) };
  } catch (err) {
    let msg = String(err.message || err);
    // access_denied is what Google sends back both when the user backs out
    // of the "Google hasn't verified this app" warning AND when their
    // account was never added to the OAuth client's Test users list (in
    // which case Google blocks them before they even see that warning) -
    // can't tell which from here, so cover both.
    if (provider === 'google' && /access_denied/i.test(msg)) {
      msg += ' — most likely cause: your Gmail address isn\'t on this app\'s Test users list yet (console.cloud.google.com → APIs & Services → Audience → Test users). If you did see a "Google hasn\'t verified this app" screen and back out, that warning is normal for a personal app — click Connect again and this time use Advanced → Go to [app name] (unsafe) to continue.';
    }
    return { ok: false, error: msg };
  }
});
ipcMain.handle('oauth:disconnect', async (evt, provider) => {
  const map = {
    google: { field: 'gmailRefreshToken', emailField: 'gmailEmail' },
    microsoft: { field: 'outlookRefreshToken', emailField: 'outlookEmail' },
    spotify: { field: 'spotifyRefreshToken', emailField: 'spotifyDisplayName' },
  };
  const cfg = map[provider];
  if (!cfg) return { ok: false, error: 'Unknown provider' };
  setSettings({ [cfg.field]: '', [cfg.emailField]: '' });
  tokenCache[provider] = null;
  return { ok: true, settings: cleanForRenderer(getSettings()) };
});

// Nylas holds many connected accounts at once (one grant per account), so
// disconnecting one is "remove this specific grant from the list" - a
// different shape from the single-provider oauth:disconnect above, hence
// its own IPC channel rather than overloading that one.
ipcMain.handle('nylas:disconnectGrant', async (evt, grantId) => {
  const s = getSettings();
  const apiUri = (s.nylasApiUri || 'https://api.us.nylas.com').replace(/\/$/, '');
  try {
    if (s.nylasApiKey) {
      await fetch(`${apiUri}/v3/grants/${grantId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${s.nylasApiKey}`, Accept: 'application/json' } });
    }
  } catch (e) {
    // best effort - still remove it from the local list below, so a grant
    // that's already been revoked (or a network hiccup) never leaves the
    // user stuck with a "connected" account they can't get rid of
  }
  const existing = Array.isArray(s.nylasGrants) ? s.nylasGrants : [];
  setSettings({ nylasGrants: existing.filter((g) => g.grantId !== grantId) });
  return { ok: true, settings: cleanForRenderer(getSettings()) };
});

/* -------------------------------- Gmail / Outlook mail -------------------------------- */

async function doCheckGmail(count = 8) {
  const token = await getValidAccessToken('google');
  const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${count}&q=in:inbox`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = await listRes.json().catch(() => null);
  if (!listRes.ok) throw new Error((list && list.error && list.error.message) || 'Gmail list request failed.');
  const ids = (list.messages || []).map((m) => m.id);
  const messages = [];
  for (const id of ids) {
    const mRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const m = await mRes.json().catch(() => null);
    if (!mRes.ok || !m) continue;
    const headers = (m.payload && m.payload.headers) || [];
    const get = (name) => (headers.find((h) => h.name === name) || {}).value || '';
    messages.push({
      subject: get('Subject') || '(no subject)', from: get('From'), date: get('Date'),
      snippet: m.snippet || '', unread: (m.labelIds || []).includes('UNREAD'),
    });
  }
  return messages;
}

async function doCheckOutlook(count = 8) {
  const token = await getValidAccessToken('microsoft');
  const url = `https://graph.microsoft.com/v1.0/me/messages?$top=${count}&$select=subject,from,bodyPreview,receivedDateTime,isRead&$orderby=receivedDateTime desc`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error && data.error.message) || 'Outlook list request failed.');
  return ((data && data.value) || []).map((m) => ({
    subject: m.subject || '(no subject)',
    from: m.from && m.from.emailAddress ? `${m.from.emailAddress.name} <${m.from.emailAddress.address}>` : '',
    date: m.receivedDateTime, snippet: m.bodyPreview || '', unread: !m.isRead,
  }));
}

/* -------------------------------- Nylas (third-party account hub) --------------------------------
   Mirrors doCheckGmail/doCheckOutlook's return shape so the renderer's
   existing buildEmailRow() needs no changes - but unlike those two (one
   fixed account each), there can be any number of Nylas grants, so these
   take the specific grant to check rather than reading it from settings
   themselves, and the caller (executeTool) loops over every connected one. */

async function doCheckNylasGrant(grant, apiKey, apiUri, count = 8) {
  const url = `${apiUri}/v3/grants/${grant.grantId}/messages?limit=${count}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `Nylas mail check failed for ${grant.email}.`);
  return ((data && data.data) || []).map((m) => {
    const first = Array.isArray(m.from) && m.from[0];
    return {
      subject: m.subject || '(no subject)',
      from: first ? `${first.name || ''} <${first.email || ''}>`.trim() : '',
      date: m.date ? new Date(m.date * 1000).toString() : '',
      snippet: m.snippet || '',
      unread: !!m.unread,
      account: grant.email,
    };
  });
}

// Nylas's event "when" field comes in a few shapes depending on the event
// type (a timed span, a single all-day date, or a multi-day date span) -
// this normalizes all of them to a display string plus a numeric unix-
// seconds timestamp so callers can sort chronologically without having to
// parse Date.toString()'s non-sortable "Www Mmm dd yyyy" text back apart.
function describeNylasWhen(when) {
  if (!when) return { text: '', ts: Infinity };
  try {
    if (typeof when.start_time === 'number') {
      const start = new Date(when.start_time * 1000);
      const text = `${start.toString()}${typeof when.end_time === 'number' ? ' - ' + new Date(when.end_time * 1000).toString() : ''}`;
      return { text, ts: when.start_time };
    }
    if (when.date) {
      const ts = Math.floor(new Date(when.date).getTime() / 1000);
      return { text: `${when.date} (all day)`, ts: isNaN(ts) ? Infinity : ts };
    }
    if (when.start_date) {
      const ts = Math.floor(new Date(when.start_date).getTime() / 1000);
      return { text: `${when.start_date}${when.end_date ? ' - ' + when.end_date : ''}`, ts: isNaN(ts) ? Infinity : ts };
    }
  } catch (e) {}
  return { text: '', ts: Infinity };
}

async function doCheckNylasCalendar(grant, apiKey, apiUri, count = 10) {
  const now = Math.floor(Date.now() / 1000);
  const later = now + 14 * 24 * 3600; // next 14 days - a bounded, useful default without asking the model to pick a range
  const url = `${apiUri}/v3/grants/${grant.grantId}/events?calendar_id=primary&start=${now}&end=${later}&limit=${count}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `Nylas calendar check failed for ${grant.email}.`);
  return ((data && data.data) || []).map((e) => {
    const w = describeNylasWhen(e.when);
    return { title: e.title || '(untitled event)', when: w.text, startTs: w.ts, location: e.location || '', account: grant.email };
  });
}

/* -------------------------------- Spotify playback -------------------------------- */

async function doSpotifyControl(action, query) {
  const token = await getValidAccessToken('spotify');
  const authHeader = { Authorization: `Bearer ${token}` };

  async function activeDeviceId() {
    const r = await fetch('https://api.spotify.com/v1/me/player/devices', { headers: authHeader });
    const d = await r.json().catch(() => null);
    const devices = (d && d.devices) || [];
    const active = devices.find((x) => x.is_active) || devices[0];
    return active ? active.id : null;
  }
  function friendlyPlaybackError(status, body) {
    if (status === 403) return "That needs Spotify Premium — playback control isn't available on free accounts.";
    if (status === 404) return 'No active Spotify device found — open Spotify on this PC or your phone first, then try again.';
    return (body && body.error && body.error.message) || `Spotify request failed (${status})`;
  }

  if (action === 'play' && query) {
    const sRes = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`, { headers: authHeader });
    const sData = await sRes.json().catch(() => null);
    const track = sData && sData.tracks && sData.tracks.items && sData.tracks.items[0];
    if (!track) return { ok: false, error: `Couldn't find "${query}" on Spotify.` };
    const deviceId = await activeDeviceId();
    const playUrl = 'https://api.spotify.com/v1/me/player/play' + (deviceId ? `?device_id=${deviceId}` : '');
    const pRes = await fetch(playUrl, {
      method: 'PUT', headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [track.uri] }),
    });
    if (pRes.status !== 204) {
      const body = await pRes.json().catch(() => null);
      return { ok: false, error: friendlyPlaybackError(pRes.status, body) };
    }
    return { ok: true, track: `${track.name} by ${(track.artists || []).map((a) => a.name).join(', ')}` };
  }

  const endpointMap = {
    pause: { method: 'PUT', path: '/pause' },
    resume: { method: 'PUT', path: '/play' },
    next: { method: 'POST', path: '/next' },
    previous: { method: 'POST', path: '/previous' },
  };
  const ep = endpointMap[action];
  if (!ep) return { ok: false, error: 'Unknown music action: ' + action };
  const res = await fetch(`https://api.spotify.com/v1/me/player${ep.path}`, { method: ep.method, headers: authHeader });
  if (res.status !== 204) {
    const body = await res.json().catch(() => null);
    return { ok: false, error: friendlyPlaybackError(res.status, body) };
  }
  return { ok: true };
}

/* ================================================================
   TELEPHONY - Twilio ConversationRelay
   Off by default (callingEnabled), and heavier to set up than anything
   else in this app: it needs a real Twilio phone number (small monthly
   rental + a few cents/minute - see README) and a public URL for Twilio to
   reach this PC over the internet, which a home desktop app doesn't have by
   default. That public URL comes from the user's own ngrok agent (a
   separate small download, also documented in the README) - this app
   drives it as a child process rather than bundling ngrok as an npm
   dependency, deliberately: ngrok's Node SDK is a native (compiled) addon,
   and this app is shipped as a single packaged .exe that can't be tested
   end-to-end on a real Windows PC before it reaches the user - spawning a
   plain downloaded ngrok.exe and talking to its well-documented local
   status API (127.0.0.1:4040) is a far more predictable, debuggable
   failure mode than a native module silently failing to load inside a
   packaged Electron app.

   Rex answers every inbound call itself (there's no "ring the user's real
   phone first" step - once carrier forwarding sends a call to the Twilio
   number, Twilio always hits /voice/incoming) and has a real spoken
   conversation via Twilio's ConversationRelay: Twilio handles speech-to-
   text and text-to-speech, and streams plain text back and forth over a
   WebSocket to /voice/relay below, where each caller utterance becomes one
   more turn through the same callOpenAIChat() used by the desktop chat.
   Two tools are available to Rex DURING that screening conversation -
   forward_call (bridge the caller through live to the user's real phone -
   "worth interrupting them for") and decline_call (politely end the call -
   covers everything from "took a message" to "this is a robocall") - and
   Rex is told to always pick one once it's decided. Outbound calls
   (make_call, triggered from the desktop chat) are simpler: Rex just talks
   toward a stated goal and calls end_call when done.

   The same forward/decline actions are also exposed as desktop-chat tools
   (see buildToolDefs/executeTool below) gated on a call currently being
   screened, so the user can jump in from the HUD ("forward that call")
   while Rex is still mid-conversation with a caller.
   ================================================================ */

const CALL_SERVER_PORT = 53683;
let callHttpServer = null;
let callWss = null;
let ngrokChild = null;
let publicCallUrl = null; // e.g. https://xxxx.ngrok-free.app - set once the tunnel confirms up, cleared on stop
let callServerStatus = { running: false, publicUrl: null, error: null };
// Twilio's request-signature check (verifyTwilioSignature below) only
// covers the HTTP webhook routes - the WebSocket upgrade request for
// /voice/relay isn't run through that same check, so without something
// else guarding it, anyone who obtained the ngrok URL could open a
// WebSocket straight to it and be treated as a real call. This random,
// server-lifetime-only secret (never persisted - regenerated every time
// Calling starts) is embedded in the relay URL this app itself hands to
// Twilio, and checked on every connection before any message is trusted.
let callRelaySecret = null;

// callSid -> { ws, callSid, from, to, direction, goal, startedAt, transcript,
// convo, pendingAction }. In-memory only, by design - a call that outlives
// the app process isn't something this feature needs to survive.
const activeCalls = new Map();

function notifyRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function getTwilioClient(settings) {
  if (!settings.twilioAccountSid || !settings.twilioAuthToken) {
    throw new Error('Add your Twilio Account SID and Auth Token in Setup first.');
  }
  return twilio(settings.twilioAccountSid, settings.twilioAuthToken);
}

function findActiveInboundCall() {
  for (const call of activeCalls.values()) {
    if (call.direction === 'inbound' && !call.pendingAction) return call;
  }
  return null;
}

// Shared by the WebSocket's natural 'close' event and stopCallServer's
// forced shutdown - removing from activeCalls and firing call:ended always
// happen together, exactly once, however the call actually ends. Whichever
// of those two paths gets here first "wins"; the other finds the call
// already gone and does nothing (activeCalls.get returns undefined), so a
// forced shutdown can never race a natural close into notifying twice.
function endActiveCall(callSid) {
  const call = activeCalls.get(callSid);
  if (!call) return;
  activeCalls.delete(callSid);
  notifyRenderer('call:ended', {
    callSid, from: call.from, to: call.to, direction: call.direction,
    goal: call.goal, transcript: call.transcript, endedAction: call.pendingAction || 'ended',
    durationMs: Date.now() - call.startedAt,
  });
}

/* ---- inbound HTTP: TwiML + Twilio's own request-signature check ---- */

function readFormBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(new Error('Request body too large'));
    });
    req.on('end', () => {
      const params = {};
      for (const [k, v] of new URLSearchParams(data)) params[k] = v;
      resolve(params);
    });
    req.on('error', reject);
  });
}

// Twilio signs every webhook request with the account's Auth Token so a
// server can prove a request genuinely came from Twilio, not just anyone
// who found the tunnel URL - worth doing here since an ngrok URL, while not
// indexed anywhere, is technically reachable by anyone who obtains it.
function verifyTwilioSignature(req, params, settings) {
  if (!settings.twilioAuthToken || !publicCallUrl) return false;
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;
  const url = `${publicCallUrl}${req.url}`;
  try {
    return twilio.validateRequest(settings.twilioAuthToken, signature, url, params);
  } catch (e) {
    return false;
  }
}

const CALL_SCREEN_GREETING = "Hi, this is Rex, an AI assistant. The person you're trying to reach can't come to the phone right now — who's calling, and what's this about?";

function buildConversationRelayOptions(settings, extra) {
  const opts = { language: 'en-US', interruptible: 'speech', dtmfDetection: true, ...extra };
  if (settings.twilioTtsProvider) opts.ttsProvider = settings.twilioTtsProvider;
  if (settings.twilioVoice) opts.voice = settings.twilioVoice;
  return opts;
}

async function handleCallHttp(req, res) {
  let u;
  try {
    u = new URL(req.url, `http://127.0.0.1:${CALL_SERVER_PORT}`);
  } catch (e) {
    res.writeHead(400); res.end(); return;
  }
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  let params;
  try {
    params = await readFormBody(req);
  } catch (e) {
    res.writeHead(400); res.end(); return;
  }
  const settings = getSettings();
  if (!verifyTwilioSignature(req, params, settings)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Invalid signature');
    return;
  }
  const VoiceResponse = twilio.twiml.VoiceResponse;

  if (u.pathname === '/voice/incoming') {
    const response = new VoiceResponse();
    const connect = response.connect({ action: `${publicCallUrl}/voice/connect-action`, method: 'POST' });
    const cr = connect.conversationRelay(buildConversationRelayOptions(settings, {
      url: `${publicCallUrl.replace(/^http/, 'ws')}/voice/relay?key=${callRelaySecret}`,
      welcomeGreeting: CALL_SCREEN_GREETING,
    }));
    cr.parameter({ name: 'direction', value: 'inbound' });
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(response.toString());
    return;
  }

  if (u.pathname === '/voice/connect-action') {
    let handoff = {};
    try { handoff = JSON.parse(params.HandoffData || '{}'); } catch (e) {}
    const response = new VoiceResponse();
    if (handoff.action === 'forward' && settings.userPhoneNumber) {
      response.dial(settings.userPhoneNumber);
    } else {
      response.hangup();
    }
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(response.toString());
    return;
  }

  res.writeHead(404); res.end();
}

/* ---- the live conversation itself: /voice/relay WebSocket ---- */

function buildCallSystemPrompt(direction, goal) {
  if (direction === 'outbound') {
    return `You are Rex, an AI voice assistant placing a phone call on behalf of your user (refer to them as "sir" if you need to refer to them at all - never call the person you're speaking with "sir"). This call has just connected - begin speaking first, with a brief natural spoken greeting introducing yourself, then work toward your goal for this call: ${goal || 'just be polite and find out what they need.'}
Keep every reply short, natural, and spoken - no markdown, no lists, this is a live phone conversation, not text. Be honest that you're an AI assistant if asked. Never share sensitive personal information (passwords, financial details, ID/SSNs) on this call. Once the conversation has naturally concluded - the goal is accomplished, or clearly cannot be - say a brief goodbye and call end_call.`;
  }
  return `You are Rex, an AI phone-screening assistant. You've just answered an incoming call for your user, who can't come to the phone right now, and already introduced yourself. Keep every reply short, natural, and spoken - no markdown, no lists, this is a live phone conversation, not text. Find out who's calling and why. Be honest that you're an AI assistant if asked, and never share sensitive personal information about your user. If this seems like something your user would genuinely want to be interrupted for right now (someone they know, anything urgent), call forward_call to connect them live. Otherwise - solicitors, robocalls, an unclear or non-urgent caller - politely take a brief message and call decline_call to end the call. Always call exactly one of those two tools once you've decided; don't just stop replying.`;
}

const CALL_ACTION_FALLBACK_WORDS = { forward: 'One moment, connecting you now.', decline: 'Thank you, goodbye.', hangup: 'Alright, goodbye.' };

// Speaks a final line (if any), then gives Twilio a few seconds to actually
// finish synthesizing/playing it before handing off - ConversationRelay's
// protocol has no explicit "done speaking" event to wait on instead, so
// this fixed delay is a pragmatic, untested-against-a-real-call best
// effort (see README caveats), not a guarantee.
function speakThenMaybeEnd(call, words, action) {
  call.pendingAction = action;
  const text = words || CALL_ACTION_FALLBACK_WORDS[action] || 'Goodbye.';
  call.transcript.push({ role: 'rex', text });
  try { call.ws.send(JSON.stringify({ type: 'text', token: text, last: true })); } catch (e) {}
  setTimeout(() => {
    try { call.ws.send(JSON.stringify({ type: 'end', handoffData: JSON.stringify({ action }) })); } catch (e) {}
  }, 4000);
}

async function advanceCallTurn(callSid, callerUtterance) {
  const call = activeCalls.get(callSid);
  // call.busy guards against two turns racing (e.g. Twilio ever sending two
  // "last" prompts before the first reply goes out) - without it both could
  // pass this guard, race on call.convo, and send two overlapping replies.
  if (!call || call.pendingAction || call.busy) return;
  call.busy = true;
  try {
    await advanceCallTurnInner(call, callerUtterance);
  } finally {
    call.busy = false;
  }
}

async function advanceCallTurnInner(call, callerUtterance) {
  const callSid = call.callSid;
  const settings = getSettings();
  if (callerUtterance) {
    call.convo.push({ role: 'user', content: callerUtterance });
    call.transcript.push({ role: 'caller', text: callerUtterance });
  }
  const tools = call.direction === 'outbound'
    ? [{ type: 'function', function: { name: 'end_call', description: 'End the call now - the conversation has concluded (goal accomplished, or it clearly cannot be).', parameters: { type: 'object', properties: {} } } }]
    : [
        { type: 'function', function: { name: 'forward_call', description: "Connect this caller through live to the user's real phone right now, because this is worth interrupting them for.", parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'decline_call', description: 'End this call - used once a message has been taken, or for an unwanted/spam/robocall.', parameters: { type: 'object', properties: {} } } },
      ];
  let result;
  try {
    result = await callOpenAIChat({ model: settings.aiModel || 'gpt-5.6-luna', messages: call.convo, tools, tool_choice: 'auto', temperature: 0.6 }, settings.openaiKey);
  } catch (e) {
    result = { ok: false, error: String(e.message || e) };
  }
  // Either the call ended, or it was already decided by another path while
  // we were waiting on the AI response above - e.g. the user said "decline
  // that call" from the desktop chat (executeTool's forward_call/
  // decline_call branch), which runs fully synchronously and can complete
  // in the gap this await just opened up. Bail out rather than also acting
  // on our own (now stale) decision and speaking/handing off a second time.
  if (!activeCalls.has(callSid) || call.pendingAction) return;
  if (!result.ok) {
    speakThenMaybeEnd(call, "I'm sorry, I'm having trouble right now - goodbye.", call.direction === 'outbound' ? 'hangup' : 'decline');
    return;
  }
  const msg = result.data.choices && result.data.choices[0] && result.data.choices[0].message;
  if (!msg) return;
  call.convo.push(msg);
  const validNames = call.direction === 'outbound' ? ['end_call'] : ['forward_call', 'decline_call'];
  const toolCall = msg.tool_calls && msg.tool_calls.find((c) => validNames.includes(c.function.name));
  if (msg.tool_calls && msg.tool_calls.length) {
    for (const c of msg.tool_calls) call.convo.push({ role: 'tool', tool_call_id: c.id, content: '{"ok":true}' });
  }
  if (toolCall) {
    const action = toolCall.function.name === 'forward_call' ? 'forward' : (toolCall.function.name === 'end_call' ? 'hangup' : 'decline');
    speakThenMaybeEnd(call, msg.content || '', action);
    return;
  }
  const replyText = msg.content || "Sorry, could you repeat that?";
  call.transcript.push({ role: 'rex', text: replyText });
  try { call.ws.send(JSON.stringify({ type: 'text', token: replyText, last: true })); } catch (e) {}
}

// Constant-time comparison so a mistaken relay key can't be brute-forced by
// timing how fast each guess is rejected - overkill for a 48-char random
// token guessed over the internet, but cheap and standard practice here.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  try { return crypto.timingSafeEqual(bufA, bufB); } catch (e) { return false; }
}

function startWsRelay(server) {
  const wss = new WebSocket.Server({ server, path: '/voice/relay' });
  wss.on('connection', (ws, req) => {
    // Every connection must present the per-boot relay secret this app put
    // into the relay URL it gave Twilio (see callRelaySecret above) -
    // anyone else who opens a WebSocket here (e.g. having found the ngrok
    // URL) is rejected before a single message is trusted.
    let presentedKey = null;
    try { presentedKey = new URL(req.url, 'http://127.0.0.1').searchParams.get('key'); } catch (e) {}
    if (!callRelaySecret || !safeEqual(presentedKey, callRelaySecret)) {
      try { ws.close(1008, 'unauthorized'); } catch (e) {}
      return;
    }
    let callSid = null;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      // JSON.parse succeeds (and returns null/a primitive) for plenty of
      // non-object input ("null", "42", "\"hi\"") - guard against treating
      // that as a message shape, since msg.type below would otherwise throw
      // on anything that isn't an object and take the whole app down with it.
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'setup') {
        callSid = msg.callSid;
        const custom = msg.customParameters || {};
        const direction = custom.direction === 'outbound' ? 'outbound' : 'inbound';
        const goal = custom.goal || '';
        const call = {
          ws, callSid, from: msg.from, to: msg.to, direction, goal,
          startedAt: Date.now(), transcript: [], pendingAction: null,
          convo: [{ role: 'system', content: buildCallSystemPrompt(direction, goal) }],
        };
        activeCalls.set(callSid, call);
        notifyRenderer('call:started', { callSid, from: msg.from, to: msg.to, direction, goal });
        if (direction === 'outbound') advanceCallTurn(callSid, null);
      } else if (msg.type === 'prompt') {
        if (!msg.last || !callSid) return;
        advanceCallTurn(callSid, msg.voicePrompt);
      } else if (msg.type === 'error') {
        console.error('[call relay] Twilio reported an error:', msg.description);
      }
      // dtmf / interrupt: no action needed for this build - Twilio already
      // stops playback on an interrupt on its own side of the protocol.
    });
    ws.on('close', () => { if (callSid) endActiveCall(callSid); });
  });
  return wss;
}

/* ---- outbound calls ---- */

async function placeOutboundCall(toNumber, goal, settings) {
  if (!publicCallUrl) return { ok: false, error: "The call server isn't running - make sure Calling is turned on in Setup and the tunnel has connected." };
  if (!settings.twilioPhoneNumber) return { ok: false, error: 'No Twilio phone number set in Setup.' };
  let client;
  try { client = getTwilioClient(settings); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  const connect = response.connect({ action: `${publicCallUrl}/voice/connect-action`, method: 'POST' });
  const cr = connect.conversationRelay(buildConversationRelayOptions(settings, {
    url: `${publicCallUrl.replace(/^http/, 'ws')}/voice/relay?key=${callRelaySecret}`,
  }));
  cr.parameter({ name: 'direction', value: 'outbound' });
  cr.parameter({ name: 'goal', value: goal || '' });
  try {
    const call = await client.calls.create({ to: toNumber, from: settings.twilioPhoneNumber, twiml: response.toString() });
    return { ok: true, callSid: call.sid };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/* ---- ngrok tunnel (spawned as a child process - see the note at the top of this section) ---- */

function startNgrokTunnel(settings) {
  return new Promise((resolve, reject) => {
    const exePath = (settings.ngrokExePath && settings.ngrokExePath.trim()) || 'ngrok';
    const authProc = spawn(exePath, ['config', 'add-authtoken', settings.ngrokAuthtoken], { windowsHide: true });
    let authErr = '';
    if (authProc.stderr) authProc.stderr.on('data', (d) => { authErr += d; });
    authProc.on('error', (err) => {
      reject(new Error(err.code === 'ENOENT'
        ? `Could not find ngrok ("${exePath}"). Download it from ngrok.com/download and either add it to PATH or paste the full path to ngrok.exe in Setup.`
        : `Could not start ngrok: ${String(err.message || err)}`));
    });
    authProc.on('close', (code) => {
      if (code !== 0) { reject(new Error(`"ngrok config add-authtoken" failed: ${authErr.trim() || 'unknown error'}`)); return; }

      const rawDomain = (settings.ngrokStaticDomain || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!rawDomain) { reject(new Error('No ngrok static domain set in Setup.')); return; }
      ngrokChild = spawn(exePath, ['http', `--url=https://${rawDomain}`, '--log=stdout', String(CALL_SERVER_PORT)], { windowsHide: true });

      let settled = false;
      let stderrBuf = '';
      const timer = setTimeout(() => {
        if (!settled) { settled = true; clearInterval(poll); reject(new Error('Timed out waiting for the ngrok tunnel to come up.')); }
      }, 20000);
      if (ngrokChild.stderr) ngrokChild.stderr.on('data', (d) => { stderrBuf += d; });
      ngrokChild.on('error', (err) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearInterval(poll);
        reject(new Error(err.code === 'ENOENT'
          ? `Could not find ngrok ("${exePath}"). Download it from ngrok.com/download and either add it to PATH or paste the full path to ngrok.exe in Setup.`
          : `Could not start ngrok: ${String(err.message || err)}`));
      });
      ngrokChild.on('exit', (code) => {
        clearInterval(poll);
        if (settled || code === 0 || code === null) return;
        settled = true; clearTimeout(timer);
        const friendly = /ERR_NGROK_334/.test(stderrBuf)
          ? 'A previous ngrok tunnel session is still marked online (probably from an earlier crash) - open Task Manager, end any leftover ngrok.exe process, wait a moment, then try again.'
          : `ngrok exited unexpectedly (code ${code}). ${stderrBuf.slice(0, 300)}`;
        reject(new Error(friendly));
      });
      // Poll ngrok's own local status API rather than parsing stdout text
      // (which varies by version/flags) for the confirmed-live public URL.
      const poll = setInterval(async () => {
        if (settled) { clearInterval(poll); return; }
        try {
          const r = await fetch('http://127.0.0.1:4040/api/tunnels');
          const d = await r.json().catch(() => null);
          const t = d && Array.isArray(d.tunnels) && d.tunnels.find((x) => x.public_url && /^https:/.test(x.public_url));
          if (t && !settled) {
            settled = true; clearInterval(poll); clearTimeout(timer);
            resolve(t.public_url.replace(/\/$/, ''));
          }
        } catch (e) { /* not up yet - keep polling until the timeout above */ }
      }, 1000);
    });
  });
}

function stopNgrokTunnel() {
  return new Promise((resolve) => {
    if (!ngrokChild) { resolve(); return; }
    const child = ngrokChild;
    ngrokChild = null;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once('exit', finish);
    try { child.kill(); } catch (e) { finish(); }
    setTimeout(finish, 3000); // don't hang app shutdown on a stuck process
  });
}

/* ---- start/stop the whole feature ---- */

// Two overlapping callers (the Setup switch double-clicked, or the switch
// clicked right as the launch-time auto-start from a previous "on" session
// is still in flight) must not both run the setup sequence at once - that
// can spawn two ngrok processes and only clean up one of them. Any call
// that arrives while a first one is still starting joins that same
// in-flight attempt (and gets its real outcome) instead of racing it.
let callServerStartPromise = null;

function startCallServer() {
  if (callServerStatus.running) return Promise.resolve(callServerStatus);
  if (callServerStartPromise) return callServerStartPromise;
  callServerStartPromise = startCallServerInner().finally(() => { callServerStartPromise = null; });
  return callServerStartPromise;
}

async function startCallServerInner() {
  const settings = getSettings();
  if (!settings.twilioAccountSid || !settings.twilioAuthToken || !settings.twilioPhoneNumber) {
    callServerStatus = { running: false, publicUrl: null, error: 'Add your Twilio Account SID, Auth Token, and phone number in Setup first.' };
    notifyRenderer('calling:status', callServerStatus);
    return callServerStatus;
  }
  if (!settings.ngrokAuthtoken || !settings.ngrokStaticDomain) {
    callServerStatus = { running: false, publicUrl: null, error: 'Add your ngrok authtoken and static domain in Setup first.' };
    notifyRenderer('calling:status', callServerStatus);
    return callServerStatus;
  }
  try {
    callRelaySecret = crypto.randomBytes(24).toString('hex');
    callHttpServer = http.createServer((req, res) => { handleCallHttp(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch (e) {} }); });
    await new Promise((resolve, reject) => {
      callHttpServer.once('error', reject);
      callHttpServer.listen(CALL_SERVER_PORT, '127.0.0.1', resolve);
    });
    callWss = startWsRelay(callHttpServer);

    publicCallUrl = await startNgrokTunnel(settings);

    const client = getTwilioClient(settings);
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: settings.twilioPhoneNumber, limit: 1 });
    if (!numbers.length) throw new Error(`Twilio phone number ${settings.twilioPhoneNumber} wasn't found on this account.`);
    await client.incomingPhoneNumbers(numbers[0].sid).update({ voiceUrl: `${publicCallUrl}/voice/incoming`, voiceMethod: 'POST' });

    callServerStatus = { running: true, publicUrl: publicCallUrl, error: null };
  } catch (err) {
    await stopCallServer();
    callServerStatus = { running: false, publicUrl: null, error: String(err.message || err) };
  }
  notifyRenderer('calling:status', callServerStatus);
  return callServerStatus;
}

async function stopCallServer() {
  await stopNgrokTunnel();
  // Every call still active when the server is torn down ends right now,
  // by definition - notify (and remove from activeCalls) synchronously
  // here rather than waiting on each socket's own 'close' event, which
  // endActiveCall's already-gone guard makes safe to still fire later too.
  for (const call of [...activeCalls.values()]) {
    endActiveCall(call.callSid);
    try { call.ws.close(); } catch (e) {}
  }
  if (callWss) { try { callWss.close(); } catch (e) {} callWss = null; }
  if (callHttpServer) { try { callHttpServer.close(); } catch (e) {} callHttpServer = null; }
  publicCallUrl = null;
  callRelaySecret = null;
  callServerStatus = { running: false, publicUrl: null, error: null };
}

ipcMain.handle('calling:setEnabled', async (evt, enabled) => {
  if (enabled) {
    const status = await startCallServer();
    // Only persist "on" if it actually came up - otherwise the switch would
    // show on with nothing running, and a broken setup would silently
    // retry (and fail again) on every future app launch.
    setSettings({ callingEnabled: !!status.running });
    return { ok: status.running, error: status.error, publicUrl: status.publicUrl, settings: cleanForRenderer(getSettings()) };
  }
  setSettings({ callingEnabled: false });
  await stopCallServer();
  return { ok: true, settings: cleanForRenderer(getSettings()) };
});
ipcMain.handle('calling:getStatus', () => callServerStatus);

/* -------------------------------- save-to-disk -------------------------------- */

async function saveBase64(base64, suggestedName) {
  try {
    const buf = Buffer.from(base64, 'base64');
    const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: suggestedName });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, buf);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

ipcMain.handle('file:saveDataUrl', async (evt, { dataUrl, suggestedName }) => {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUrl || '');
  if (!match) return { ok: false, error: 'Nothing to save yet.' };
  return saveBase64(match[2], suggestedName);
});

ipcMain.handle('file:saveBase64', async (evt, { base64, suggestedName }) => {
  return saveBase64(base64, suggestedName);
});

/* ================================================================
   THE AI BRAIN
   Real natural-language understanding + memory + tool use, replacing the
   old fixed command-phrase parser. The renderer sends the running
   conversation; this handler runs the OpenAI tool-calling loop entirely
   here (so keys/tokens never leave the main process) and returns the
   reply plus any structured "actions" (images, 3D models, search results,
   email lists, etc.) for the renderer to display in the HUD.
   ================================================================ */

function buildSystemPrompt() {
  // Rebuilt fresh per request (not a static constant) purely so "the
  // current date/time" below is always actually current - that's what lets
  // set_reminder resolve things like "at 11" or "in 20 minutes" correctly.
  const now = new Date();
  return `You are Rex, the AI running this desktop HUD app. Address the user as "sir" in a dry, capable, unflappable tone.

The current date and time on this PC is: ${now.toString()}.

Rules:
- Understand plain natural language. The user will never use special command phrasing - work out what they want yourself, and use tools whenever they'd genuinely help. Don't ask the user to rephrase or use a keyword.
- Answer questions yourself, from your own knowledge, by default - that's most of what you'll be asked (explanations, how-to, opinions, general facts, reasoning, definitions). Only call search_web when it will genuinely help: the user explicitly asks you to search/look something up, the answer depends on something that changes over time (current events, prices, scores, "latest ..."), or you're genuinely unsure of a specific fact. search_web is a quick lookup, not a full search engine - it often finds nothing for breaking news or live data. If it comes back empty, say so plainly in one breath and answer from what you know instead of stalling.
- Speak like a person talking, not a document. Always give a short, natural-sounding overview (usually 1-3 sentences) as your reply - never refuse or hedge because something is "too long to explain" or "too long to say." If a tool returned a lot of detail (search results, an email list, images, a generated model), the app automatically shows the full detail on screen, and automatically shows a clickable source link whenever search_web finds one - you only need to briefly, naturally summarize it in words, not read all of it out or recite the URL yourself.
- Your reply is spoken out loud through text-to-speech, not displayed as formatted text - never use markdown (no **bold**, *italics*, backticks, #headings, or - / 1. list syntax). Write it exactly as you'd say it out loud.
- You have the full conversation so far - use it to resolve follow-up questions naturally (e.g. "what about tomorrow", "make it blue instead").
- For set_reminder: resolve whatever time the user gives, however casually phrased (e.g. "at 11", "in 20 minutes", "in like 10 mins or whatever", "tomorrow at 3pm", "Friday morning") against the current date/time above, always picking the next upcoming occurrence, and say back what time you understood (e.g. "I'll remind you at 11 PM, sir") so the user can correct you if it's wrong. Give whenISO as local time with no timezone letter/offset (e.g. 2026-09-01T23:00:00) - not UTC/"Z".
- If a tool call fails because something isn't set up (no API key, an account isn't connected), say so plainly and briefly, and don't pretend it worked.
- For run_pc_command, only act when the user clearly wants something done on this PC, and prefer "start \"\" \"AppName\"" for launching applications on Windows so they open independently instead of blocking.
- For computer_task (seeing the screen and directly controlling the mouse/keyboard), use it when doing what the user asked requires interacting with something already on screen - clicking a specific button, filling in a form, navigating inside an app - rather than just launching something (that's run_pc_command). It watches and acts step by step in real time, so only reach for it when the user actually wants an on-screen action carried out, and be honest afterward if it didn't finish. Never use it to enter a password or payment details unless the user just gave you that exact information themselves.
- For make_call, get a real phone number and a clear goal before calling - ask the user if either is missing rather than guessing. You (Rex) conduct that call's conversation yourself in real time, separately from this chat - once you call make_call here, just tell the user the call is starting; you won't see how it went until they ask you to check back, since it happens in its own conversation.
- forward_call and decline_call act on a call Rex is currently screening for the user right now (you'll only be offered these tools when one is active) - use forward_call if the user asks to take/connect the call, decline_call if they say to decline/hang up on it.
- For check_calendar, use it whenever the user asks about their schedule, upcoming events, or whether they're free/busy - it covers every connected calendar account at once.
- Never mention which company's model or API powers you.`;
}

function buildToolDefs(caps) {
  const tools = [
    { type: 'function', function: { name: 'search_web', description: "Look up a specific fact or current/time-sensitive information you don't already know or that may have changed. Don't use this for general knowledge, explanations, or opinions you can already answer yourself.", parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'search_web_images', description: 'Search the web for real existing photos/images matching a query and show them to the user (not for creating new art - use generate_image for that).', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'generate_3d_model', description: 'Generate an interactive 3D model of an object the user describes and display it.', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } } },
    { type: 'function', function: { name: 'open_website', description: 'Open a URL in the user\'s default browser. Resolve common site names to their URL yourself (e.g. "youtube" -> https://youtube.com).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
    { type: 'function', function: { name: 'set_voice_muted', description: "Mute or unmute Rex's spoken voice.", parameters: { type: 'object', properties: { muted: { type: 'boolean' } }, required: ['muted'] } } },
    { type: 'function', function: { name: 'set_reminder', description: 'Schedule a spoken reminder for a specific future time - Rex will speak up on its own when it comes due, even without being asked anything then.', parameters: { type: 'object', properties: {
      message: { type: 'string', description: 'what to remind the user about, in a few words' },
      whenISO: { type: 'string', description: 'exact future date-time as YYYY-MM-DDTHH:MM:SS in local time (no "Z"/offset) - resolved from the current date/time you were given' },
    }, required: ['message', 'whenISO'] } } },
  ];
  if (caps.openaiKey) {
    tools.push({ type: 'function', function: { name: 'generate_image', description: 'Generate a brand-new AI image from a text description (art/illustration, not an existing photo - use search_web_images for real photos).', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } } });
  }
  if (caps.pcControlEnabled) {
    tools.push({ type: 'function', function: { name: 'run_pc_command', description: 'Run a Windows command to control this PC, e.g. launch an application. Prefix app launches with: start "" "AppName"', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } });
  }
  if (caps.screenControlEnabled) {
    tools.push({ type: 'function', function: { name: 'computer_task', description: 'Take direct control of the mouse and keyboard to complete something on screen by looking at live screenshots and clicking/typing - for things run_pc_command can\'t do because they need seeing and interacting with what\'s currently on screen (clicking a specific button, filling in a form, navigating inside an app that\'s already open). Give a clear, specific, self-contained description of the end goal, including any exact text/details to enter.', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } });
  }
  if (caps.gmailConnected || caps.outlookConnected || caps.nylasConnected) {
    tools.push({ type: 'function', function: { name: 'check_email', description: "Check the user's recent inbox message(s).", parameters: { type: 'object', properties: { provider: { type: 'string', enum: ['gmail', 'outlook', 'nylas', 'all'], description: '"nylas" means every account connected through the third-party account hub' } } } } });
  }
  if (caps.spotifyConnected) {
    tools.push({ type: 'function', function: { name: 'control_music', description: 'Play a song/artist on Spotify, or pause/resume/skip the current track.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['play', 'pause', 'resume', 'next', 'previous'] }, query: { type: 'string', description: 'song and/or artist name - only used when action is "play"' } }, required: ['action'] } } });
  }
  if (caps.nylasConnected) {
    tools.push({ type: 'function', function: { name: 'check_calendar', description: "Check the user's upcoming calendar events (next two weeks) across every account connected through the third-party account hub.", parameters: { type: 'object', properties: {} } } });
  }
  if (caps.callingEnabled) {
    tools.push({ type: 'function', function: { name: 'make_call', description: 'Place an outbound phone call and have a real-time voice conversation on it toward a stated goal.', parameters: { type: 'object', properties: {
      to: { type: 'string', description: 'phone number to call, in E.164 format e.g. +15551234567' },
      goal: { type: 'string', description: 'what to accomplish or say on this call' },
    }, required: ['to', 'goal'] } } });
    if (caps.hasActiveInboundCall) {
      tools.push({ type: 'function', function: { name: 'forward_call', description: "Connect the caller on the call Rex is currently screening through live to the user's real phone.", parameters: { type: 'object', properties: {} } } });
      tools.push({ type: 'function', function: { name: 'decline_call', description: 'End the call Rex is currently screening.', parameters: { type: 'object', properties: {} } } });
    }
  }
  return tools;
}

async function executeTool(name, args, settings, sender) {
  try {
    if (name === 'search_web') {
      const r = await doWebSearch(args.query);
      return { forModel: r.ok ? { answer: r.answer || '(no concise answer found)', sourceUrl: r.sourceUrl } : { error: r.error }, action: r.ok ? { type: 'web_search', query: args.query, answer: r.answer, sourceUrl: r.sourceUrl } : null };
    }
    if (name === 'search_web_images') {
      const r = await doSearchImages({ query: args.query, key: settings.imageSearchKey });
      return { forModel: r.ok ? { found: r.images.length } : { error: r.error }, action: r.ok && r.images.length ? { type: 'image_search', query: args.query, images: r.images } : null };
    }
    if (name === 'generate_image') {
      const r = await doGenerateImage({ prompt: args.prompt, key: settings.openaiKey, model: settings.openaiModel });
      return { forModel: r.ok ? { created: true } : { error: r.error }, action: r.ok ? { type: 'image_gen', prompt: args.prompt, dataUrl: r.dataUrl } : null };
    }
    if (name === 'generate_3d_model') {
      if (settings.meshyKey) {
        const r = await startMeshyTask(args.prompt, settings.meshyKey);
        if (!r.ok) return { forModel: { error: r.error }, action: null };
        pollMeshyTaskAndStream(r.taskId, settings.meshyKey, sender);
        return { forModel: { started: true, engine: 'meshy' }, action: { type: '3d_meshy_started', prompt: args.prompt, taskId: r.taskId } };
      }
      return { forModel: { started: true, engine: 'procedural' }, action: { type: '3d_procedural', prompt: args.prompt } };
    }
    if (name === 'run_pc_command') {
      const r = await doRunPcCommand(args.command, settings.pcControlEnabled);
      return { forModel: r, action: { type: 'pc_command', command: args.command, result: r } };
    }
    if (name === 'computer_task') {
      if (!settings.screenControlEnabled) {
        return { forModel: { error: 'Screen & input control is turned off. Enable it in Setup → Advanced if this is your own trusted PC.' }, action: null };
      }
      const r = await runComputerTask(args.task, settings, sender);
      return {
        forModel: r.ok ? { done: true, summary: r.summary, steps: r.steps } : { error: r.error },
        action: { type: 'computer_task_result', task: args.task, result: r },
      };
    }
    if (name === 'check_email') {
      const which = args.provider || 'all';
      const results = {};
      if ((which === 'gmail' || which === 'all') && settings.gmailConnected) {
        try { results.gmail = await doCheckGmail(); } catch (e) { results.gmailError = String(e.message || e); }
      }
      if ((which === 'outlook' || which === 'all') && settings.outlookConnected) {
        try { results.outlook = await doCheckOutlook(); } catch (e) { results.outlookError = String(e.message || e); }
      }
      const grants = Array.isArray(settings.nylasGrants) ? settings.nylasGrants : [];
      if ((which === 'nylas' || which === 'all') && grants.length) {
        const apiUri = (settings.nylasApiUri || 'https://api.us.nylas.com').replace(/\/$/, '');
        const nylasItems = [];
        const nylasErrors = [];
        for (const grant of grants) {
          try { nylasItems.push(...(await doCheckNylasGrant(grant, settings.nylasApiKey, apiUri))); }
          catch (e) { nylasErrors.push(String(e.message || e)); }
        }
        if (nylasItems.length) results.nylas = nylasItems;
        if (nylasErrors.length) results.nylasError = nylasErrors.join(' ');
      }
      if (!results.gmail && !results.outlook && !results.nylas && !results.gmailError && !results.outlookError && !results.nylasError) {
        return { forModel: { error: 'No email account is connected yet.' }, action: null };
      }
      return { forModel: results, action: { type: 'email_check', ...results } };
    }
    if (name === 'check_calendar') {
      const grants = Array.isArray(settings.nylasGrants) ? settings.nylasGrants : [];
      if (!grants.length) return { forModel: { error: 'No calendar account is connected yet.' }, action: null };
      const apiUri = (settings.nylasApiUri || 'https://api.us.nylas.com').replace(/\/$/, '');
      const events = [];
      const errors = [];
      for (const grant of grants) {
        try { events.push(...(await doCheckNylasCalendar(grant, settings.nylasApiKey, apiUri))); }
        catch (e) { errors.push(String(e.message || e)); }
      }
      events.sort((a, b) => a.startTs - b.startTs);
      if (!events.length && !errors.length) return { forModel: { error: 'No upcoming events in the next two weeks.' }, action: null };
      return { forModel: { events, errors: errors.length ? errors : undefined }, action: events.length ? { type: 'calendar_check', events } : null };
    }
    if (name === 'make_call') {
      if (!settings.callingEnabled) return { forModel: { error: 'Calling is turned off. Enable it in Setup first.' }, action: null };
      const to = String(args.to || '').trim();
      if (!to) return { forModel: { error: 'No phone number given.' }, action: null };
      const r = await placeOutboundCall(to, String(args.goal || '').trim(), settings);
      return { forModel: r, action: r.ok ? { type: 'call_started', to, goal: args.goal, direction: 'outbound' } : null };
    }
    if (name === 'forward_call' || name === 'decline_call') {
      const call = findActiveInboundCall();
      if (!call) return { forModel: { error: 'No call is currently active.' }, action: null };
      const action = name === 'forward_call' ? 'forward' : 'decline';
      speakThenMaybeEnd(call, '', action);
      return { forModel: { ok: true, action }, action: { type: 'call_action', action, from: call.from } };
    }
    if (name === 'control_music') {
      const r = await doSpotifyControl(args.action, args.query);
      return { forModel: r, action: { type: 'music', actionTaken: args.action, result: r } };
    }
    if (name === 'open_website') {
      let url = String(args.url || '').trim();
      if (!url) return { forModel: { error: 'No URL given.' }, action: null };
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      shell.openExternal(url);
      return { forModel: { opened: url }, action: { type: 'open_website', url } };
    }
    if (name === 'set_voice_muted') {
      return { forModel: { muted: !!args.muted }, action: { type: 'set_muted', muted: !!args.muted } };
    }
    if (name === 'set_reminder') {
      const msgText = String(args.message || '').trim();
      const when = new Date(String(args.whenISO || '').trim());
      if (!msgText || isNaN(when.getTime())) return { forModel: { error: 'Could not understand what to remind or when.' }, action: null };
      if (when.getTime() <= Date.now() - 5000) return { forModel: { error: 'That time is already in the past.' }, action: null };
      const current = getSettings(); // always read fresh from the main-process cache, not the caller's settings snapshot, when writing
      const existing = Array.isArray(current.reminders) ? current.reminders : [];
      const reminder = { id: crypto.randomUUID(), message: msgText, whenISO: when.toISOString(), createdISO: new Date().toISOString(), fired: false };
      setSettings({ reminders: [...existing, reminder] });
      return { forModel: { scheduled: true, whenISO: reminder.whenISO }, action: { type: 'reminder_set', message: msgText, whenISO: reminder.whenISO } };
    }
    return { forModel: { error: 'Unknown tool: ' + name }, action: null };
  } catch (err) {
    return { forModel: { error: String(err.message || err) }, action: null };
  }
}

// Caps total stored turns so context doesn't grow forever, without ever
// splitting an assistant tool_calls message from the tool results that
// must immediately follow it (the OpenAI API requires that pairing).
function trimConversation(messages, maxMessages = 24) {
  if (!Array.isArray(messages) || messages.length <= maxMessages) return messages || [];
  let start = messages.length - maxMessages;
  while (start > 0 && messages[start] && messages[start].role === 'tool') start++;
  return messages.slice(start);
}

// Some reasoning models reject function tools on /v1/chat/completions unless
// reasoning_effort is explicitly set to 'none' (the API says so in its own
// error text). Learned reactively the first time it's hit, then remembered
// for the rest of this run so later messages don't pay for a failed attempt
// first - reset naturally on the next app start in case a model changes.
let reasoningEffortNoneNeeded = false;

// Shared by the main conversation loop and the computer-control vision loop
// below - both are just "send this OpenAI chat-completions body, get JSON
// back" with the same self-correcting retry and the same error shaping.
async function callOpenAIChat(body, apiKey) {
  async function attempt(withReasoningNone) {
    const b = { ...body };
    if (withReasoningNone) b.reasoning_effort = 'none';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });
    const data = await res.json().catch(() => null);
    return { res, data };
  }
  let { res, data } = await attempt(reasoningEffortNoneNeeded);
  if (!res.ok && !reasoningEffortNoneNeeded && /reasoning_effort/i.test((data && data.error && data.error.message) || '')) {
    reasoningEffortNoneNeeded = true;
    ({ res, data } = await attempt(true));
  }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    const hint = res.status === 404 || /model/i.test(msg) ? ' (the AI Model name in Setup may need updating - check platform.openai.com/docs/models for the current name)' : '';
    return { ok: false, error: `AI request failed: ${msg}${hint}` };
  }
  return { ok: true, data };
}

/* -------------------------------- computer control (screen + mouse + keyboard) --------------------------------
   The "full control, at my will" feature: Rex can take a screenshot,
   show it to a vision-capable OpenAI model, get back one concrete action
   (click here, type this, press that key), carry it out for real on this
   PC, then repeat with a fresh screenshot - a bounded see/decide/act loop,
   not a one-shot blind command. Off by default (separate toggle from
   run_pc_command above) since it's the most capable thing this app can do.

   Input is injected via classic Win32 user32.dll calls (SetCursorPos,
   mouse_event, keybd_event, and System.Windows.Forms.SendKeys for
   arbitrary text) called from a short-lived PowerShell process, the same
   "acts like a VBScript" spirit as run_pc_command above - deliberately not
   the newer SendInput API's struct/union marshaling, which is easy to get
   subtly wrong in PowerShell and impossible to verify without a real
   Windows PC to test against. These are Windows-only, like PC control
   above; on any other OS they simply fail with a clear error.

   Known, documented limits worth being upfront about (see README): Windows
   blocks synthetic input from reaching an elevated/administrator window
   from this non-elevated app (UIPI) - there's no workaround short of
   running elevated. Only the primary display is captured/controlled - a
   second monitor is out of scope for now. Screenshots are sent to OpenAI's
   vision API for the model to look at, downscaled first to keep that fast
   and cheap - fine for finding buttons and reading normal UI text, but a
   very small on-screen detail could still be missed. */

const MAX_COMPUTER_STEPS = 12;

// Set by the renderer's stop/cancel handling (both the dedicated abort
// button on the live progress popup and the existing instant "stop"
// utterance) so a run can be interrupted between steps without waiting for
// the whole bounded loop to play out.
let computerTaskAbort = false;
ipcMain.on('computer:abort', () => { computerTaskAbort = true; });

async function captureScreenshot() {
  try {
    const primary = screen.getPrimaryDisplay();
    // Capped, not native resolution - keeps the image fast to capture, cheap
    // to send to the vision model, and quick for it to look at. Electron
    // scales *down to fit* this box while preserving aspect ratio, so the
    // real returned size (read back below via getSize()) is what actually
    // matters for coordinate math, not this request size itself.
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 1280 },
    });
    if (!sources.length) {
      return { ok: false, error: 'No screen source available to capture on this PC.' };
    }
    const source = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
    const img = source.thumbnail;
    const size = img.getSize();
    if (!size.width || !size.height) {
      return { ok: false, error: 'Screen capture returned an empty image.' };
    }
    return { ok: true, dataUrl: img.toDataURL(), imgWidth: size.width, imgHeight: size.height };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function clamp01(n) {
  if (typeof n !== 'number' || !isFinite(n)) return NaN;
  return Math.max(0, Math.min(1, n));
}
// A fixed-decimal string (never scientific notation) so it round-trips
// cleanly through an OS environment variable into PowerShell's parser.
function fmtFrac(n) {
  return (Math.round(clamp01(n) * 1e6) / 1e6).toFixed(6);
}

// Shared P/Invoke prelude for every generated script below. DPI-awareness
// matters here specifically: without it, Windows can silently hand this
// process a *virtualized* (scaled) view of the screen that doesn't match
// the real pixel grid SetCursorPos needs, especially on a scaled/multi-
// monitor setup. Also declares the GetForegroundWindow/GetWindowText pair
// used by the focus-title check further below - harmless to compile into
// scripts that don't call them. NOTE: the inline C# below is a PowerShell
// here-string (@"..."@), which - unlike everything else in these generated
// scripts - requires its closing "@ to start at column 0; do not indent
// this block.
const WIN32_PRELUDE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class RexInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
"@
[void][RexInput]::SetProcessDPIAware()
`.trim() + '\n';

const MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;

function buildMouseScript(fracX, fracY, action) {
  const clickBlocks = {
    move: '',
    left_click: `[RexInput]::mouse_event(${MOUSEEVENTF_LEFTDOWN}, 0, 0, 0, [UIntPtr]::Zero)\nStart-Sleep -Milliseconds 40\n[RexInput]::mouse_event(${MOUSEEVENTF_LEFTUP}, 0, 0, 0, [UIntPtr]::Zero)`,
    double_click: `[RexInput]::mouse_event(${MOUSEEVENTF_LEFTDOWN}, 0, 0, 0, [UIntPtr]::Zero)\nStart-Sleep -Milliseconds 40\n[RexInput]::mouse_event(${MOUSEEVENTF_LEFTUP}, 0, 0, 0, [UIntPtr]::Zero)\nStart-Sleep -Milliseconds 90\n[RexInput]::mouse_event(${MOUSEEVENTF_LEFTDOWN}, 0, 0, 0, [UIntPtr]::Zero)\nStart-Sleep -Milliseconds 40\n[RexInput]::mouse_event(${MOUSEEVENTF_LEFTUP}, 0, 0, 0, [UIntPtr]::Zero)`,
    right_click: `[RexInput]::mouse_event(${MOUSEEVENTF_RIGHTDOWN}, 0, 0, 0, [UIntPtr]::Zero)\nStart-Sleep -Milliseconds 40\n[RexInput]::mouse_event(${MOUSEEVENTF_RIGHTUP}, 0, 0, 0, [UIntPtr]::Zero)`,
  };
  const clickBlock = clickBlocks[action];
  if (clickBlock == null) return null;
  // Fractions of THIS process's own view of the primary screen, resolved to
  // real pixels here (after the DPI-awareness call above) rather than
  // trusting pixel math done back in the Electron process - see the
  // WIN32_PRELUDE comment above for why that distinction matters.
  return WIN32_PRELUDE + [
    '$fracX = [double]::Parse($env:REX_FRAC_X, [System.Globalization.CultureInfo]::InvariantCulture)',
    '$fracY = [double]::Parse($env:REX_FRAC_Y, [System.Globalization.CultureInfo]::InvariantCulture)',
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$targetX = [int]($bounds.Width * $fracX)',
    '$targetY = [int]($bounds.Height * $fracY)',
    '[RexInput]::SetCursorPos($targetX, $targetY)',
    'Start-Sleep -Milliseconds 60',
    clickBlock,
    '',
  ].join('\n');
}

const KEYEVENTF_KEYUP = 0x0002;
function buildKeyPressScript(vks) {
  const downs = vks.map((vk) => `[RexInput]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)`).join('\nStart-Sleep -Milliseconds 25\n');
  const ups = vks.slice().reverse().map((vk) => `[RexInput]::keybd_event(${vk}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero)`).join('\nStart-Sleep -Milliseconds 25\n');
  return WIN32_PRELUDE + `${downs}\nStart-Sleep -Milliseconds 50\n${ups}\n`;
}

const TYPE_TEXT_SCRIPT = WIN32_PRELUDE + '$text = $env:REX_TYPE_TEXT\n[System.Windows.Forms.SendKeys]::SendWait($text)\n';

// SendKeys' own escaping mini-language (Microsoft-documented): +^%~(){}[]
// are all special and must be individually wrapped in braces - including
// the brace characters themselves, which this loop happens to handle
// correctly too ('{' -> '{{}', '}' -> '{}}').
function escapeForSendKeys(text) {
  let out = '';
  for (const ch of String(text)) {
    if (ch === '\r') continue;
    if (ch === '\n') { out += '{ENTER}'; continue; }
    if (ch === '\t') { out += '{TAB}'; continue; }
    if ('+^%~(){}[]'.includes(ch)) { out += `{${ch}}`; continue; }
    out += ch;
  }
  return out;
}

// VK_A..VK_Z and VK_0..VK_9 are documented to equal their plain ASCII
// uppercase-letter/digit codes - stable, unchanging Win32 facts, not
// something that needs its own lookup entries below.
const VK_CODES = {
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b,
  backspace: 0x08, delete: 0x2e, del: 0x2e, space: 0x20, spacebar: 0x20,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, insert: 0x2d,
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10,
  win: 0x5b, windows: 0x5b, meta: 0x5b, cmd: 0x5b, super: 0x5b,
  capslock: 0x14, numlock: 0x90, printscreen: 0x2c,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
};
function keyNameToVk(name) {
  const n = String(name || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(VK_CODES, n)) return VK_CODES[n];
  if (/^[a-z]$/.test(n)) return n.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(n)) return n.charCodeAt(0);
  return null;
}
// "ctrl+alt+t" -> [0x11, 0x12, 0x54]; null if any part isn't recognized -
// never falls through to putting raw user text into the script source.
function parseKeyCombo(combo) {
  const parts = String(combo || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const vks = parts.map(keyNameToVk);
  if (vks.some((v) => v == null)) return null;
  return vks;
}

// Hard safety block, checked against the parsed VK-code SET - order, case,
// and spacing in how the model wrote the combo don't matter ("f4+alt",
// "Alt+F4", "ALT + F4" all match the same way). Alt+F4 closes whichever
// window currently holds OS focus, which - as this app learned the hard
// way - is not necessarily the window visible or intended on screen; right
// after this app is spoken to, its own window is a very plausible holder
// of that focus. Win+L instantly locks the whole PC. Both are too
// destructive to leave reachable by a single misjudged decision.
// Alt+Space is blocked alongside the two below for a less obvious reason:
// each "key" action here is fully atomic (down+up happen together inside
// one PowerShell call - see buildKeyPressScript - nothing stays held across
// separate steps), so a chorded combo like Alt+F4 genuinely can't be
// reconstructed by sending its keys as two separate steps. But Alt+Space
// isn't a chord being reconstructed - it's a real, complete, legitimate
// action in its own right that opens the focused window's system menu,
// which *stays open* as on-screen state afterward. A following, entirely
// separate "press C" step then activates that menu's Close mnemonic -
// same end result as Alt+F4, reached in two individually-unremarkable
// steps instead of one blocked one. Blocking Alt+Space itself closes that
// specific path; it doesn't (and can't) guarantee no other multi-step
// route to the same outcome exists - see the README's honest caveats.
const BLOCKED_COMBOS = [
  { keys: [0x12, 0x73], name: 'Alt+F4' },
  { keys: [0x5b, 0x4c], name: 'Win+L' },
  { keys: [0x12, 0x20], name: 'Alt+Space' },
];
function isBlockedCombo(vks) {
  const have = new Set(vks);
  for (const combo of BLOCKED_COMBOS) {
    if (have.size === combo.keys.length && combo.keys.every((k) => have.has(k))) {
      return combo.name;
    }
  }
  return null;
}

function runPowerShellScript(scriptBody, envVars, timeoutMs) {
  return new Promise((resolve) => {
    let tmpFile;
    try {
      tmpFile = path.join(os.tmpdir(), `rex-input-${crypto.randomUUID()}.ps1`);
      fs.writeFileSync(tmpFile, scriptBody, 'utf-8');
    } catch (err) {
      resolve({ ok: false, error: 'Could not prepare the input script: ' + String(err.message || err) });
      return;
    }
    const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch (e) {} };
    const childEnv = { ...process.env, ...(envVars || {}) };
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, { timeout: timeoutMs || 15000, windowsHide: true, env: childEnv }, (error, stdout, stderr) => {
      cleanup();
      if (error) {
        resolve({ ok: false, error: String(stderr || error.message || error).slice(0, 500) });
        return;
      }
      resolve({ ok: true, output: String(stdout || '').slice(0, 500) });
    });
  });
}

async function moveOrClick(fracX, fracY, action) {
  const script = buildMouseScript(fracX, fracY, action);
  if (!script) return { ok: false, error: 'Unknown mouse action: ' + action };
  return runPowerShellScript(script, { REX_FRAC_X: fmtFrac(fracX), REX_FRAC_Y: fmtFrac(fracY) });
}
async function pressKeyCombo(combo) {
  const vks = parseKeyCombo(combo);
  if (!vks) return { ok: false, error: `Unrecognized key or combo: "${combo}"` };
  const blocked = isBlockedCombo(vks);
  if (blocked) {
    return { ok: false, error: `${blocked} is blocked for safety - it acts on whatever currently has focus, which may not be the window you can see and mean to affect. Click that window's own close (X) button in its corner instead.` };
  }
  return runPowerShellScript(buildKeyPressScript(vks));
}
async function typeText(text) {
  const escaped = escapeForSendKeys(String(text || '').slice(0, 4000));
  return runPowerShellScript(TYPE_TEXT_SCRIPT, { REX_TYPE_TEXT: escaped }, 25000);
}

// Best-effort context for the vision model, not a control input itself -
// see the BLOCKED_COMBOS comment above for why this exists. Never blocks
// or fails a step: a PowerShell hiccup or a non-Windows OS just means the
// model isn't told a focus title this turn, same as if this didn't exist.
const FOCUS_CHECK_SCRIPT = WIN32_PRELUDE + [
  '$h = [RexInput]::GetForegroundWindow()',
  '$len = [RexInput]::GetWindowTextLength($h)',
  '$sb = New-Object System.Text.StringBuilder ($len + 1)',
  '[void][RexInput]::GetWindowText($h, $sb, $sb.Capacity)',
  '$sb.ToString()',
  '',
].join('\n');

async function getForegroundWindowTitle() {
  const result = await runPowerShellScript(FOCUS_CHECK_SCRIPT, null, 8000);
  if (!result.ok) return null;
  const title = String(result.output || '').trim();
  return title || null;
}

// Forced tool_choice below means the model has no way to reply with plain
// text here - every turn of the loop gets back exactly one structured
// decision, which is what makes this loop reliable to drive programmatically.
const VISION_ACTION_TOOL = {
  type: 'function',
  function: {
    name: 'report_next_action',
    description: 'Report the single next action to take on screen, based on the screenshot you were just shown.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'one short sentence: what you see and why this action' },
        action: { type: 'string', enum: ['left_click', 'double_click', 'right_click', 'move', 'type_text', 'key', 'wait', 'done', 'give_up'] },
        x: { type: 'number', description: 'for left_click/double_click/right_click/move: x pixel position within the screenshot image' },
        y: { type: 'number', description: 'for left_click/double_click/right_click/move: y pixel position within the screenshot image' },
        text: { type: 'string', description: 'for type_text: the exact text to type. For key: a key or combo, e.g. "enter", "ctrl+c", "alt+tab"' },
        summary: { type: 'string', description: 'for done/give_up: a short sentence summarizing the outcome, to say back to the user' },
      },
      required: ['reasoning', 'action'],
    },
  },
};

function buildVisionSystemPrompt(task, stepIndex, maxSteps) {
  const remaining = Math.max(1, maxSteps - stepIndex);
  return `You are Rex's screen-control agent - you can see this PC's screen and directly control its mouse and keyboard. Your job right now, exactly as the user asked for it: "${task}"

You'll be shown a screenshot before every decision, along with the title of whichever window currently has keyboard focus and a note on whether your last action succeeded. Call report_next_action exactly once with the single next action to take - never plan multiple steps ahead, since you'll see a fresh screenshot after this one before deciding the next.

Coordinates: give x and y as pixel positions measured on the screenshot image you were just shown, top-left corner is (0,0).

Rules:
- One action per turn. Look carefully at the screenshot before deciding.
- Keyboard input - typed text, single keys, and shortcuts like Ctrl+C or Alt+Tab - always goes to whichever window currently has OS focus (named for you each step), which is not necessarily whatever looks selected or relevant in the screenshot. If you're about to type or press a key and you're not sure the right window is focused, left_click directly on that window first, then send the keyboard input on your next turn.
- To close a window, prefer clicking its own visible close/X button in its corner over any keyboard shortcut. Alt+F4, Win+L, and Alt+Space are all blocked outright and will fail - they act on whatever currently has focus, which is easy to get wrong, so don't use any of them (including opening a system menu with Alt+Space to close a window from there instead).
- Use "done" the moment the task is genuinely complete - give a short one-sentence summary of what you did.
- Use "give_up" if this seems impossible, you're stuck repeating the same failed action, or something clearly isn't working - explain why in one sentence.
- Never type a password, payment card number, or other sensitive personal information unless the user's own request just now gave you that exact information directly - if a login or payment form shows up and you weren't given the specific details, stop and give_up rather than guessing.
- You have ${remaining} step${remaining === 1 ? '' : 's'} left in this attempt - if you're close to the limit and not done, wrap up or give_up rather than starting something new.`;
}

async function callVisionModel(dataUrl, systemPrompt, apiKey, model, focusTitle, lastActionNote) {
  const focusLine = focusTitle
    ? `The window currently focused (any keyboard input goes here) is titled: "${focusTitle}".`
    : `The currently-focused window could not be determined this step - if you're about to send keyboard input, click the intended window first to be sure.`;
  const noteLine = lastActionNote ? ` ${lastActionNote}` : '';
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [
        { type: 'text', text: `Here is the current screenshot. ${focusLine}${noteLine} Call report_next_action with the single next action to take.` },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] },
    ],
    tools: [VISION_ACTION_TOOL],
    tool_choice: { type: 'function', function: { name: 'report_next_action' } },
    temperature: 0.2,
  };
  return callOpenAIChat(body, apiKey);
}

async function runComputerTask(taskDescription, settings, sender) {
  const send = (payload) => { if (sender && !sender.isDestroyed()) sender.send('computer:progress', payload); };
  computerTaskAbort = false;
  const model = settings.aiModel || 'gpt-5.6-luna';
  const task = String(taskDescription || '').slice(0, 500) || 'do what the user just asked, on screen';
  send({ stage: 'starting', task, maxSteps: MAX_COMPUTER_STEPS });

  // The whole step loop below is wrapped so ANY unexpected throw (most
  // plausibly callOpenAIChat's fetch() rejecting at the network level
  // rather than resolving with an HTTP error status - a transport failure
  // isn't the same as a handled !ok response) still reaches send() with a
  // terminal stage. Without this, the live progress popup this function
  // already opened via 'starting' above would be left stuck on whatever
  // its last step showed, with no error and a Stop button that has nothing
  // left to stop - the same guarantee the two other callOpenAIChat call
  // sites (advanceCallTurnInner, pollMeshyTaskAndStream) already provide.
  try {
    return await runComputerTaskLoop(task, model, settings, send);
  } catch (err) {
    const error = String((err && err.message) || err || 'Something went wrong.');
    send({ stage: 'error', error });
    return { ok: false, error };
  }
}

async function runComputerTaskLoop(task, model, settings, send) {
  // Carried between iterations so the model finds out on its NEXT turn if
  // its last action actually failed (e.g. a blocked shortcut) instead of
  // blindly repeating it - each vision call below is otherwise a fresh,
  // stateless single turn (just the system prompt + that step's screenshot).
  let lastActionNote = null;

  for (let step = 0; step < MAX_COMPUTER_STEPS; step++) {
    if (computerTaskAbort) {
      send({ stage: 'aborted', step: step + 1 });
      return { ok: true, summary: 'Stopped, sir — you asked me to stop.', steps: step };
    }

    const shot = await captureScreenshot();
    if (!shot.ok) {
      send({ stage: 'error', error: shot.error });
      return { ok: false, error: shot.error };
    }
    // Best-effort context, not a dependency - see getForegroundWindowTitle.
    const focusTitle = await getForegroundWindowTitle();
    send({ stage: 'thinking', step: step + 1, maxSteps: MAX_COMPUTER_STEPS, screenshotDataUrl: shot.dataUrl, focusTitle });

    if (computerTaskAbort) {
      send({ stage: 'aborted', step: step + 1 });
      return { ok: true, summary: 'Stopped, sir — you asked me to stop.', steps: step };
    }

    const sys = buildVisionSystemPrompt(task, step, MAX_COMPUTER_STEPS);
    const callResult = await callVisionModel(shot.dataUrl, sys, settings.openaiKey, model, focusTitle, lastActionNote);
    if (!callResult.ok) {
      send({ stage: 'error', error: callResult.error });
      return { ok: false, error: callResult.error };
    }
    const choice = callResult.data.choices && callResult.data.choices[0];
    const msg = choice && choice.message;
    const call = msg && Array.isArray(msg.tool_calls) && msg.tool_calls[0];
    if (!call) {
      send({ stage: 'error', error: 'The AI did not return a structured action.' });
      return { ok: false, error: 'The AI did not return a structured action.' };
    }
    let decision = {};
    try { decision = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
    const action = decision.action;

    send({
      stage: 'acting', step: step + 1, maxSteps: MAX_COMPUTER_STEPS, action,
      reasoning: decision.reasoning || '', x: decision.x, y: decision.y,
      text: (action === 'type_text' || action === 'key') ? decision.text : undefined,
      focusTitle,
    });

    if (action === 'done') {
      const summary = String(decision.summary || 'Done, sir.');
      send({ stage: 'done', step: step + 1, summary });
      return { ok: true, summary, steps: step + 1 };
    }
    if (action === 'give_up') {
      const summary = String(decision.summary || "I wasn't able to complete that, sir.");
      send({ stage: 'gave_up', step: step + 1, summary });
      return { ok: false, error: summary, steps: step + 1 };
    }

    let actResult = { ok: true };
    if (action === 'left_click' || action === 'right_click' || action === 'double_click' || action === 'move') {
      const fracX = clamp01(Number(decision.x) / shot.imgWidth);
      const fracY = clamp01(Number(decision.y) / shot.imgHeight);
      if (!isFinite(fracX) || !isFinite(fracY)) {
        actResult = { ok: false, error: 'The AI gave invalid coordinates.' };
      } else {
        actResult = await moveOrClick(fracX, fracY, action);
      }
    } else if (action === 'type_text') {
      actResult = await typeText(decision.text);
    } else if (action === 'key') {
      actResult = await pressKeyCombo(decision.text);
    } else if (action === 'wait') {
      await new Promise((r) => setTimeout(r, 1200));
    } else {
      actResult = { ok: false, error: 'Unknown action from the AI: ' + action };
    }

    if (!actResult.ok) {
      send({ stage: 'action_failed', step: step + 1, error: actResult.error });
      lastActionNote = `Note: your last action (${action}) FAILED: "${actResult.error}" - don't just repeat that, try something different this time.`;
    } else {
      lastActionNote = `Note: your last action (${action}) was carried out with no error.`;
    }
    await new Promise((r) => setTimeout(r, 500)); // let the OS/UI settle before the next screenshot
  }

  send({ stage: 'error', error: `Reached the ${MAX_COMPUTER_STEPS}-step limit without finishing.` });
  return { ok: false, error: `I reached my ${MAX_COMPUTER_STEPS}-step limit for this attempt without finishing, sir.` };
}

ipcMain.handle('ai:chat', async (evt, { messages, settings }) => {
  if (!settings || !settings.openaiKey) {
    return { ok: false, error: 'No OpenAI API key set - add one in Setup to give Rex a real AI brain.' };
  }
  const caps = {
    openaiKey: settings.openaiKey,
    pcControlEnabled: !!settings.pcControlEnabled,
    screenControlEnabled: !!settings.screenControlEnabled,
    gmailConnected: !!settings.gmailConnected,
    outlookConnected: !!settings.outlookConnected,
    spotifyConnected: !!settings.spotifyConnected,
    nylasConnected: Array.isArray(settings.nylasGrants) && settings.nylasGrants.length > 0,
    callingEnabled: !!settings.callingEnabled,
    hasActiveInboundCall: !!findActiveInboundCall(),
  };
  const tools = buildToolDefs(caps);
  let convo = [{ role: 'system', content: buildSystemPrompt() }, ...trimConversation(messages)];
  const newMessages = [];
  const actions = [];
  const model = settings.aiModel || 'gpt-5.6-luna';

  try {
    for (let round = 0; round < 5; round++) {
      const body = { model, messages: convo, tools, tool_choice: 'auto', temperature: 0.6 };
      const callResult = await callOpenAIChat(body, settings.openaiKey);
      if (!callResult.ok) return callResult;

      const choice = callResult.data.choices && callResult.data.choices[0];
      const msg = choice && choice.message;
      if (!msg) return { ok: false, error: 'No response from the AI.' };

      convo.push(msg);
      newMessages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return { ok: true, reply: msg.content || '', actions, newMessages };
      }

      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
        const result = await executeTool(call.function.name, args, settings, evt.sender);
        if (result.action) actions.push(result.action);
        const toolMsg = { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.forModel).slice(0, 4000) };
        convo.push(toolMsg);
        newMessages.push(toolMsg);
      }
    }
    return { ok: true, reply: "I'm still working through that, sir — could you ask again in a moment?", actions, newMessages };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
