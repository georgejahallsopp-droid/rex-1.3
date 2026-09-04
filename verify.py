import json
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8791/index.html"

MOCK_JARVIS_JS = r"""
window.__saved = {};
window.__opened = [];
window.__meshyListeners = [];
window.__aiChatCalls = [];

// Fake SpeechRecognition, installed before app.js's module-level
// `const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition`
// runs (this init script always runs first). Lets a test simulate speech
// input arriving - specifically to verify onFinalTranscript no longer gates
// on a wake-word prefix (removed per "always listening, no wake word").
class __FakeSpeechRecognition {
  constructor() { window.__recognitionInstance = this; }
  start() { window.__recognitionStarted = (window.__recognitionStarted || 0) + 1; }
  stop() {}
}
window.SpeechRecognition = __FakeSpeechRecognition;
window.__fireFinalTranscript = (text) => {
  const inst = window.__recognitionInstance;
  if (!inst || typeof inst.onresult !== 'function') return false;
  const resultItem = [{ transcript: text }];
  resultItem.isFinal = true;
  inst.onresult({ resultIndex: 0, results: [resultItem] });
  return true;
};

function __currentSettings() {
  return {
    fishKey:'', fishVoiceId:'17e9990aa92c4da8b09ad3f0f2231e48', fishModel:'s2.1-pro-free',
    openaiKey:'', openaiModel:'gpt-image-1', aiModel:'gpt-5.6-luna', meshyKey:'',
    googleSpeechKey:'', imageSearchKey:'', pcControlEnabled:false, screenControlEnabled:false,
    googleClientId:'', googleClientSecret:'', microsoftClientId:'', spotifyClientId:'',
    gmailConnected:false, gmailEmail:'', outlookConnected:false, outlookEmail:'',
    spotifyConnected:false, spotifyDisplayName:'',
    nylasApiKey:'', nylasClientId:'', nylasClientSecret:'', nylasApiUri:'https://api.us.nylas.com', nylasGrants:[],
    twilioAccountSid:'', twilioAuthToken:'', twilioPhoneNumber:'', userPhoneNumber:'',
    ngrokExePath:'', ngrokAuthtoken:'', ngrokStaticDomain:'', callingEnabled:false,
    muted:false, wakeMode:false,
    ...window.__saved,
  };
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

window.jarvis = {
  settings: {
    get: async () => __currentSettings(),
    set: async (patch) => { window.__saved = {...window.__saved, ...patch}; return __currentSettings(); }
  },
  search: async (query) => {
    if (query.includes('nosearch')) return { ok:false, error:'mock fail' };
    return { ok:true, answer:'Mock answer about ' + query, sourceUrl:'https://example.com/' + encodeURIComponent(query) };
  },
  openExternal: async (url) => { window.__opened.push(url); return { ok:true }; },
  tts: { fishAudio: async () => ({ ok:false, error:'mock: fish audio not reachable in test' }) },
  image: {
    generate: async (prompt, opts) => {
      if (!opts.key) return { ok:false, error:'no key' };
      return { ok:true, dataUrl: TINY_PNG };
    },
    save: async (dataUrl, name) => ({ ok:true, filePath:'/mock/path/' + name })
  },
  model3d: {
    generateMeshy: (prompt, opts) => {
      const token = opts.token;
      setTimeout(() => window.__meshyListeners.forEach(cb => cb({ stage:'creating', token })), 30);
      setTimeout(() => window.__meshyListeners.forEach(cb => cb({ stage:'polling', progress:50, token })), 80);
      setTimeout(() => window.__meshyListeners.forEach(cb => cb({ stage:'done', token, glbBase64: btoa('not-a-real-glb'), thumbnailUrl:null })), 160);
    },
    onProgress: (cb) => { window.__meshyListeners.push(cb); return () => { window.__meshyListeners = window.__meshyListeners.filter(x => x !== cb); }; },
    saveGlb: async (base64, name) => ({ ok:true, filePath:'/mock/path/' + name })
  },

  // Mock AI brain: inspects the latest user message and returns canned
  // replies/actions so the renderer's natural-language + action-rendering
  // path can be exercised the same way the real main.js tool loop would
  // drive it, without needing a real OpenAI key or network access.
  ai: {
    chat: async (messages, settings) => {
      window.__aiChatCalls.push(messages.length);
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const text = (lastUser && String(lastUser.content) || '').toLowerCase();
      const newMessages = [{ role: 'assistant', content: '(mock)' }];

      if (text.includes('ai-error-test')) return { ok:false, error:'mock AI backend error' };
      if (text.includes('memory-echo')) {
        const turns = messages.filter(m => m.role === 'user').length;
        return { ok:true, reply:`This is user turn number ${turns}, sir.`, actions:[], newMessages };
      }
      if (text.includes('picture') || text.includes('photo')) {
        return { ok:true, reply:'Here are some photos, sir.', actions:[{ type:'image_search', query:text, images:[
          { url:'https://example.com/full1.jpg', thumbnail: TINY_PNG, title:'Test1' },
          { url:'https://example.com/full2.jpg', thumbnail: TINY_PNG, title:'Test2' },
        ] }], newMessages };
      }
      if (text.includes('paint') || text.includes('draw')) {
        return { ok:true, reply:'Here is what I created, sir.', actions:[{ type:'image_gen', prompt:text, dataUrl: TINY_PNG }], newMessages };
      }
      if (text.includes('inbox') || text.includes('email')) {
        return { ok:true, reply:'You have 2 messages, one unread, sir.', actions:[{ type:'email_check', gmail:[
          { subject:'Test Subject 1', from:'Alice <alice@example.com>', snippet:'Hello there...', unread:true, date:new Date().toISOString() },
          { subject:'Test Subject 2', from:'Bob <bob@example.com>', snippet:'Following up...', unread:false, date:new Date().toISOString() },
        ] }], newMessages };
      }
      if (text.includes('nylas-accounts-test')) {
        // Mirrors main.js's executeTool: gmail/outlook stay separate, and
        // every connected Nylas grant's messages fan into one merged
        // `nylas` array, each item already carrying its own m.account.
        return { ok:true, reply:'You have 3 messages across your accounts, sir.', actions:[{ type:'email_check',
          gmail:[{ subject:'From Gmail', from:'Alice <alice@example.com>', snippet:'...', unread:true, date:new Date().toISOString() }],
          nylas:[{ subject:'From iCloud via Nylas', from:'Carol <carol@icloud.com>', snippet:'...', unread:false, date:new Date().toISOString(), account:'carol@icloud.com' }],
        } ], newMessages };
      }
      if (text.includes('calendar-test')) {
        const when = new Date(Date.now() + 3600 * 1000).toISOString();
        return { ok:true, reply:'A'.repeat(300), actions:[{ type:'calendar_check', events:[
          { when: 'Tomorrow 3:00 PM', title:'Dentist', location:'Main St Clinic', account:'a@example.com' },
          { when: 'Fri 10:00 AM', title:'Team sync', location:'', account:'a@example.com' },
        ] }], newMessages };
      }
      if (text.includes('calendar-empty-test')) {
        return { ok:true, reply:'Nothing on your calendar, sir.', actions:[{ type:'calendar_check', events:[] }], newMessages };
      }
      if (text.includes('call-test')) {
        return { ok:true, reply:"I'm calling them now, sir.", actions:[{ type:'call_started', to:'+15550100' }], newMessages };
      }
      if (text.includes('call-forward-test')) {
        return { ok:true, reply:'Connecting them through now, sir.', actions:[{ type:'call_action', action:'forward', from:'+15551234567' }], newMessages };
      }
      if (text.includes('call-decline-test')) {
        return { ok:true, reply:'Declining that call, sir.', actions:[{ type:'call_action', action:'decline', from:'+15551234567' }], newMessages };
      }
      if (text.includes('spotify-test')) {
        return { ok:true, reply:'Now playing, sir.', actions:[{ type:'music', actionTaken:'play', result:{ ok:true, track:'Test Track by Test Artist' } }], newMessages };
      }
      if (text.includes('pc-test')) {
        return { ok:true, reply:'Done, sir.', actions:[{ type:'pc_command', command:'start "" "Notepad"', result:{ ok:true, output:'' } }], newMessages };
      }
      if (text.includes('computer-task-test')) {
        // Simulates main.js's live 'computer:progress' stream firing DURING
        // the (in reality, blocking) ai:chat call, then the call resolving
        // with the final computer_task_result action - same shape as real.
        const cb = window.__computerProgressCb;
        if (cb) {
          cb({ stage:'starting', task:text, maxSteps:12 });
          cb({ stage:'thinking', step:1, maxSteps:12, screenshotDataUrl: TINY_PNG, focusTitle:'Google Chrome' });
          cb({ stage:'acting', step:1, maxSteps:12, action:'left_click', reasoning:'clicking the button', x:100, y:100, focusTitle:'Google Chrome' });
          cb({ stage:'done', step:2, summary:'Clicked the button, sir.' });
        }
        return { ok:true, reply:'Done, sir — I clicked the button.', actions:[{ type:'computer_task_result', task:text, result:{ ok:true, summary:'Clicked the button, sir.', steps:2 } }], newMessages };
      }
      if (text.includes('computer-task-fail-test')) {
        const cb = window.__computerProgressCb;
        if (cb) {
          cb({ stage:'starting', task:text, maxSteps:12 });
          cb({ stage:'gave_up', step:1, summary:"I couldn't find that, sir." });
        }
        return { ok:true, reply:"I wasn't able to do that, sir.", actions:[{ type:'computer_task_result', task:text, result:{ ok:false, error:"I couldn't find that, sir." } }], newMessages };
      }
      if (text.includes('computer-task-running-test')) {
        // Fires only the non-terminal progress stages and then never
        // resolves - simulates catching a task mid-run, e.g. to test the
        // STOP button while it's still genuinely showing.
        const cb = window.__computerProgressCb;
        if (cb) {
          cb({ stage:'starting', task:text, maxSteps:12 });
          cb({ stage:'thinking', step:1, maxSteps:12, screenshotDataUrl: TINY_PNG, focusTitle:'Notepad' });
          cb({ stage:'acting', step:1, maxSteps:12, action:'left_click', reasoning:'still going', x:50, y:50, focusTitle:'Notepad' });
        }
        return new Promise(() => {}); // deliberately never settles
      }
      if (text.includes('open github')) {
        return { ok:true, reply:'Opening GitHub, sir.', actions:[{ type:'open_website', url:'https://github.com' }], newMessages };
      }
      if (text.includes('mute yourself')) {
        return { ok:true, reply:'Muted, sir.', actions:[{ type:'set_muted', muted:true }], newMessages };
      }
      if (text.includes('long chat reply test')) {
        return { ok:true, reply:'A'.repeat(300), actions:[], newMessages };
      }
      if (text.includes('web-search-answer-test')) {
        // web_search WITH an answer: applyAction opens its own SEARCH
        // RESULT popup - a long reply alongside it must NOT also pop the
        // generic RESPONSE popup on top (hasVisualAction must say true here).
        return { ok:true, reply:'A'.repeat(300), actions:[{ type:'web_search', query:text, answer:'Mock search answer', sourceUrl:'https://example.com/mock' }], newMessages };
      }
      if (text.includes('web-search-noanswer-test')) {
        // web_search with NO answer (only a source link, or nothing useful
        // found): applyAction opens no popup for it at all - a long reply
        // here must still get its OWN RESPONSE popup (hasVisualAction must
        // say false here, not treat every web_search as visual regardless
        // of whether applyAction actually opened anything - this was a
        // real bug found in the final sweep, fixed in hasVisualAction).
        return { ok:true, reply:'B'.repeat(300), actions:[{ type:'web_search', query:text, sourceUrl:'https://example.com/mock' }], newMessages };
      }
      if (text.includes('3d-test')) {
        return { ok:true, reply:'Building that now, sir.', actions:[{ type:'3d_procedural', prompt:text }], newMessages };
      }
      if (text.includes('markdown-test')) {
        return { ok:true, reply:"Sure, sir — **done** and here is `code`.\n* one\n* two", actions:[], newMessages };
      }
      if (text.includes('remind me')) {
        const whenISO = new Date(Date.now() + 3600000).toISOString();
        return { ok:true, reply:"I'll remind you at that time, sir.", actions:[{ type:'reminder_set', message:'take the bins out', whenISO }], newMessages };
      }
      return { ok:true, reply:`Mock AI reply about "${text}", sir.`, actions:[], newMessages };
    }
  },

  oauth: {
    connect: async (provider) => {
      if (provider === 'google') { window.__saved = {...window.__saved, gmailConnected:true, gmailEmail:'test@gmail.com'}; return { ok:true, email:'test@gmail.com', settings: __currentSettings() }; }
      if (provider === 'microsoft') { window.__saved = {...window.__saved, outlookConnected:true, outlookEmail:'test@outlook.com'}; return { ok:true, email:'test@outlook.com', settings: __currentSettings() }; }
      if (provider === 'spotify') { window.__saved = {...window.__saved, spotifyConnected:true, spotifyDisplayName:'TestUser'}; return { ok:true, email:'TestUser', settings: __currentSettings() }; }
      if (provider === 'nylas') {
        if (window.__nylasShouldFail) return { ok:false, error:'mock nylas sign-in failure' };
        const n = (window.__saved.nylasGrants || []).length + 1;
        const grant = { grantId:'grant' + n, email:`account${n}@example.com`, provider: n === 1 ? 'google' : 'imap' };
        window.__saved = {...window.__saved, nylasGrants:[...(window.__saved.nylasGrants || []), grant]};
        return { ok:true, email:grant.email, settings: __currentSettings() };
      }
      return { ok:false, error:'unknown provider' };
    },
    disconnect: async (provider) => {
      if (provider === 'google') window.__saved = {...window.__saved, gmailConnected:false, gmailEmail:''};
      if (provider === 'microsoft') window.__saved = {...window.__saved, outlookConnected:false, outlookEmail:''};
      if (provider === 'spotify') window.__saved = {...window.__saved, spotifyConnected:false, spotifyDisplayName:''};
      return { ok:true, settings: __currentSettings() };
    },
  },

  // Captures the callback the renderer registers on init() so a test can
  // invoke it directly to simulate an unprompted reminder firing, exactly
  // as main.js's checkReminders() -> preload's reminders.onFire would.
  reminders: {
    onFire: (cb) => { window.__reminderFireCb = cb; return () => { window.__reminderFireCb = null; }; },
  },

  // Mirrors the reminders mock above: captures the callback registered
  // once at init() so a test (or, here, the ai.chat mock itself) can
  // invoke it directly to simulate main.js's live progress stream.
  computer: {
    onProgress: (cb) => { window.__computerProgressCb = cb; return () => { window.__computerProgressCb = null; }; },
    abort: () => { window.__computerAborts = (window.__computerAborts || 0) + 1; },
  },

  // Nylas grants are a growing list (not a single connected/disconnected
  // flag like Gmail/Outlook/Spotify) - connecting again adds another grant,
  // mirroring main.js's connectProvider('nylas') appending to the array.
  nylas: {
    disconnectGrant: async (grantId) => {
      const remaining = (window.__saved.nylasGrants || []).filter(g => g.grantId !== grantId);
      window.__saved = {...window.__saved, nylasGrants: remaining};
      return { ok:true, settings: __currentSettings() };
    },
  },

  // Starting/stopping the call server is async and can fail (bad Twilio
  // creds, ngrok not reachable, etc.) - window.__callingShouldFail lets a
  // test force that failure path without needing a real Twilio account.
  calling: {
    setEnabled: async (enabled) => {
      if (enabled && window.__callingShouldFail) {
        return { ok:false, error:'mock: Add your Twilio Account SID, Auth Token, and phone number in Setup first.', settings: __currentSettings() };
      }
      window.__saved = {...window.__saved, callingEnabled: !!enabled};
      return { ok:true, publicUrl: enabled ? 'https://mock1234.ngrok-free.app' : null, settings: __currentSettings() };
    },
    getStatus: async () => ({ running: !!window.__saved.callingEnabled, publicUrl: window.__saved.callingEnabled ? 'https://mock1234.ngrok-free.app' : null, error: null }),
    onStatus: (cb) => { window.__callStatusCb = cb; return () => { window.__callStatusCb = null; }; },
    onCallStarted: (cb) => { window.__callStartedCb = cb; return () => { window.__callStartedCb = null; }; },
    onCallEnded: (cb) => { window.__callEndedCb = cb; return () => { window.__callEndedCb = null; }; },
  },

  platform: 'linux',
  versions: { node:'22', electron:'mock', chrome:'mock' }
};
"""

console_msgs = []
page_errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    context = browser.new_context(permissions=["microphone", "clipboard-read", "clipboard-write"])
    context.add_init_script(MOCK_JARVIS_JS)
    page = context.new_page()
    page.on("console", lambda msg: console_msgs.append(f"[{msg.type}] {msg.text}"))
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))

    page.goto(URL)
    page.wait_for_timeout(1000)
    page.screenshot(path="../shot_idle.png")

    result = {}
    result["title"] = page.title()
    result["status_text"] = page.inner_text("#statusText")

    # mic toggle
    page.click("#micBtn")
    page.wait_for_timeout(800)
    result["status_after_mic_click"] = page.inner_text("#statusText")
    page.click("#micBtn")
    page.wait_for_timeout(200)

    # ============ PHASE 1: no AI key yet -> fixed-phrase fallback path ============

    page.click("#typeDockBtn"); page.wait_for_timeout(100)
    page.fill("#typeInput", "what time is it")
    page.click("#typeSendBtn")
    page.wait_for_timeout(300)

    page.click("#typeDockBtn"); page.wait_for_timeout(100)
    page.fill("#typeInput", "search for the speed of light")
    page.click("#typeSendBtn")
    page.wait_for_timeout(300)
    result["after_search"] = page.eval_on_selector_all("#transcript .line", "els => els.map(e => e.textContent)")

    page.click("#typeDockBtn"); page.wait_for_timeout(100)
    page.fill("#typeInput", "generate a 3d model of a saturn ring")
    page.click("#typeSendBtn")
    page.wait_for_timeout(600)
    result["fallback_result_panel_open_after_3d"] = page.eval_on_selector("#resultPanel", "el => el.classList.contains('show')")
    result["fallback_result_title_3d"] = page.inner_text("#resultTitle")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(200)

    # ============ settings: Google Speech key + PC control switch (UI only, no AI key yet) ============

    page.click("#settingsBtn"); page.wait_for_timeout(150)
    result["google_key_field_visible"] = page.eval_on_selector("#googleSpeechKeyInput", "el => el.offsetParent !== null")
    page.fill("#googleSpeechKeyInput", "AIzaTestKey123")
    page.dispatch_event("#googleSpeechKeyInput", "change")
    page.wait_for_timeout(100)

    result["pc_control_off_by_default"] = page.eval_on_selector("#pcControlSwitch", "el => !el.classList.contains('on')")
    page.click("#pcControlSwitch"); page.wait_for_timeout(100)
    result["pc_control_toggled_on"] = page.eval_on_selector("#pcControlSwitch", "el => el.classList.contains('on')")
    page.click("#pcControlSwitch"); page.wait_for_timeout(100)  # leave it off again

    result["screen_control_off_by_default"] = page.eval_on_selector("#screenControlSwitch", "el => !el.classList.contains('on')")
    page.click("#screenControlSwitch"); page.wait_for_timeout(100)
    result["screen_control_toggled_on"] = page.eval_on_selector("#screenControlSwitch", "el => el.classList.contains('on')")
    result["screen_control_persisted_in_settings"] = page.evaluate("() => window.__saved.screenControlEnabled === true")
    page.click("#screenControlSwitch"); page.wait_for_timeout(100)  # leave it off again

    page.click("#settingsPanel .panel-close"); page.wait_for_timeout(150)

    # ============ PHASE 2: set an OpenAI key -> everything now routes through the AI brain ============

    page.click("#settingsBtn"); page.wait_for_timeout(150)
    page.fill("#openaiKeyInput", "sk-test-123")
    page.dispatch_event("#openaiKeyInput", "change")
    page.click("#settingsPanel .panel-close"); page.wait_for_timeout(150)

    def send(text):
        page.click("#typeDockBtn"); page.wait_for_timeout(100)
        page.fill("#typeInput", text)
        page.click("#typeSendBtn")
        page.wait_for_timeout(400)

    # plain natural-language reply, no fixed phrase
    send("tell me something interesting")
    result["ai_plain_reply_line"] = page.eval_on_selector_all("#transcript .line.jarvis", "els => els.map(e=>e.textContent)")[-1]

    # follow-up / memory: two turns in a row, mock echoes how many user turns it has seen
    send("memory-echo first")
    reply1 = page.eval_on_selector_all("#transcript .line.jarvis", "els => els.map(e=>e.textContent)")[-1]
    send("memory-echo second")
    reply2 = page.eval_on_selector_all("#transcript .line.jarvis", "els => els.map(e=>e.textContent)")[-1]
    result["memory_turn_1"] = reply1
    result["memory_turn_2"] = reply2

    # web image search -> grid popup
    send("show me some pictures of the northern lights")
    result["image_search_popup_open"] = page.eval_on_selector("#resultPanel", "el => el.classList.contains('show')")
    result["image_search_grid_visible"] = page.eval_on_selector("#resultImageGrid", "el => !el.hidden")
    result["image_search_thumb_count"] = page.eval_on_selector_all("#resultImageGrid .grid-thumb", "els => els.length")
    page.screenshot(path="../shot_image_search.png")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # AI-driven image generation -> image popup
    send("paint me a dragon over a castle")
    result["ai_image_gen_visible"] = page.eval_on_selector("#resultImage", "el => !el.hidden")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # AI-driven 3D model
    send("3d-test build a crystal")
    result["ai_3d_panel_open"] = page.eval_on_selector("#resultPanel", "el => el.classList.contains('show')")
    result["ai_3d_canvas_visible"] = page.eval_on_selector("#result3dWrap", "el => !el.hidden")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # email check -> email list popup
    send("what's in my inbox")
    result["email_popup_open"] = page.eval_on_selector("#resultPanel", "el => el.classList.contains('show')")
    result["email_rows"] = page.eval_on_selector_all("#resultEmailList .email-row", "els => els.length")
    result["email_unread_rows"] = page.eval_on_selector_all("#resultEmailList .email-row.unread", "els => els.length")
    page.screenshot(path="../shot_email.png")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # music control -> transcript feedback, no popup
    send("spotify-test play something")
    result["music_sys_line"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]

    # pc command -> transcript feedback
    send("pc-test open notepad")
    result["pc_command_sys_line"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]

    # screen & input control -> live progress popup (opened by the first
    # 'starting' progress event, independent of the ai:chat call itself
    # resolving), showing the live screenshot and step status, then landing
    # on the final summary once the (simulated) task completes.
    send("computer-task-test click the button")
    result["computer_popup_open"] = page.eval_on_selector("#resultPanel", "el => el.classList.contains('show')")
    result["computer_shot_visible"] = page.eval_on_selector("#resultComputerShot", "el => !el.hidden")
    result["computer_final_status"] = page.inner_text("#resultComputerStatus")
    result["computer_stop_btn_hidden_after_done"] = page.eval_on_selector("#resultStopBtn", "el => el.hidden")
    result["computer_task_sys_line"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]
    page.screenshot(path="../shot_computer_control.png")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # screen & input control -> a give_up outcome is reported plainly too, not silently
    send("computer-task-fail-test do the impossible")
    result["computer_fail_status"] = page.inner_text("#resultComputerStatus")
    result["computer_fail_sys_line"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # the STOP button, clicked while a task is still genuinely in progress
    # (this scenario deliberately never reaches a terminal stage), calls
    # the abort bridge and updates the status optimistically
    send("computer-task-running-test click something else")
    result["computer_stop_btn_visible_midtask"] = page.eval_on_selector("#resultStopBtn", "el => !el.hidden")
    result["computer_midtask_status_shows_focus_title"] = page.inner_text("#resultComputerStatus")
    page.click("#resultStopBtn"); page.wait_for_timeout(100)
    result["computer_stop_btn_calls_abort"] = page.evaluate("() => window.__computerAborts > 0")
    result["computer_stopping_status"] = page.inner_text("#resultComputerStatus")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # open website via AI (no fixed "open ..." phrase required)
    send("open github for me")
    result["ai_opened_urls"] = page.evaluate("() => window.__opened")

    # mute via natural language (no "mute" fixed-phrase interception since it's not stop/cancel)
    send("please mute yourself")
    result["muted_after_ai_mute"] = page.eval_on_selector("#muteSwitch", "el => el.classList.contains('on')")
    # unmute via the UI so later checks aren't silently muted
    page.click("#muteDockBtn"); page.wait_for_timeout(100)

    # AI-driven reminder scheduling -> confirmation line in transcript
    send("remind me to take the bins out at 11")
    result["reminder_set_sys_line"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]

    # markdown slipping into a reply must be stripped before display/speech
    send("give me a markdown-test reply please")
    result["markdown_reply_line"] = page.eval_on_selector_all("#transcript .line.jarvis", "els => els.map(e=>e.textContent)")[-1]

    # reminders fire unprompted (not in reply to anything just sent) - simulate
    # main.js's checkReminders() -> preload's reminders.onFire firing directly.
    # (Checks the last line's content, not a before/after count - the
    # transcript intentionally caps at 6 visible lines and trims older ones,
    # so a raw count delta this deep into the test isn't reliable.)
    page.evaluate("""() => window.__reminderFireCb && window.__reminderFireCb({ id:'r1', message:'stretch your legs', whenISO:new Date().toISOString() })""")
    page.wait_for_timeout(200)
    jarvis_lines_after = page.eval_on_selector_all("#transcript .line.jarvis", "els => els.map(e=>e.textContent)")
    result["reminder_fired_unprompted"] = len(jarvis_lines_after) > 0 and 'stretch your legs' in jarvis_lines_after[-1]

    # long plain-text reply with no actions -> still falls back to a text popup
    send("long chat reply test")
    result["long_reply_popup_open"] = page.eval_on_selector("#resultPanel", "el => el.classList.contains('show')")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # AI backend error handling
    send("ai-error-test")
    result["ai_error_sys_line"] = [l for l in page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)") if 'AI error' in l]

    # instant local "stop" interception still works even with an AI key set
    page.click("#typeDockBtn"); page.wait_for_timeout(100)
    page.fill("#typeInput", "stop")
    page.click("#typeSendBtn")
    page.wait_for_timeout(200)
    result["stop_sys_line"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]

    # ============ always-listening / no wake word: speech input has no gate ============
    # onFinalTranscript no longer matches against a "hey/ok bot rex" regex at
    # all - whatever speech recognition returns is acted on directly, with
    # or without Always-Listening switched on. Simulates real mic input via
    # the fake SpeechRecognition installed above (typed input elsewhere in
    # this file never exercises onFinalTranscript, so this is the only
    # coverage of that path).
    result["recognition_instance_constructed"] = page.evaluate("() => !!window.__recognitionInstance")

    page.evaluate("() => window.__fireFinalTranscript('what is the boiling point of nitrogen')")
    page.wait_for_timeout(300)
    result["voice_no_wakeword_wakemode_off_user_line"] = page.eval_on_selector_all("#transcript .line.user", "els => els.map(e=>e.textContent)")[-1]
    result["voice_no_wakeword_wakemode_off_got_reply"] = page.eval_on_selector_all("#transcript .line.jarvis", "els => els.map(e=>e.textContent)")[-1]

    # turn Always-Listening on and confirm plain speech STILL needs no wake word
    page.click("#settingsBtn"); page.wait_for_timeout(150)
    page.click("#wakeSwitch"); page.wait_for_timeout(100)
    result["always_listening_toggled_on"] = page.eval_on_selector("#wakeSwitch", "el => el.classList.contains('on')")
    page.click("#settingsPanel .panel-close"); page.wait_for_timeout(150)

    page.evaluate("() => window.__fireFinalTranscript('remind me to check the oven in 10 minutes')")
    page.wait_for_timeout(400)
    result["voice_no_wakeword_wakemode_on_user_line"] = page.eval_on_selector_all("#transcript .line.user", "els => els.map(e=>e.textContent)")[-1]
    result["voice_no_wakeword_wakemode_on_sys_line"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]

    # leave Always-Listening off again for a clean end state
    page.click("#settingsBtn"); page.wait_for_timeout(150)
    page.click("#wakeSwitch"); page.wait_for_timeout(100)
    result["always_listening_left_off"] = page.eval_on_selector("#wakeSwitch", "el => !el.classList.contains('on')")
    page.click("#settingsPanel .panel-close"); page.wait_for_timeout(150)

    # ============ connect accounts (mocked OAuth) ============

    page.click("#settingsBtn"); page.wait_for_timeout(150)
    result["gmail_status_before"] = page.inner_text("#gmailStatus")
    page.click("#connectGmailBtn"); page.wait_for_timeout(200)
    result["gmail_status_after"] = page.inner_text("#gmailStatus")
    result["gmail_btn_after"] = page.inner_text("#connectGmailBtn")

    page.click("#connectOutlookBtn"); page.wait_for_timeout(200)
    result["outlook_status_after"] = page.inner_text("#outlookStatus")

    page.click("#connectSpotifyBtn"); page.wait_for_timeout(200)
    result["spotify_status_after"] = page.inner_text("#spotifyStatus")

    # disconnect Gmail again and confirm it reflects immediately
    page.click("#connectGmailBtn"); page.wait_for_timeout(200)
    result["gmail_status_after_disconnect"] = page.inner_text("#gmailStatus")

    page.screenshot(path="../shot_connect_accounts.png")
    page.click("#settingsPanel .panel-close"); page.wait_for_timeout(150)

    # ============ Nylas (third-party account hub): a growing list, not a single connection ============

    page.click("#settingsBtn"); page.wait_for_timeout(150)
    result["nylas_client_id_field_visible"] = page.eval_on_selector("#nylasClientIdInput", "el => el.offsetParent !== null")
    page.fill("#nylasApiKeyInput", "nylas-test-key")
    page.dispatch_event("#nylasApiKeyInput", "change")
    page.fill("#nylasClientIdInput", "nylas-test-client-id")
    page.dispatch_event("#nylasClientIdInput", "change")
    page.wait_for_timeout(100)
    result["nylas_key_persisted"] = page.evaluate("() => window.__saved.nylasApiKey === 'nylas-test-key' && window.__saved.nylasClientId === 'nylas-test-client-id'")

    result["nylas_grants_empty_by_default"] = page.inner_text("#nylasGrantsList")

    page.click("#connectNylasBtn"); page.wait_for_timeout(200)
    result["nylas_grant_rows_after_first_connect"] = page.eval_on_selector_all("#nylasGrantsList .connect-row", "els => els.length")
    result["nylas_sys_line_after_connect"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]

    page.click("#connectNylasBtn"); page.wait_for_timeout(200)
    result["nylas_grant_rows_after_second_connect"] = page.eval_on_selector_all("#nylasGrantsList .connect-row", "els => els.length")

    page.screenshot(path="../shot_nylas_grants.png")

    # disconnect the first grant, confirm the list shrinks back to one row
    page.click("#nylasGrantsList .connect-row:first-child button"); page.wait_for_timeout(200)
    result["nylas_grant_rows_after_disconnect"] = page.eval_on_selector_all("#nylasGrantsList .connect-row", "els => els.length")

    # a failed connect attempt is reported, not silently swallowed
    page.evaluate("() => { window.__nylasShouldFail = true; }")
    page.click("#connectNylasBtn"); page.wait_for_timeout(200)
    result["nylas_connect_failure_sys_line"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]
    result["nylas_grant_rows_unchanged_after_failed_connect"] = page.eval_on_selector_all("#nylasGrantsList .connect-row", "els => els.length")
    page.evaluate("() => { window.__nylasShouldFail = false; }")

    # ============ Calling (Twilio + ConversationRelay + ngrok) ============

    result["twilio_sid_field_visible"] = page.eval_on_selector("#twilioAccountSidInput", "el => el.offsetParent !== null")
    page.fill("#twilioAccountSidInput", "ACtestsid"); page.dispatch_event("#twilioAccountSidInput", "change")
    page.fill("#twilioAuthTokenInput", "twilio-test-token"); page.dispatch_event("#twilioAuthTokenInput", "change")
    page.fill("#twilioPhoneNumberInput", "+15559998888"); page.dispatch_event("#twilioPhoneNumberInput", "change")
    page.fill("#userPhoneNumberInput", "+15551112222"); page.dispatch_event("#userPhoneNumberInput", "change")
    page.fill("#ngrokAuthtokenInput", "ngrok-test-token"); page.dispatch_event("#ngrokAuthtokenInput", "change")
    page.fill("#ngrokStaticDomainInput", "test.ngrok-free.app"); page.dispatch_event("#ngrokStaticDomainInput", "change")
    page.wait_for_timeout(100)
    result["twilio_ngrok_fields_persisted"] = page.evaluate("""() => window.__saved.twilioAccountSid === 'ACtestsid'
      && window.__saved.twilioAuthToken === 'twilio-test-token' && window.__saved.twilioPhoneNumber === '+15559998888'
      && window.__saved.userPhoneNumber === '+15551112222' && window.__saved.ngrokAuthtoken === 'ngrok-test-token'
      && window.__saved.ngrokStaticDomain === 'test.ngrok-free.app'""")

    result["calling_switch_off_by_default"] = page.eval_on_selector("#callingSwitch", "el => !el.classList.contains('on')")
    result["calling_status_off_by_default"] = page.inner_text("#callingStatus")

    # turning it on succeeds (mocked) and shows the live tunnel URL
    page.click("#callingSwitch"); page.wait_for_timeout(200)
    result["calling_switch_on_after_success"] = page.eval_on_selector("#callingSwitch", "el => el.classList.contains('on')")
    result["calling_status_on_after_success"] = page.inner_text("#callingStatus")
    result["calling_sys_line_after_success"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]
    page.screenshot(path="../shot_calling_on.png")

    # turning it back off
    page.click("#callingSwitch"); page.wait_for_timeout(200)
    result["calling_switch_off_after_toggle_off"] = page.eval_on_selector("#callingSwitch", "el => !el.classList.contains('on')")
    result["calling_status_off_after_toggle_off"] = page.inner_text("#callingStatus")

    # turning it on when startup fails (bad/missing Twilio creds) reports the error and leaves it off
    page.evaluate("() => { window.__callingShouldFail = true; }")
    page.click("#callingSwitch"); page.wait_for_timeout(200)
    result["calling_switch_stays_off_after_failure"] = page.eval_on_selector("#callingSwitch", "el => !el.classList.contains('on')")
    result["calling_status_shows_error"] = page.inner_text("#callingStatus")
    result["calling_sys_line_after_failure"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]
    page.evaluate("() => { window.__callingShouldFail = false; }")

    page.click("#settingsPanel .panel-close"); page.wait_for_timeout(150)

    # ============ AI tool: check_calendar (Nylas) ============

    # the reply is deliberately >220 chars here to regression-test that a
    # long reply doesn't clobber the calendar popup applyAction() already
    # opened (hasVisualAction must list calendar_check - see app.js)
    send("calendar-test what's on my calendar")
    result["calendar_popup_open"] = page.eval_on_selector("#resultPanel", "el => el.classList.contains('show')")
    result["calendar_popup_title"] = page.inner_text("#resultTitle")
    result["calendar_popup_text"] = page.inner_text("#resultText")
    page.screenshot(path="../shot_calendar.png")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    send("calendar-empty-test anything on my calendar")
    result["calendar_empty_popup_text"] = page.inner_text("#resultText")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # ============ AI tool: web_search - hasVisualAction must mirror applyAction's OWN popup condition, not just the action type ============

    # WITH an answer: applyAction opens its own SEARCH RESULT popup; the long
    # reply alongside it must not also pop a second RESPONSE popup on top of it
    send("web-search-answer-test look that up")
    result["web_search_answer_popup_open"] = page.eval_on_selector("#resultPanel", "el => el.classList.contains('show')")
    result["web_search_answer_popup_title"] = page.inner_text("#resultTitle")
    page.screenshot(path="../shot_web_search_answer.png")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # WITHOUT an answer: applyAction opens no popup at all for it, so the long
    # reply must still get its own RESPONSE popup - this is the exact bug
    # found in the final sweep (hasVisualAction treated ANY web_search action
    # as visual, regardless of whether applyAction actually opened anything,
    # silently losing the RESPONSE popup for a long reply with nothing else on screen)
    send("web-search-noanswer-test look that up too")
    result["web_search_noanswer_popup_open"] = page.eval_on_selector("#resultPanel", "el => el.classList.contains('show')")
    result["web_search_noanswer_popup_title"] = page.inner_text("#resultTitle")
    result["web_search_noanswer_popup_text_matches_reply"] = page.inner_text("#resultText").startswith("B" * 50)
    page.screenshot(path="../shot_web_search_noanswer.png")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # ============ AI tool: check_email fans Nylas grants into the same inbox popup ============

    send("nylas-accounts-test check all my accounts")
    result["email_nylas_rows"] = page.eval_on_selector_all("#resultEmailList .email-row", "els => els.length")
    result["email_nylas_account_label_shown"] = "carol@icloud.com" in page.inner_text("#resultEmailList")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # ============ AI tool: make_call / forward_call / decline_call (sys-line feedback, no popup) ============

    send("call-test call the pizza place")
    result["call_started_sys_line"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]

    send("call-forward-test forward that call")
    result["call_forward_sys_line"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]

    send("call-decline-test decline that call")
    result["call_decline_sys_line"] = page.eval_on_selector_all("#transcript .line.sys", "els => els.map(e=>e.textContent)")[-1]

    # ============ calls happen unprompted, like reminders - main.js pushes start/end events directly ============

    # an inbound call arriving is announced the moment it's answered/screened, before it ends
    page.evaluate("""() => window.__callStartedCb && window.__callStartedCb({ direction:'inbound', from:'+15557654321' })""")
    page.wait_for_timeout(200)
    result["inbound_call_started_jarvis_line"] = page.eval_on_selector_all("#transcript .line.jarvis", "els => els.map(e=>e.textContent)")[-1]

    # that same call ending (forwarded through to the user) - both the spoken summary and the transcript popup
    page.evaluate("""() => window.__callEndedCb && window.__callEndedCb({
      direction:'inbound', from:'+15557654321', durationMs:65000, endedAction:'forward',
      transcript:[{role:'caller', text:'Is this Rex?'}, {role:'rex', text:'Yes, how can I help?'}]
    })""")
    page.wait_for_timeout(200)
    result["inbound_call_ended_jarvis_line"] = page.eval_on_selector_all("#transcript .line.jarvis", "els => els.map(e=>e.textContent)")[-1]
    result["call_transcript_popup_title"] = page.inner_text("#resultTitle")
    result["call_transcript_popup_subtitle"] = page.inner_text("#resultSubtitle")
    result["call_transcript_popup_text"] = page.inner_text("#resultText")
    page.screenshot(path="../shot_call_transcript.png")
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # an outbound call ending (started earlier via the make_call tool) reports "to", not "from"
    page.evaluate("""() => window.__callEndedCb && window.__callEndedCb({
      direction:'outbound', to:'+15550100', durationMs:12000,
      transcript:[{role:'rex', text:'Do you deliver to Main St?'}, {role:'caller', text:'Yes we do.'}]
    })""")
    page.wait_for_timeout(200)
    result["outbound_call_ended_jarvis_line"] = page.eval_on_selector_all("#transcript .line.jarvis", "els => els.map(e=>e.textContent)")[-1]
    page.click("#resultPanel .panel-close"); page.wait_for_timeout(150)

    # a spontaneous calling:status push (e.g. the tunnel dropped) updates Setup live, same pattern as reminders/computer progress
    page.click("#settingsBtn"); page.wait_for_timeout(150)
    page.evaluate("""() => window.__callStatusCb && window.__callStatusCb({ running:false, publicUrl:null, error:'ngrok tunnel closed unexpectedly' })""")
    page.wait_for_timeout(100)
    result["calling_status_live_push"] = page.inner_text("#callingStatus")
    result["calling_switch_live_push_off"] = page.eval_on_selector("#callingSwitch", "el => !el.classList.contains('on')")
    page.click("#settingsPanel .panel-close"); page.wait_for_timeout(150)

    # ============ clear log also clears AI memory ============
    page.click("#historyBtn"); page.wait_for_timeout(150)
    page.click("#clearLogBtn"); page.wait_for_timeout(150)
    page.click("#historyPanel .panel-close"); page.wait_for_timeout(100)
    send("memory-echo after clear")
    result["memory_after_clear"] = page.eval_on_selector_all("#transcript .line.jarvis", "els => els.map(e=>e.textContent)")[-1]

    # help panel + theme cycle (visual sanity)
    page.click("#helpBtn"); page.wait_for_timeout(150)
    page.screenshot(path="../shot_help.png")
    page.click("#helpPanel .panel-close"); page.wait_for_timeout(100)
    page.click("#themeBtn"); page.wait_for_timeout(400)

    result["opened_external_urls_all"] = page.evaluate("() => window.__opened")
    result["saved_settings"] = page.evaluate("() => window.__saved")

    browser.close()
    result["console_errors"] = [m for m in console_msgs if m.startswith("[error]")]
    result["page_errors"] = page_errors
    print(json.dumps(result, indent=2)[:14000])
