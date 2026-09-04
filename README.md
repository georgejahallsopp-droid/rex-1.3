# Rex

A HUD-style desktop AI assistant: talk to it naturally (no fixed phrases), it
remembers the conversation, searches the web, shows you real photos or paints
new AI art, builds 3D models you can spin around, checks your inbox and
calendar, plays music, sets reminders and speaks up on its own when they're
due, and — if you allow it — can run commands on this PC, take full hands-on
control of the mouse and keyboard by watching the screen and acting on what
it sees, or make and screen phone calls on your behalf. All in the same dark
teal/blue-green interface.

## Build the .exe (Windows)

1. If you don't already have it, install [Node.js](https://nodejs.org) (the LTS version - free, ~30 seconds, next-next-finish).
2. Double-click **`BUILD-WINDOWS.bat`**.
3. Wait a couple of minutes. When it's done, open the new `dist` folder - your app is `Rex.exe`.

That's it - `Rex.exe` is fully self-contained (portable, no installer). Copy it anywhere, pin it to your taskbar, whatever you like.

**First run:** Windows SmartScreen will very likely say "Windows protected your PC" because this isn't a signed, store-published app. That's normal for any indie/hobby desktop app - click **More info -> Run anyway**. Your antivirus may also want a moment to scan it the first time.

### No luck installing Node.js locally? Build it on GitHub instead

This repo includes `.github/workflows/build.yml`, which builds `Rex.exe` on GitHub's own Windows servers - nothing to install on your PC at all.

1. Create a free account at [github.com](https://github.com) if you don't have one.
2. Click **New repository** (the "+" in the top right), give it any name, leave it Public or Private (both are free), don't add a README, and click **Create repository**.
3. On the empty repo page, click **uploading an existing file**, then drag in every file and folder from this project (including the hidden `.github` folder) and click **Commit changes**.
4. Click the **Actions** tab - a build will already be running (it starts automatically on upload). It takes a few minutes.
5. When it finishes with a green check, click into that run, scroll down to **Artifacts**, and download **Rex-Windows-exe** - that's a zip containing your `Rex.exe`.

GitHub Actions is free for this (a few minutes of build time per run, well within the free monthly allowance). Same SmartScreen note applies on first run.

### Mac / Linux

The same project builds for other platforms too:
```
npm install
npm run dist:mac      # -> dist/mac/Rex.app
npm run dist:linux    # -> dist/Rex-*.AppImage
```
Screen & input control (below) is Windows-only - on Mac/Linux, everything
else works normally, that one feature just isn't offered.

## The most important key: giving Rex a real AI brain

Everything below is optional, but this one changes the whole app. Add an
**OpenAI API key** in Setup (from [platform.openai.com/api-keys](https://platform.openai.com/api-keys))
and Rex stops being a list of fixed phrases and becomes a real
conversational AI: it understands plain natural language, remembers what
you've said so you can ask follow-ups, and decides for itself which tool to
use (search, images, 3D, email, music, PC control, screen control) — you
never have to start a sentence a special way.

Without this key, Rex still works, just in a much simpler "Setup ->
Advanced" mode: a short list of fixed phrases like "search for...", "draw an
image of...", "generate a 3D model of...". See the Help panel in-app for the
full list either way. Screen & input control (below) needs this key either
way, and specifically needs a **vision-capable** model, since it works by
actually looking at screenshots.

If you ever see an error mentioning the AI model, OpenAI has likely renamed
or replaced the default model since this was written — open Setup, check
[platform.openai.com/docs/models](https://platform.openai.com/docs/models)
for the current recommended model name, and paste it into the **AI Model**
field.

## What it can do, and what each feature needs

Everything below is optional and set in the dial/Setup icon. With no keys at
all, Rex still does voice control, basic web search, opening websites, and
time/date.

| Feature | Say something like... | Needs |
|---|---|---|
| Real conversation, memory, follow-ups | *(just talk normally)* | OpenAI key — see above |
| Reminders — Rex speaks up on its own | "remind me to take the bins out at 11", "remind me in like 10 mins" | nothing extra (works even while you're not talking to it, as long as the app is running) |
| Web search | "what's the boiling point of nitrogen" | nothing extra |
| Rex's cloned voice | *(automatic once set)* | [fish.audio](https://fish.audio) key — the voice model ID from the link you shared is pre-filled |
| Real photos from the web | "show me pictures of the northern lights" | a [serper.dev](https://serper.dev) key — see below |
| New AI-generated art | "paint me a dragon over a castle" | OpenAI key (same one as the AI brain) |
| 3D models | "build me a 3D model of a crystal" | nothing extra (instant built-in shapes) — add a [meshy.ai](https://www.meshy.ai) key for a real textured AI mesh instead |
| Check your inbox | "what's in my inbox" | connect Gmail and/or Outlook, or connect any account through the third-party hub — see below |
| Check your calendar | "what's on my calendar this week" | connect an account through the third-party hub (Nylas) — see below |
| Play music | "play some Daft Punk", "pause", "skip" | connect Spotify (Premium) — see below |
| Control this PC | "open Lunar Client, then launch Minecraft" | turn on **Setup → Advanced → Allow PC Control** — see safety note below |
| Full mouse/keyboard/screen control | "click the login button and fill in my username" | turn on **Setup → Advanced → Allow Screen & Input Control**, plus a vision-capable AI Model — see safety note below |
| Make calls, and screen/forward/decline incoming ones | "call the pizza place at 555-0100 and ask if they deliver" | turn on **Setup → Advanced → Allow Calling** — a Twilio account, ngrok, and forwarding your real number — see safety note below |

Keys are stored only on your PC (encrypted at rest via Electron's OS-level
`safeStorage` where available) and are sent straight to the service they
belong to - never anywhere else.

### Always-listening voice — no wake word

Turning on **Setup → Always-Listening** keeps the mic open all the time and
acts on anything Rex hears, with no wake word and no need to click the mic
each time — just say "remind me to check the oven in like 10 minutes" and
it's handled, mid-conversation, hands-free.

Worth knowing before you turn it on: with no wake word, anything picked up
nearby that sounds like a request — a TV, a podcast, someone else talking —
can trigger a real response, and if PC Control or Screen & Input Control are
also switched on, that means a real action on this PC. If that's a concern
in your room, leave Always-Listening off and click the mic each time
instead. Saying "stop" (typed or spoken) always interrupts whatever Rex is
currently doing or saying, wake word or not.

### Web image search (Serper) — 2 minutes, free, no card

This is for real existing photos, separate from AI image generation above.

1. Go to [serper.dev](https://serper.dev) and sign up (Google login or email — no card needed).
2. Open the **Dashboard**, click **API Key** in the sidebar, and copy it.
3. Paste it into Setup → "SHOW ME PICTURES".

You get 2,500 free searches, no expiry pressure for personal use.

### Connect Gmail — ~5 minutes, free

Google requires you to register your own little "app" to get a Client ID —
this is normal for any tool that reads your Gmail, not specific to Rex.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (any name).
2. In the search bar, find **Gmail API** and click **Enable**.
3. Go to **APIs & Services → Google Auth Platform**. Under **Audience**, choose **External**, fill in an app name and your email, and — skipping this is the #1 reason Connect fails outright — add your own Gmail address under **Test users**.
4. Under **Data Access**, add the scope `.../auth/gmail.readonly`.
5. Go to **Clients → Create Client**. Application type: **Desktop app**. Give it a name, create it.
6. Copy the **Client ID** (you don't need the client secret) and paste it into Setup → "CONNECT YOUR ACCOUNTS" → the Gmail field, then click **CONNECT GMAIL** — your browser opens to sign in, then you're back in the app.

**What you'll see, and why it's normal:** the browser will show a page saying **"Google hasn't verified this app."** That's expected for a personal app like this one, not a sign anything's wrong or unsafe — it just hasn't been through Google's formal review process, which exists for companies shipping to the public, not for one person's own tool. Click the small **Advanced** link, then **Go to [app name] (unsafe)**, and sign in normally from there.

If instead you're blocked outright — an error page, not the warning above, with no way to continue — go back to step 3: your Gmail address almost certainly isn't on the Test users list yet. That's the difference between "scary but click-through-able" and "actually stuck."

**One more quirk to know about:** while your app is in "Testing" status (the simple setup above), Google expires the connection after 7 days and you'll need to click Connect again. Making it permanent requires Google's formal app-verification review, which is overkill for personal use — reconnecting occasionally is the trade-off for the 5-minute setup.

*(Considered routing Gmail/Outlook through a third-party email API instead of registering your own app, to skip this screen entirely — it turns out none of the free-tier options actually remove Google's warning for a single personal user, and the one that does starts at ~€50/month. Not worth it for what this saves you. Calendar access, if you ever want it, can piggyback on this exact same Google/Microsoft app with one more scope added — no new service needed.)*

### Connect Outlook / Hotmail — ~5 minutes, free

Hotmail addresses are Microsoft accounts today, so this covers both.

1. Go to [entra.microsoft.com](https://entra.microsoft.com) → **Entra ID → App registrations → New registration**.
2. Name it anything. Under **Supported account types**, choose the option covering **personal Microsoft accounts** as well as work/school ones (labelled something like *"Accounts in any organizational directory and personal Microsoft accounts"*).
3. Click **Register**, then go to **Authentication → Add a platform → Mobile and desktop applications**, and add the redirect URI `http://localhost`.
4. Copy the **Application (client) ID** from the Overview page and paste it into Setup → "CONNECT YOUR ACCOUNTS" → the Outlook field, then click **CONNECT OUTLOOK**.

No client secret needed — this is a "public client" sign-in, same idea as Gmail's.

### Connect Spotify — ~5 minutes, free, but needs Premium to actually play

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create an app (any name/description).
2. In its settings, add this **exact** Redirect URI: `http://127.0.0.1:53682/callback` (Spotify requires an exact match — `localhost` won't work, it has to be that literal address).
3. Copy the **Client ID** and paste it into Setup → "CONNECT YOUR ACCOUNTS" → the Spotify field, then click **CONNECT SPOTIFY**.

Playback control (play/pause/skip) is a **Spotify Premium** feature — free accounts get a clear "needs Premium" message instead. You also need Spotify already open somewhere (this PC, your phone, or open.spotify.com) as the active device Rex controls — it doesn't start Spotify itself.

### Connect accounts through a hub instead (Nylas) — a few minutes, free for personal use

Rather than registering your own Gmail and Outlook apps above, you can connect through [Nylas](https://www.nylas.com), a third-party hub built for exactly this: one hosted sign-in screen that adds Gmail, Outlook, iCloud, Yahoo and other providers without you registering a separate app with each one. It's **in addition to** the direct Gmail/Outlook connections above, not a replacement — connect whichever combination you like, and results from every connected source show up together when you ask about your inbox. It's also currently the only way to get **calendar checking** ("what's on my calendar this week"), since that isn't wired up through the direct Gmail/Outlook connections. You can connect as many accounts through the hub as you want; each shows up as its own row in Setup with its own **DISCONNECT** button.

1. Go to [dashboard-v3.nylas.com/register](https://dashboard-v3.nylas.com/register) and sign up free (no card needed).
2. Click **Create new app**. Choose a **Data residency** — US or EU; this is permanent for the app, so pick based on where you (or the accounts you're connecting) are — and an environment (the default is fine for personal use), then **Create application**.
3. On the new app's page, find its **Client ID** (shown on the app's overview/settings page) and copy it.
4. Go to **API Keys** in the sidebar → **Generate new key** → give it a name and an expiration → **Generate key**, and copy that too — treat it like a password, it's the one credential that can act on every account you connect.
5. Still in the app's settings, find where it lists **callback URIs** / **redirect URIs** and add exactly this one: `http://127.0.0.1:53682/callback` (same local address Spotify uses above). The sign-in step below will fail with a redirect-mismatch error if this is missed.
6. Paste the Client ID and API Key into Setup → "CONNECT YOUR ACCOUNTS" → the two Nylas fields, then click **CONNECT ACCOUNT** — a hosted page opens showing every provider Nylas supports; pick yours and sign in. Repeat from here (just click **CONNECT ACCOUNT** again) for each additional account.

If you chose the EU data residency in step 2, also change Setup's **API base URL** field to `https://api.eu.nylas.com` (it defaults to the US one).

**Cost:** free for personal use — Nylas's free plan includes 5 connected accounts with no card required, which comfortably covers a personal setup. (Their dashboard's own UI labels may shift a little over time since this was written; Client ID, API key, and callback/redirect URIs are standard OAuth-app concepts and should be easy to spot wherever they've moved to.)

### PC control — off by default, read this first

Turning on **Setup → Advanced → Allow PC Control** lets Rex run real
commands on this computer when you ask for something like "open Lunar
Client, then launch Minecraft" — the same idea as an old-school VBScript or
batch file automating your PC. It's genuinely capable, which means it's also
one of the two features here worth being deliberate about:

- It's **off by default** and stays off until you switch it on yourself.
- Every command Rex runs is echoed into the transcript, so nothing happens silently.
- Only turn it on for a PC that's yours and that you trust — the same judgement call you'd make before running any script you didn't personally write.
- It launches things (`start "" "AppName"` under the hood) rather than waiting on them, so a launched game or app keeps running fine after the command itself finishes.

### Screen & input control — off by default, read this first too

This is the big one: turning on **Setup → Advanced → Allow Screen & Input
Control** lets Rex take a screenshot, look at it with a vision-capable
AI model, and directly move your mouse, click, and type — then repeat with
a fresh screenshot, up to 12 steps per request. It's how it can do things
PC Control can't, like "click the login button", "fill in this form", or
"navigate to the settings page and turn off notifications" — anything that
needs actually seeing and interacting with what's already on screen, not
just launching something.

This is real, hands-on control of your PC, so it's worth reading this in full:

- It's **off by default**, separate from PC Control above, and stays off until you switch it on yourself.
- Every run shows a **live popup** with the actual screenshot Rex is looking at, what step it's on, and what it's doing — nothing happens off-screen, and you can watch it work in real time.
- A **STOP** button is right there in that popup, and just saying "stop" (typed or spoken) works too, same as interrupting anything else Rex is saying or doing.
- It stops itself after **12 steps** even if you never say stop, so a confused loop can't run forever.
- Before every action, it's told which window currently holds keyboard focus — not just what's visible in the screenshot — because keyboard input always goes to whichever window has OS focus, which isn't necessarily the one you can see or mean to affect. **Alt+F4, Win+L, and Alt+Space are blocked outright** and it's steered toward clicking a window's own close (X) button instead (Alt+Space opens a window's system menu, whose "Close" option is a two-step way to reach the same outcome as Alt+F4). This exists because of a real early bug: asked to close a browser window, it pressed Alt+F4 while this app's own window still had focus and closed Rex instead of the browser — this focus-awareness and the hard block are the fix.
- It's told never to type a password, card number, or other sensitive info unless *you* gave it that exact detail in your request — if it hits a login or payment form it wasn't given credentials for, it's instructed to stop rather than guess.
- **Windows only.** It uses `SetCursorPos`, `mouse_event`, `keybd_event`, and `SendKeys` (classic Win32 automation APIs — the same generation of tooling actual old-school VBScript/AutoIt automation used) via a short PowerShell script per action, run only while this is switched on.
- **Can't reach windows running "as administrator."** This is a genuine, on-purpose Windows security feature (User Interface Privilege Isolation) that blocks a normal, non-elevated app like this one from sending clicks/keystrokes into an elevated window — there's no setting here that changes that, short of running Rex itself as administrator, which isn't recommended.
- **Only the main/primary monitor** is captured and controlled — a second monitor isn't part of this yet.
- Screenshots are shrunk before being sent to the AI model (to keep it fast and cheap), which is plenty to find normal buttons/text but could miss something very small on screen.
- Each action has a moment of PowerShell start-up overhead, so a multi-step task will feel more deliberate than instant — that's expected, not a hang.
- Only turn this on for a PC that's yours and that you trust, for the same reason as PC Control above, just more so.

### Phone calling — off by default, the most involved feature here, real costs involved

Turning on **Setup → Advanced → Allow Calling** lets Rex place real outbound
phone calls and hold an actual spoken conversation toward a goal you give it
("call the pizza place at 555-0100 and ask if they deliver, and what time
they close"), and answers every inbound call to your real number itself —
screening it, taking a message and ending the call, or connecting the caller
through to you live if it judges that's worth interrupting you for. This is
the most involved thing to set up in this whole app: three separate
accounts, a small ongoing cost, and changing a setting with your phone
carrier. Take your time with it, and skip it entirely if you don't need
phone calls — everything else in Rex works fine without it.

**What's actually happening:** your phone number stays your phone number.
You forward calls Rex should handle to a number Twilio gives you; that
number's calls are answered by a small local web server this app runs, and
ngrok gives that local server a real public address so Twilio (out on the
internet) can reach it — the same reason Setup shows a "public URL" once
it's running. Nothing about your existing number, contacts, or carrier
plan changes beyond the one forwarding setting in step 4 below.

**1. Get a Twilio account and phone number (~5 minutes)**

1. Sign up free at [twilio.com/try-twilio](https://www.twilio.com/try-twilio) (a card is required to move off the free trial, which is very restrictive for this use — expect to add a small amount of credit).
2. From the [Twilio Console](https://console.twilio.com), buy a phone number: **Phone Numbers → Buy a number** (any number with **Voice** capability works — you don't need SMS).
3. On the Console's main dashboard, copy your **Account SID** and **Auth Token**, and paste them — along with the number you just bought (in the form `+15551234567`) and your own real phone number the same way — into Setup → Advanced → the Twilio fields.

**Cost:** this is the one feature here with an ongoing bill, and it's genuinely worth knowing upfront rather than finding out later. As of when this was written: a US number is roughly **$1/month** (Twilio's own [phone number pricing](https://www.twilio.com/en-us/phone-numbers) has the exact current figure), voice minutes are roughly **$0.0085/min received and $0.014/min made**, and the AI conversation layer Rex uses (ConversationRelay) adds roughly **$0.07/min** on top of that — call it **~8 cents a minute** all-in, plus the monthly number rental. Twilio's pricing changes and varies by country, so check the [Voice pricing page](https://www.twilio.com/en-us/voice/pricing/us) for the current number before relying on this. For occasional personal use this is a few dollars a month; it adds up if Rex is fielding long or frequent calls.

**2. Get ngrok and a free static domain (~5 minutes)**

Twilio needs a real internet address to send calls to, and this PC doesn't have one by default — that's what ngrok provides, a secure tunnel from a public address down to the local call server this app runs.

1. Download ngrok from [ngrok.com/download](https://ngrok.com/download) (the Windows zip — just `ngrok.exe`, nothing to install) and put it somewhere you'll remember, or note its full path.
2. Sign up free at [ngrok.com](https://ngrok.com) (no card needed) and copy your **authtoken** from the dashboard's **Your Authtoken** page.
3. In the dashboard under **Domains**, reserve your one free static domain (looks like `something-random.ngrok-free.app`) — free accounts get exactly one, and it's yours to keep using.
4. Paste the path to `ngrok.exe` (leave blank if you put it somewhere already on your PATH), the authtoken, and the static domain into Setup → Advanced → the ngrok fields.

**Cost:** free for this use. ngrok's free plan includes the one static domain (no expiry) plus 1 GB of bandwidth and 20,000 requests a month — comfortably enough for personal call volume, since a call holds open one connection rather than making repeated requests. If you ever see ngrok usage errors, its dashboard shows exactly how close you are to that monthly cap.

**3. Turn on Calling in Setup**

With both sections above filled in, flip **Setup → Advanced → Allow Calling** on. Setup's status line will show **On** with the live public URL once everything actually connects — or a specific error if something's missing, so you know exactly what to fix. Rex can now place outbound calls when you ask.

**4. Forward your real number to Rex (only needed for incoming calls)**

Outbound calling (step 3) works immediately. For Rex to screen *incoming* calls too, tell your own carrier to forward calls to the Twilio number from step 1 — done entirely on your phone, nothing to configure in this app.

**Strongly recommended: forward only when you don't answer, not every call.** Conditional forwarding ("no answer" / "unreachable" / "busy") means your phone still rings normally and you can just pick up yourself — Rex only catches what you don't. Forwarding *all* calls unconditionally means every single call skips your phone entirely, including while this PC or the app is off, which is rarely what you actually want.

These are dialed like a phone number, right from the dial pad — replace `<number>` with the Twilio number from step 1, digits only (e.g. `+15551234567`):

| Carrier | Forward when no answer | Forward when unreachable/off | Turn off again |
|---|---|---|---|
| AT&T / T-Mobile (and most GSM-standard carriers) | `**61*<number>#` | `**62*<number>#` | `##61#` / `##62#` |
| Verizon | `*92<number>` | *(not separately offered — no-answer code covers this)* | `*93` |

Carriers change these occasionally and some regional/MVNO carriers differ from their parent network, so if a code doesn't do anything, search "*(your carrier)* conditional call forwarding code" or check with them directly — the underlying feature (forward only on no-answer) is standard on essentially every carrier even when the exact digits differ. Forwarding itself is usually free; ask your carrier if you're unsure, since a few older plans meter it like an outbound call.

**A few honest limitations to know about:**

- **Rex has to actually be running**, with Calling switched on, for either direction to work — an outbound request fails with a clear error if it's off, and a forwarded incoming call will just fail to connect (most carriers fall back to normal voicemail in that case, but this depends on your carrier, not on Rex).
- The AI conversation on a call is a genuinely live, real-time voice exchange — same idea as talking to Rex normally, just over the phone instead of this PC's mic, including the same latency and occasional mishearing you'd get from any voice AI.
- Saying "forward that call" or "decline that call" while Rex is mid-conversation with a caller only works for **incoming** calls it's currently screening — there's nothing to forward or decline on an outbound call Rex placed itself (say "hang up" or "stop" for that instead).
- Every call — who it was with, how long, and a full transcript — shows up in the transcript here as it happens and after it ends, the same "nothing happens silently" principle as PC Control and Screen & Input Control above.

## How it's built

- **Electron** app: `main.js` (the window, all network calls and the AI tool-calling loop, so your keys and tokens never touch page JavaScript) and `preload.js` (a small safe bridge exposed to the page as `window.jarvis`).
- **The AI brain** lives in `main.js` too: it sends your conversation to OpenAI's Chat Completions API with a set of tools (web search, image search, image generation, 3D models, PC commands, screen/input control, email, music), runs whichever tools the model asks for, and returns a short natural reply plus structured results for the HUD to render. `renderer/app.js` keeps the running conversation in memory (resets when you restart the app, or click "Clear Log").
- **Screen & input control** is its own loop inside `main.js`: capture a screenshot (Electron's `desktopCapturer`), check which window currently holds keyboard focus (`GetForegroundWindow`/`GetWindowText`), show both to a vision-capable model with a forced tool call so it always answers with one structured action, carry that action out for real via a short-lived PowerShell process (a hard-coded check refuses to ever send Alt+F4 or Win+L), then repeat — live-streaming each step, including the focus title and whether the previous action actually succeeded, back to the HUD the whole time. Mouse/keyboard input goes through classic `user32.dll` calls (`SetCursorPos`, `mouse_event`, `keybd_event`) and `System.Windows.Forms.SendKeys` for typed text, deliberately not the newer `SendInput` API — simpler and more predictable to get right without a live Windows PC to test against.
- **Renderer** (`renderer/`): the HUD itself. `app.js` is the app logic, `viewer3d.js` is a dependency-free canvas-based wireframe renderer (used for the procedural 3D shapes and for the main visualizer's core sphere), `meshyViewer.js` is an optional three.js-based viewer for real AI-generated models.
- **OAuth** (Gmail/Outlook/Spotify/Nylas): standard Authorization Code + PKCE flow via a short-lived local server on `127.0.0.1:53682` that catches the redirect after you sign in in your normal browser — nothing is embedded, nothing but that local step ever sees your credentials, and only the resulting refresh token (encrypted at rest) is stored. Nylas is the odd one out in that a single sign-in produces a "grant" rather than a single connected/disconnected flag — `main.js` keeps a growing list of them (each just a grant ID plus the email/provider it reported), and every tool call that touches email or calendar fans out across all of them, merging results from Gmail, Outlook, and every Nylas grant into one combined answer.
- **Phone calling** (Twilio + ngrok): `main.js` runs a small local HTTP + WebSocket server (port `53683`) implementing Twilio's [ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay) protocol — Twilio streams live transcribed speech in over the WebSocket, `main.js` runs it through the same tool-calling AI brain used everywhere else in the app (with a call-specific system prompt and a smaller, direction-specific tool set — outbound calls can end the call, inbound ones can forward or decline), and streams generated speech back out. ngrok is deliberately run as a **plain child process** (your own downloaded `ngrok.exe`, driven with `child_process.spawn` and polled via its local `127.0.0.1:4040` status API) rather than the `@ngrok/ngrok` npm package — that package ships a native addon, which is a real packaging risk for a single-file portable Electron build that can't be test-built on a real Windows machine before reaching you; a plain child process is the same well-understood pattern this app already uses for PowerShell in Screen & Input Control. The call server only starts if **Allow Calling** is on, and the setting only actually saves as "on" once it's confirmed working (Twilio credentials valid, ngrok tunnel actually up) — so a broken setup can't get stuck silently retrying (and failing) on every future launch.
- **`npm install`** runs `scripts/prepare-vendor.js` afterward, which copies the three.js library out of `node_modules` into `renderer/vendor/` so the renderer can load it as a plain ES module (no bundler). If that step ever fails (e.g. a future three.js release reorganizes its files), the whole app still works fine - only real Meshy AI models fall back to "save the file, open it elsewhere" instead of rendering in-app.

## A couple of honest caveats

- This project was put together in an environment with no general internet access to actually run `npm install` or launch Electron itself, so everything is built carefully from current, verified documentation but not run end-to-end before reaching you. The HUD, commands, popups, and procedural 3D viewer *were* tested headlessly and worked correctly. The screen/input control logic (coordinate math, the PowerShell scripts it generates, the focus-check and blocked-combo logic, the step-by-step loop's control flow) and the phone calling logic (the Twilio webhook/signature handling, the ConversationRelay conversation loop including simulated race conditions, ngrok process management and its failure modes, and the Nylas grant/settings plumbing) were each tested in isolation, line by line, against mocked versions of their real dependencies. The AI brain, and the Gmail/Outlook/Spotify/PC-control/screen-control/Nylas/Twilio code, are written correctly against current APIs but couldn't be exercised against a real OpenAI, Twilio, ngrok, or Nylas account, or a real Windows PC or phone call, from here — if anything misbehaves, paste me the exact error and I'll fix it fast.
- On a live call, ConversationRelay's protocol doesn't send an explicit "I've finished speaking" event, so Rex ending or handing off a call (forwarding, declining, hanging up) is timed with a short fixed delay after its last line rather than a true "definitely done talking" signal. In practice this should feel natural, but a very long final sentence could in principle still get cut slightly short.
- The Twilio/ngrok/Nylas costs and setup steps above (dashboard button names, star codes, pricing) were all checked against current documentation while writing this, but all three are the kind of thing that shifts over time — if a step or price doesn't match what you see, the provider's own current docs win.
- Speech recognition (`SpeechRecognition`) is a Chromium feature - since Electron is Chromium-based, it works the same as it did in the browser version (see Setup → Advanced if the mic gives a "network" error).
- The Meshy AI path generates a preview-quality (untextured) mesh to keep cost/time down. Ask if you'd like it upgraded to a textured "refine" pass.
- OpenAI's exact model lineup changes over time - if the default AI Model in Setup ever gets rejected, see "The most important key" section above.
