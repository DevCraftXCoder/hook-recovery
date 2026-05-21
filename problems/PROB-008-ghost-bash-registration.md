# PROB-008: Ghost Bash Registration (file_path Undefined)

**Status:** known
**Added:** 2026-05-21
**Hook(s):** any hook registered on both Write|Edit and PostToolUse(Bash)
**Symptom:** A PostToolUse hook that was written for Write/Edit events is also registered on Bash events. On every Bash command it spawns a node process, immediately reads `undefined` for `file_path`, and silently exits. The hook does nothing useful but wastes CPU/memory on every shell invocation in the session.

## Root Cause

The Claude Code tool input schema differs between tool types:

- `Write` and `Edit` events include `tool_input.file_path` — the path of the file being written or edited.
- `Bash` events include `tool_input.command` — the shell command being run. There is no `file_path` field.

A hook that reads `tool_input.file_path` to decide whether to run (e.g., "only fire if this is an EV Betta UI source file") receives `undefined` on every Bash event. The `undefined` check typically evaluates to falsy, so the hook returns early with exit 0 — silently no-opping. But it still spawns a full Node.js process for every single Bash invocation, even though it can never do useful work on Bash events.

In a busy session with 200+ Bash calls, this spawns 200+ ghost processes — measurable overhead and a latency tax on every shell command.

## Example Scenario

1. `ev-betta-autodeploy.cjs` checks `tool_input.file_path` to detect EV Betta UI source file edits.
2. It was registered under both `Write|Edit` (correct) and `Bash` (ghost — leftover from copy-paste).
3. Every `Bash` invocation: node spawns, reads stdin, parses JSON, reads `tool_input.file_path` → `undefined`, exits 0.
4. 200 Bash calls → 200 ghost node processes. No useful work done on any of them.
5. The `Write|Edit` registration still works correctly. The `Bash` registration is pure waste.

## Fix

Audit hook registrations in `settings.json`. If a hook reads `tool_input.file_path` and has no logic that uses `tool_input.command`, remove the `Bash` registration. Keep only the `Write|Edit` registration.

```json
// WRONG — Bash registration is a ghost
{
  "PostToolUse": [
    { "matcher": "Write|Edit", "hooks": [{ "command": "node .claude/hooks/ev-betta-autodeploy.cjs" }] },
    { "matcher": "Bash",       "hooks": [{ "command": "node .claude/hooks/ev-betta-autodeploy.cjs" }] }
  ]
}

// CORRECT — only the events this hook can handle
{
  "PostToolUse": [
    { "matcher": "Write|Edit", "hooks": [{ "command": "node .claude/hooks/ev-betta-autodeploy.cjs" }] }
  ]
}
```

If the hook genuinely needs to run on both Write/Edit and Bash, add an explicit `tool_name` guard at the top:

```js
const toolName = input.tool_name ?? '';
if (toolName === 'Bash' && !input.tool_input?.command) { process.exit(0); }
```

## Behavioral Rule

> A hook that reads `tool_input.file_path` must only be registered under `Write|Edit` matchers. Never register it under `Bash` — Bash events do not have a `file_path` field. Audit `settings.json` after any copy-paste of hook registrations to remove ghost matchers.

## Verification

Run `node diagnose.cjs` — Section II Check E detects this pattern. Manually: grep the hook file for `file_path` usage; if found, verify the hook is not registered on Bash in `settings.json`.
