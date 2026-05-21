# PROB-004: stdout Block Injection on UserPromptSubmit

**Status:** resolved
**Added:** 2026-05-21
**Hook(s):** any hook registered on UserPromptSubmit
**Symptom:** A hook tries to block a prompt with a visible rejection message, but the message silently disappears — or worse, appears as injected instructions in Claude's context instead of a human-readable block reason.

## Root Cause

On `UserPromptSubmit`, Claude Code routes the two output streams differently:

- `process.stdout` — injected verbatim into the model's context window as additional instructions
- `process.stderr` — surfaced as the human-readable block reason shown in the terminal

A hook that writes its block message to `stdout` then exits 2 does not display the message as a rejection reason. Instead it silently injects that text as model instructions — Claude receives extra context it wasn't supposed to see and the developer sees nothing.

This is the opposite of all other hook lifecycle events where stdout is the conventional output stream.

## Example Scenario

1. `secret-guard.cjs` detects a potential secret in the user's prompt.
2. Line 29 writes: `process.stdout.write('[secret-guard] BLOCKED: prompt contains a likely secret...\n')`.
3. Hook exits 2.
4. Claude Code sees the exit 2 and suppresses the prompt — correct behavior.
5. But the block reason displayed to the developer is empty (or whatever appeared on stderr, which is nothing).
6. Meanwhile, the `[secret-guard] BLOCKED...` text was injected into Claude's in-context instructions.

## Fix

On `UserPromptSubmit`, all human-readable output — including block reasons — must go to `process.stderr.write(...)`. The exit code still controls whether the prompt is blocked (exit 2) or allowed (exit 0).

```js
// WRONG — injects into model context
process.stdout.write('[secret-guard] BLOCKED: prompt contains a likely secret\n');
process.exit(2);

// CORRECT — surfaced as block reason in terminal
process.stderr.write('[secret-guard] BLOCKED: prompt contains a likely secret\n');
process.exit(2);
```

For advisory messages that do NOT block (exit 0), the same rule applies: use `process.stderr.write` so the advisory appears in the terminal rather than silently augmenting Claude's system instructions.

## Behavioral Rule

> On `UserPromptSubmit`, all hook output goes to `process.stderr`. Never write to `process.stdout` on this lifecycle — stdout is injected into the model's context window, not shown to the developer.

## Verification

Trigger the blocking condition and confirm the rejection reason appears in the terminal output. Confirm Claude's context does not contain the hook's message text by inspecting the conversation for unexpected injected content.
