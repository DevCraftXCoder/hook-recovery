# PROB-006: console.log / stdout Advisory in PreToolUse Context

**Status:** known
**Added:** 2026-05-21
**Hook(s):** any PreToolUse advisory hook
**Symptom:** An advisory message intended for the developer's terminal silently appears inside Claude's context window as an injected instruction instead.

## Root Cause

In `PreToolUse`, Claude Code routes hook stdout back into the model's context window as injected instructions — the same channel used by `UserPromptSubmit` context injection. This means:

- `process.stdout.write('some advisory\n')` → silently prepended to Claude's context
- `console.log('some advisory')` → also stdout → same injection

The developer never sees the advisory in the terminal. Claude sees it as an instruction. Depending on wording, Claude may act on it, repeat it, or be confused by it appearing in context at an unexpected point.

The correct pattern for advisory-only PreToolUse hooks: use `process.stderr.write(msg + '\n')`. Stderr is visible in the terminal and is NOT injected into model context.

**Exception:** Some hooks deliberately use stdout for context injection (e.g., the `superpowers-remind.cjs` hook intentionally injects skill reminders into Claude's context on `UserPromptSubmit`). If injection is the intent, stdout is correct — but it should be explicitly documented with a comment.

## Example Scenario

1. A `pre-docker-backup.cjs` hook is registered on `PreToolUse(Bash)`.
2. Claude runs a destructive docker command.
3. The hook detects it and calls:
   ```js
   console.log('[docker-backup] WARNING: Destructive volume operation detected. Back up first.');
   process.exit(0);
   ```
4. The developer's terminal shows nothing.
5. Claude receives `[docker-backup] WARNING: Destructive volume operation detected.` as an injected context message — potentially acting on it as a new instruction rather than understanding it as a developer-facing advisory.

## Fix

Replace `console.log(...)` with `process.stderr.write(... + '\n')` in PreToolUse hooks where the intent is a developer-visible advisory:

```js
// WRONG — injects into model context:
console.log('[pre-docker-backup] WARNING: Destructive volume operation. Back up first.');

// CORRECT — visible in terminal only:
process.stderr.write('[pre-docker-backup] WARNING: Destructive volume operation. Back up first.\n');
```

If stdout injection is intentional (you want to nudge the model), add an explicit comment:
```js
// Intentional: stdout injection nudges Claude's context on this event
process.stdout.write('...\n');
```

## Behavioral Rule

> PreToolUse advisory hooks use process.stderr.write(), not console.log(). stdout in PreToolUse injects into model context. If injection is intentional, document it with a comment.

## Verification

Grep all PreToolUse hook files for `console.log(`. Any match that isn't followed by a comment explaining the injection intent is a bug.

`diagnose.cjs --scan` detects this pattern and warns on any PreToolUse hook using `console.log(`.
