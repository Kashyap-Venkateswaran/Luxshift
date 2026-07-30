---
name: async-event-thinking
description: Mental model and diagnostic method for asynchronous, event-driven bugs in Electron — timing issues, race conditions, and out-of-order execution. Load this when a feature works "sometimes," fires at the wrong time, fires twice, or silently does nothing.
---

# Asynchronous and Event-Driven Thinking

## Why This Exists
Electron apps are fundamentally event-driven: IPC calls, file system access, network requests, and OS events (brightness, notifications, power state) are almost all asynchronous. A huge share of "it's broken" bugs are actually "it ran at the wrong time" bugs. These require reasoning about *ordering*, not the correctness of any single function — which is why pasting a single file to the AI often fails to fix them.

## Core Mental Models

### Model 1: The Event Loop Doesn't Wait for You
When you call an async function without `await`, execution continues immediately — the async work completes "whenever it completes," not "next." This is the root of the most common bug pattern: reading a variable before the async call that was supposed to populate it has resolved.

```js
let events;
fetchCalendarEvents();          // async — returns immediately
computeWindDown(events);        // BUG: events is still undefined here
```

### Model 2: IPC Is Always a Round Trip
`ipcRenderer.invoke(channel, data)` sends a message and returns a Promise. The main process's `ipcMain.handle` runs, and only when it resolves does the renderer's Promise resolve. Nothing about this is synchronous — even when the main-process work is instant (e.g., reading a local electron-store value), the *transport* is still async.

### Model 3: Listeners Fire Whenever Their Event Happens — Including "Too Early" and "Too Many Times"
`app.on('ready')`, `ipcRenderer.on(...)`, DOM `addEventListener` — a listener fires every time its event occurs, from the moment it's registered. Two consequences:
- Registered too late → missed the event entirely ("nothing happens")
- Registered more than once → handler runs multiple times ("it fired twice")

### Model 4: Renderer and Main Have Separate Clocks
The renderer's UI state and the main process's app state update independently. There is no automatic synchronization — if main updates a value, the renderer keeps showing the old one until an explicit IPC push (`webContents.send`) or pull (`invoke`) refreshes it.

## Diagnostic Method for Suspected Timing Bugs

1. **Add timestamped logs at every step of the suspected flow:**
   ```js
   console.log(`[${Date.now()}] calendar fetch started`);
   // ...await...
   console.log(`[${Date.now()}] calendar fetch resolved`, data);
   console.log(`[${Date.now()}] wind-down state computed`, state);
   ```
2. **Compare actual log order to the order you assumed.** The bug lives exactly where the two orders diverge.
3. **Ask the three killer questions:**
   - Could this code run *before* its dependency is ready? (missing `await`, or code placed outside the `.then()` chain)
   - Could this handler have been registered *more than once*? (registration inside a function called repeatedly instead of once at startup)
   - Could this event have fired *before* the listener existed? (late registration, or an event source that fires immediately on init)

## Classic Patterns in LuxShift-Style Apps

| Symptom | Likely Cause | Fix Direction |
|---|---|---|
| UI shows stale/empty data right after load | Renderer read state before async IPC call resolved | Render only after the `invoke` Promise resolves; show a loading state meanwhile |
| Action happens twice per single trigger | Listener registered more than once | Move registration to one-time startup code; add `removeListener` on cleanup paths |
| "Event detected but nothing happens" | Detection callback fired, but the action code sits outside the `await`/`.then()` chain, so it ran before the data existed | Move the action inside the resolution chain |
| Works first time, breaks on second run | Old listener from a previous run never removed | Add cleanup (`removeAllListeners` or specific `removeListener`) on teardown |
| Settings reset unexpectedly at startup | Main wrote defaults before the persisted store finished loading | Await store initialization before any write |
| Toggle flips visually but nothing changes | UI updated optimistically, but the IPC call failed silently and no error handler reverted the UI | Add `.catch()` that reverts UI state and surfaces the error |

## How to Prompt About Timing Bugs
State the *sequence*, not just the symptom:

> "The calendar fetch's resolution runs after `computeWindDownState()` already executed once at startup, so newly fetched events never get evaluated. The fix should re-run the computation inside the fetch's resolution chain, not only at startup. main.js and renderer.js pasted below — treat as source of truth."

Sequence-aware prompts fix race conditions. A code paste alone often doesn't, because the bug isn't in any single line — it's in the *order* lines run.

## Pre-Diagnosis Checklist
- [ ] Is the affected code inside an `await`/`.then()` chain, or does it run immediately after firing an async call?
- [ ] Could this listener/handler have been registered more than once?
- [ ] Does this bug happen every time, or only "sometimes"? ("Sometimes" is a strong race-condition signal)
- [ ] Have I confirmed actual execution order with timestamped logs, rather than assuming it?
- [ ] If state crosses the renderer/main boundary, is there an explicit sync mechanism, or am I assuming one exists?