---
name: security-privacy-fundamentals
description: Non-negotiable security and privacy rules for Electron apps handling API keys, OAuth tokens, and user calendar/schedule data. Load this whenever adding an integration, storing credentials, reviewing IPC code, or handling any external API in LuxShift.
---

# Security and Privacy Fundamentals

## Why This Exists
AI models — open-source ones especially — routinely generate insecure patterns: hardcoded keys, unvalidated IPC input, disabled context isolation. They optimize for "code that runs," not "code that's safe." No automated tool will flag most of this in a small personal project — you are the last line of defense.

## The Threat Model for LuxShift (Keep It Concrete)
Your app handles: an OpenRouter API key, Google/Apple/Notion OAuth tokens, users' calendar event data, and schedule text sent to a cloud LLM. The realistic risks are not hackers targeting you — they're:
1. Accidentally pushing a key to your public GitHub repo
2. A malicious or compromised webpage loaded in a window reaching Node APIs
3. Leaking more user data to a cloud API than intended
4. AI-generated code introducing any of the above silently

## The Non-Negotiable Rules

### Rule 1: Secrets Never Touch the Renderer
API keys and OAuth tokens may live only in:
- The main process, loaded via `process.env` from a `.env` file (loaded with `dotenv` at main-process startup), OR
- An OS-level secure store (macOS Keychain via a package like `keytar`)

Never in: `renderer.js`, any file loaded via `<script>` in `index.html`, `localStorage`, `sessionStorage`, cookies, or any IPC *response* that echoes the raw credential back to the renderer. The renderer should only ever receive derived facts ("connected: true"), never the credential itself.

### Rule 2: Never Commit Secrets
- `.env` goes in `.gitignore` **before the first commit**, not after
- If a key was ever pushed to GitHub — even once, even deleted afterward — treat it as permanently compromised and rotate it immediately. Git history retains it, and public repos are scraped by bots within minutes
- Audit with `git log -p | grep -i "sk-"` (or your key prefix) if you're unsure whether anything leaked historically
- Ship a `.env.example` (with placeholder values) so the repo documents what variables exist without exposing real ones

### Rule 3: Secure Window Defaults (Electron-Specific)
Every `BrowserWindow` must be created with:
```js
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: path.join(__dirname, 'preload.js')
}
```
`contextIsolation: true` + `nodeIntegration: false` is what stops a compromised page from reaching Node.js directly. The preload script is the *only* sanctioned bridge, and it should expose the narrowest possible API via `contextBridge.exposeInMainWorld` — individual named methods, never raw `ipcRenderer` itself (exposing `ipcRenderer` wholesale lets any renderer code call *any* channel, including ones you didn't intend).

### Rule 4: Validate Everything Crossing IPC
Treat every renderer→main IPC message as untrusted input, exactly as a web server treats a request body:
- Type-check: `typeof text === 'string'`, not "assume it's a string"
- Range-check: brightness must be a number in [0, 1], not whatever arrived
- Never interpolate renderer-supplied strings directly into shell commands (`exec`), AppleScript, or file paths — this is how remote code execution bugs happen in Electron apps

### Rule 5: Know What Leaves the Device
Every time you add or modify a cloud call, write down: what data is sent, to whom, and why. For LuxShift: "schedule text typed by the user is sent to OpenRouter for parsing — necessary for the LLM-only architecture, disclosed to users." The habit prevents scope creep like accidentally sending a user's *entire calendar* when only one event was needed.

## OAuth-Specific Rules
- Handle the OAuth redirect and token exchange in the **main process**, never the renderer
- Never `console.log` a token, even temporarily — logs end up in crash reports, screenshots, and shared debug output
- On provider switch (e.g., Google → Apple Calendar) or disconnect: explicitly delete stored tokens and revoke via the provider's API where supported. Don't just stop using them — orphaned tokens remain valid attack surface
- Store tokens with `electron-store` in the main process at minimum; Keychain via `keytar` is better

## Review Checklist for Any AI-Generated Code Touching Secrets/IPC/Auth
- [ ] Grep the diff for every key/token name — does it appear anywhere outside the main process?
- [ ] Are `contextIsolation: true` and `nodeIntegration: false` still intact after this change?
- [ ] Does the preload expose named methods only, or did the AI expose raw `ipcRenderer`?
- [ ] Does every new/modified `ipcMain.handle` validate input type and range before use?
- [ ] Does this change log anything sensitive to the console?
- [ ] If it touches OAuth: is token cleanup handled on switch/disconnect?
- [ ] Is any renderer-supplied string reaching `exec`, AppleScript, or a file path unsanitized?

## Red Flags in AI Suggestions (Reject or Fix Immediately)
- `const API_KEY = "sk-..."` hardcoded in any file the renderer loads
- `nodeIntegration: true` suggested "to make it easier" to use Node APIs from renderer code
- `contextBridge.exposeInMainWorld('api', { ipcRenderer })` — wholesale bridge exposure
- IPC handlers passing renderer input straight into `eval()`, `exec()`, or path construction
- "For simplicity, store the token in localStorage" — simplicity is never a valid reason here