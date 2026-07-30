---
name: describing-ui-in-words
description: Method for translating visual UI problems into precise text when no image input is available. Load this whenever discussing layout, styling, or rendering issues in LuxShift's Electron renderer (HTML/CSS/JS).
---

# Describing UI in Words (No Vision Available)

## Why This Exists
A text-only model cannot see rendered output. Every visual fact you don't state explicitly is a fact it cannot use. This skill converts "I'll just show you" instinct (which you can't do) into a repeatable text protocol.

## The Four-Layer Description Protocol

### Layer 1: Identify the Element Precisely
Never use pointing language ("the thing at the top"). Use the actual identifier from the code:
- id/class from HTML: `#connectCalendarBtn`, `.smart-bulb-banner`
- If unnamed, quote the exact visible text: "the button that reads 'Connect Calendar'"

### Layer 2: State Position Relative to Named Anchors
- "Appears between `#tray-icon-row` and `#calendar-panel`, inside `.settings-column`"
- Avoid absolute pixel guesses; relative-to-sibling language is more reliable for the model to reason about, since it can read the DOM order in your pasted HTML

### Layer 3: State the Exact Symptom, Not the Feeling
Use this controlled vocabulary — pick the one(s) that match, don't paraphrase:
- **Missing**: element not rendered at all (check: is it even in the DOM, or hidden via CSS/display:none?)
- **Raw/unstyled**: HTML tags visible as literal text, or no CSS applied
- **Overlapping**: two elements occupy the same space
- **Truncated**: content cut off, likely a width/overflow issue
- **Misaligned**: present and styled, but wrong position (specify axis: horizontal or vertical)
- **Wrong state**: e.g., a toggle showing "off" appearance while logically "on"
- **Duplicated**: same element rendered more than once
- **Flickering/unstable**: appears and disappears, likely a re-render race condition

### Layer 4: State the Trigger Condition
- On initial load / after a specific click / only when a certain toggle is active / only after data returns from an async call

## Paste-the-Code Rule
Whenever the description alone might be ambiguous, paste all three of:
1. The HTML block containing the element
2. The CSS rules that apply to it (or note "no specific CSS — using default/inherited styles")
3. The JS that renders/updates it (if dynamically generated)

This lets the model diff your *stated intent* against the *actual rule set* — which is how most CSS bugs (specificity conflicts, missing units, flex/grid misconfigurations) get solved without ever seeing a pixel.

## Worked Example

**Before (unusable):**
> "the smart bulb thing looks weird now"

**After (usable):**
> "Element: `.smart-bulb-banner` (visible text 'Smart Bulbs Connected').
> Position: should appear above `#calendar-panel`, inside `#settings-column`.
> Symptom: raw/unstyled — I'm seeing literal `<div class="smart-bulb-banner">` text on screen instead of a rendered banner.
> Trigger: happens every time, right after `renderSmartBulbStatus()` runs (confirmed via console.log placed before/after the render call).
> HTML: [paste renderSmartBulbStatus's template string]
> This smells like an unclosed template literal or a missing `innerHTML` assignment — can you check?"

## Common Root Causes Behind Each Symptom (for faster self-diagnosis)
- Raw HTML showing as text → used `textContent` instead of `innerHTML`, or an unescaped/broken template literal
- Missing entirely → CSS `display:none` left on, or JS conditional never rendering the branch
- Overlapping → both elements using `position: absolute` without a defined stacking/flow context
- Flickering → re-render triggered on every state change without a diffing/memoization guard

## Pre-Send Checklist
- [ ] Named the element by actual id/class/text, not by position alone
- [ ] Stated position relative to a named sibling/parent
- [ ] Picked an exact symptom word from the controlled vocabulary
- [ ] Stated the trigger condition
- [ ] Pasted HTML/CSS/JS if there's any ambiguity
