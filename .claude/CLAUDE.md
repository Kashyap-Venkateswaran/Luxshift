# CLAUDE.md

This repository uses Claude Code in broad, semi-autonomous, and sometimes fully autonomous workflows. The user often gives high-level instructions such as:

- "review the code and debug it"
- "find the problem and solve it"
- "audit this feature and fix whatever is wrong"
- "run in auto mode"

Because tasks are often high-level and do not specify exact file paths in advance, Claude must follow the workspace rules below.

---

## Core Principle

Claude is allowed to inspect the codebase broadly and make real implementation changes when required to solve the user's task.

However, Claude must clearly separate:

1. **production files** — real app/code/config/build files that are part of the actual project
2. **non-production artifacts** — summaries, notes, logs, scratch scripts, debug outputs, research notes, test outputs, review files, temporary reports, or any other support material

Production files may be edited when needed to solve the task.

Non-production artifacts must be isolated inside `.agent-work/`.

---

## Workspace Policy

### Allowed production work
Claude may:
- read any project files needed to understand the task
- edit existing production source files when required
- edit existing config/build/package files when required
- create a genuinely necessary new production file only when that file is part of the real implementation and belongs logically in the project structure

Examples of legitimate production files:
- `main.js`
- `preload.js`
- `renderer.js`
- `package.json`
- real source modules
- real config files
- real assets intentionally added to the application
- real documentation files only if the user explicitly asked for project docs

### Non-production artifacts
Claude must treat the following as **non-production artifacts** unless the user explicitly says otherwise:

- debug logs
- traces
- dumps
- notes
- scratch scripts
- temporary scripts
- review notes
- verification reports
- testing reports
- regression checklists
- research notes
- source summaries
- generated summaries of what an agent did
- audit notes
- one-off markdown/txt files created only to help Claude think, test, inspect, or explain

These files must never be scattered through the root or source tree.

They must go only inside:

`.agent-work/`

---

## `.agent-work` Structure

All non-production artifacts created by Claude, subagents, or delegated workers must live under:

`.agent-work/<agent-name>/<instance-folder>/`

### Instance folder format
Each invocation that creates artifacts must use:

`<session-label>_<YYYY-MM-DD>_<HH-MM-SS>`

Rules:
- `session-label` must be a short filesystem-safe slug
- use lowercase letters, numbers, and hyphens only
- use local time
- use 24-hour format
- do not use colons
- create a fresh instance folder for each invocation
- never reuse old instance folders

Example:

`.agent-work/debugging-error-interpretation/luxshift-calendar-bug_2026-07-30_10-04-03/`

### Required summary file
Every invocation that creates artifacts in `.agent-work/` must create:

`summary.md`

inside its own instance folder.

That summary should include:
- the original request
- what was inspected
- what files were read
- what files were created
- what was concluded
- what follow-up is recommended
- whether any production files were changed

---

## Source Tree Cleanliness Rule

Claude must not create ad hoc support files in:
- project root
- `src/`
- `app/`
- `lib/`
- `main/`
- `renderer/`
- `components/`
- `tests/` unless the user explicitly asked for a real persistent test file
- `.claude/` except when explicitly editing Claude configuration
- any production folder

unless the file is clearly a real implementation file required by the user's task.

If a file is merely helpful to analysis, debugging, testing, verification, or research, it belongs in `.agent-work/`.

---

## Auto Mode Rule

The user frequently works in auto mode and gives broad instructions rather than naming exact files.

Because of that, Claude must follow this decision rule:

### If the file is part of the actual app
It may be edited directly if needed to solve the task.

### If the file is support material created during reasoning, debugging, testing, verification, or review
It must be created only inside `.agent-work/`.

### If unsure whether a new file is production or non-production
Default to `.agent-work/` unless there is a strong reason the file is part of the actual app deliverable.

---

## New File Creation Rule

Before creating any new file outside `.agent-work/`, Claude must ask internally:

1. Is this file part of the real application or repository deliverable?
2. Would this file still belong here if a human teammate reviewed the repo later?
3. Is this file meant to ship, persist, or be maintained?
4. Or is it only being created to help with analysis/debugging/testing/review?

If the answer is "analysis/debugging/testing/review/support material," the file must go in `.agent-work/`.

If the answer is "real implementation deliverable," it may be created in the proper production location.

---

## Production File Safety

When modifying production files:
- prefer editing existing files over creating unnecessary new ones
- keep changes tightly scoped to the actual problem
- avoid broad rewrites unless clearly justified
- do not create duplicate variants of production files
- do not create files like `main-fixed.js`, `renderer-new.js`, `reviewed-package.json`, `temp-test.js`, or other stray variants in the source tree

If a temporary copy or experiment is needed, put it in `.agent-work/`.

---

## Subagent Policy

All subagents, including custom agents and general-purpose delegated agents, must follow the same workspace policy.

Subagents may:
- inspect the repo broadly
- edit real production files only when appropriate to their task
- create summaries, notes, or intermediate artifacts only inside `.agent-work/`

Custom subagents should be configured so that:
- their support files are written only under `.agent-work/<agent-name>/<instance-folder>/`
- they create a `summary.md` for each invocation
- their tool access remains least-privilege where practical

---

## Testing, Review, and Research Policy

### Testing
If Claude runs tests, captures outputs, writes temporary scripts, or records QA observations, those artifacts must go in `.agent-work/`.

### Review
If Claude performs verification, auditing, review, consistency checks, or AI-output evaluation, all review artifacts must go in `.agent-work/`.

### Research
If Claude gathers documentation notes, source summaries, comparison notes, or implementation guidance, those research artifacts must go in `.agent-work/`.

---

## `.claude` Directory Policy

Claude must not casually write generated working files into `.claude/`.

`.claude/` is reserved for durable Claude configuration such as:
- `CLAUDE.md`
- settings
- hooks
- skills
- agents

Do not store temporary work products there.

---

## Git Hygiene

`.agent-work/` is a workspace artifact area, not a shipping area.

It should normally be ignored by git.

If not already present, prefer adding this to `.gitignore`:

```gitignore
.agent-work/
```

Do not commit `.agent-work/` contents unless the user explicitly asks to preserve a specific artifact.

---

## Decision Heuristic

Use this quick rule:

### Edit existing real file?
Usually allowed, if needed for the task.

### Create new real implementation file?
Allowed only if it is clearly part of the actual solution.

### Create any helper, note, log, summary, test output, temporary script, research note, or review artifact?
Must go in `.agent-work/`.

---

## Preferred Behavior

When solving broad tasks, Claude should:
1. inspect the codebase as needed
2. identify the relevant production files
3. make necessary production changes directly
4. place all support material in `.agent-work/`
5. leave behind a clear `summary.md` per artifact-producing invocation

This keeps the source tree clean while still allowing autonomous problem solving.

---

## Examples

### Good
- edit `main.js` to fix an IPC bug
- edit `renderer.js` to fix state handling
- create `.agent-work/debugging-error-interpretation/calendar-ipc_2026-07-30_10-04-03/summary.md`
- create `.agent-work/systematic-testing/winddown-check_2026-07-30_10-18-41/test-log.txt`

### Bad
- create `debug-notes.md` in the project root
- create `review-output.txt` next to `package.json`
- create `renderer-fixed.js` in the app folder as a temporary copy
- create `research.md` in `src/`
- create `summary.md` in `.claude/`

---

## When in Doubt

If there is uncertainty about where a file belongs:
- if it is part of the app, put it in the real implementation path
- if it is part of the process, put it in `.agent-work/`

Process artifacts belong in `.agent-work/`.
Shipping artifacts belong in the real project structure.