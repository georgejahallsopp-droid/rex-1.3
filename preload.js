// Secure bridge: exposes a small, specific API to the renderer instead of
// raw Node/IPC access (contextIsolation is on, nodeIntegration is off).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  search: (query) => ipcRenderer.invoke('net:search', query),

  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  tts: {
    fishAudio: (text, opts) => ipcRenderer.invoke('net:speakFishAudio', { text, ...opts }),
  },

  image: {
    generate: (prompt, opts) => ipcRenderer.invoke('net:generateImage', { prompt, ...opts }),
    save: (dataUrl, suggestedName) => ipcRenderer.invoke('file:saveDataUrl', { dataUrl, suggestedName }),
  },

  model3d: {
    generateMeshy: (prompt, opts) => ipcRenderer.send('model3d:generateMeshy', { prompt, ...opts }),
    onProgress: (cb) => {
      const listener = (evt, data) => cb(data);
      ipcRenderer.on('model3d:progress', listener);
      return () => ipcRenderer.removeListener('model3d:progress', listener);
    },
    saveGlb: (base64, suggestedName) => ipcRenderer.invoke('file:saveBase64', { base64, suggestedName }),
  },

  // The AI brain: send the running conversation + current settings, get
  // back a reply plus any structured "actions" (images, 3D models, search
  // results, email lists, ...) for the HUD to render. All tool use (web
  // search, image gen, PC control, email, music) happens inside main.js.
  ai: {
    chat: (messages, settings) => ipcRenderer.invoke('ai:chat', { messages, settings }),
  },

  // Gmail / Outlook / Spotify / Nylas account connections (OAuth, opens the
  // system browser to sign in). `provider` is 'google' | 'microsoft' |
  // 'spotify' | 'nylas'. Nylas can hold many connected accounts at once -
  // see nylas.disconnectGrant below for removing just one of them.
  oauth: {
    connect: (provider) => ipcRenderer.invoke('oauth:connect', provider),
    disconnect: (provider) => ipcRenderer.invoke('oauth:disconnect', provider),
  },

  // Nylas-specific: disconnecting one grant out of a possibly-multi-account
  // list, which doesn't fit oauth.disconnect's single-provider shape above.
  nylas: {
    disconnectGrant: (grantId) => ipcRenderer.invoke('nylas:disconnectGrant', grantId),
  },

  // Phone calling (Twilio + ConversationRelay) - off by default, see Setup.
  // setEnabled starts/stops the local call server + tunnel and returns
  // whether it actually came up (it can fail - missing Twilio/ngrok
  // settings, ngrok not installed, tunnel timeout - error explains why).
  calling: {
    setEnabled: (enabled) => ipcRenderer.invoke('calling:setEnabled', enabled),
    getStatus: () => ipcRenderer.invoke('calling:getStatus'),
    onStatus: (cb) => {
      const listener = (evt, data) => cb(data);
      ipcRenderer.on('calling:status', listener);
      return () => ipcRenderer.removeListener('calling:status', listener);
    },
    // Fire unprompted - a call starting/ending isn't something the renderer
    // asked for, same spirit as reminders.onFire below.
    onCallStarted: (cb) => {
      const listener = (evt, data) => cb(data);
      ipcRenderer.on('call:started', listener);
      return () => ipcRenderer.removeListener('call:started', listener);
    },
    onCallEnded: (cb) => {
      const listener = (evt, data) => cb(data);
      ipcRenderer.on('call:ended', listener);
      return () => ipcRenderer.removeListener('call:ended', listener);
    },
  },

  // Fires unprompted (not in response to anything the renderer asked for)
  // whenever a set_reminder the AI scheduled comes due - see main.js's
  // checkReminders(). This is what lets Rex "speak on its own".
  reminders: {
    onFire: (cb) => {
      const listener = (evt, data) => cb(data);
      ipcRenderer.on('reminder:fire', listener);
      return () => ipcRenderer.removeListener('reminder:fire', listener);
    },
  },

  // Screen & input control (computer_task): main.js pushes live step-by-step
  // progress here while it runs - registered once at startup, not per call,
  // since only one task runs at a time. abort() lets the HUD interrupt a
  // run in progress (the existing "stop" utterance also calls this).
  computer: {
    onProgress: (cb) => {
      const listener = (evt, data) => cb(data);
      ipcRenderer.on('computer:progress', listener);
      return () => ipcRenderer.removeListener('computer:progress', listener);
    },
    abort: () => ipcRenderer.send('computer:abort'),
  },

  platform: process.platform,
  versions: { node: process.versions.node, electron: process.versions.electron, chrome: process.versions.chrome },
});
