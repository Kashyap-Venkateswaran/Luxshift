---
name: prompt-precision
description: Standard for writing exact, constraint-complete prompts when requesting code from Claude Code, especially with open-source/local models that infer less from context. Load this whenever the user is about to ask for code generation, a file rewrite, or a bug fix in the LuxShift Electron project.
---

# Prompt Precision for Code Generation

## Why This Exists
Open-source models (Llama, Nemotron, etc.) have weaker implicit-context reasoning than frontier models. They will not infer an unstated file format, an unstated process boundary, or an unstated "don't touch X" rule — they will guess, and the guess is often wrong. This skill exists to eliminate guessing by making every prompt self-contained.

## The Five Mandatory Components
Every code-request prompt must explicitly state:

1. **Exact file identity** — full filename and its role (e.g. "main.js — Electron main process, owns IPC handlers and OS-level calls")
2. **Current vs. expected behavior** — stated as a factual diff, never a vague complaint
   - Bad: "the calendar is broken"
   - Good: "connectCalendarBtn's click handler successfully fetches events (confirmed via console.log), but no wind-down state change occurs afterward — expected: wind-down state should update within the same handler"
3. **Hard constraints** — anything the model must NOT do
   - Module system: CommonJS `require()` vs ESM `import` — mixing these is the single most common open-source-model failure in Electron
   - Process boundary: "this code runs in the main process — it has Node access; do not add renderer-only APIs like `document` or `window`"
   - Dependency constraint: "no new npm packages — solve with what's already in package.json"
4. **Output contract** — tell it exactly what shape you want back
   - "Full file replacement" (use when structure changed significantly or truncation is suspected)
   - "Patch: replace only the function `getSunData()`, leave everything else untouched"
   - Never leave this implicit — models default to whichever is easier for them, not what's safest for you
5. **Source-of-truth declaration** — one sentence establishing what's real
   - "Treat the code I just pasted as the current state of the file. Do not assume any other file exists unless I paste it."

## Worked Example (Before/After)

**Before (weak prompt):**
> "the ipc call for brightness isn't working can you fix main.js"

**After (precise prompt):**
> "File: main.js (Electron main process, CommonJS).
> Current behavior: renderer calls `window.luxshiftAPI.setBrightness(0.5)` via preload; main.js has an `ipcMain.handle('set-brightness', ...)` registered, but nothing happens and no error is thrown.
> Expected: brightness should change using the `brightness` npm package already imported at the top of the file.
> Constraint: do not touch any other ipcMain handler in this file. Do not add new dependencies.
> Output: give me only the modified `set-brightness` handler block, not the full file — everything else is confirmed working.
> Source of truth: here is the current main.js in full: [paste]"

## Prompt Anti-Patterns to Catch Yourself Doing
- Sending an error message with no surrounding code
- Asking for changes to more than 2-3 files in a single prompt (splits the model's attention, increases truncation risk)
- Re-explaining the whole project from scratch every message instead of referencing what's already established
- Saying "make it work" without defining what "working" means observably

## Pre-Send Checklist
- [ ] Named the exact file(s) and their process context
- [ ] Stated current behavior as an observed fact, not a feeling
- [ ] Stated expected behavior as a testable outcome
- [ ] Declared module format and any hard constraints
- [ ] Specified full-file vs. patch output
- [ ] Declared pasted code as source of truth if relevant

## Special Note for Local/Open-Source Models
These models are more likely to silently truncate long files or lose earlier context in a long conversation. For files over ~150 lines, prefer patch-style prompts scoped to a single function, and re-paste the current file state periodically rather than assuming the model "remembers" earlier turns accurately.