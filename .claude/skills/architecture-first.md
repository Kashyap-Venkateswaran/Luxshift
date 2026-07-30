---
name: architecture-first
description: Discipline for designing data flow, module boundaries, and contracts before requesting any code. Load this when starting a new feature, adding an external integration, or restructuring existing Electron code in LuxShift.
---

# Architecture Thinking Before Coding

## Why This Exists
AI models — especially open-source ones — are strong at filling in a well-defined slot and weak at inventing a coherent system across many files. If you ask for "the calendar feature," the model will improvise boundaries inconsistently across sessions. If you hand it one slot with a fixed contract, it fills that slot reliably.

## The Four-Step Method

### Step 1: Draw the Data Flow in Words
Before any prompt, write the full path data takes, end to end. Use arrows and name every hop.

Example (LuxShift's actual LLM parsing flow):
`User types schedule text (renderer)` → `preload.parseSchedule(text)` → `ipcMain.handle('parse-schedule')` → `parser-ai.js builds prompt` → `OpenRouter API call` → `raw LLM JSON` → `schedule-validator.js normalizes + validates` → `ipcMain returns result` → `renderer displays parsed blocks`

If you cannot write this chain from memory, you don't understand the feature well enough to prompt for it yet — research first (see Skill 7).

### Step 2: Assign One Responsibility Per File
Each file gets exactly one job description, one sentence long. If a file's job needs "and" to describe, split it.
- `schedule-store.js` — persists and retrieves saved schedules (electron-store wrapper only)
- `parser-ai.js` — builds the LLM prompt and calls OpenRouter; no validation logic
- `schedule-validator.js` — validates/normalizes raw LLM JSON against the schema; no API calls

### Step 3: Define the Contract at Every Boundary
For every arrow in your data-flow diagram, write the exact shape crossing it:
- Function signature: `parseSchedule(text: string) -> Promise<{ok: boolean, blocks: ScheduleBlock[], confidence: number}>`
- IPC channel + payload shape: `'parse-schedule'` sends `{text: string}`, resolves `{ok, blocks, confidence, error?}`
- On error: what does failure look like? (never leave this undefined — it's the #1 source of silent bugs)

### Step 4: Only Then, Prompt Per Module
Feed the AI one module plus its exact contract, referencing the modules on either side by name only (not their full code, unless needed for direct integration).

## Decision Frameworks You'll Reuse

**Local logic vs. cloud/LLM:**
| Factor | Favors Local | Favors Cloud/LLM |
|---|---|---|
| Latency need | High (instant) | Low (can wait 1-3s) |
| Offline requirement | Yes | No |
| Input variability | Low (fixed formats) | High (free text) |
| Privacy sensitivity | High | Depends on provider |

**Where does state live?**
- UI-only, disposable state (form input before submit) → renderer local state
- App-wide, persistent state (user schedules, preferences) → main process store (electron-store), exposed via IPC
- Secrets (API keys, tokens) → main process only, environment variables or OS keychain — never renderer, never renderer-accessible IPC responses

## Anti-Patterns
- Asking for "the whole feature" in one prompt without a written data flow first
- Letting the AI decide module boundaries — it will pick different boundaries each session, causing drift
- Skipping the contract step and discovering the mismatch only when preload.js and main.js disagree on payload shape

## Pre-Prompt Checklist
- [ ] Data flow written out, arrow by arrow, named files/functions at each hop
- [ ] Each file has a one-sentence, "and"-free responsibility
- [ ] Every boundary has an explicit success AND error contract
- [ ] Decided local vs. cloud, and where each piece of state lives