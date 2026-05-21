# PROB-006: console.log / stdout Advisory in PreToolUse

**Status:** known
**Added:** 2026-05-21
**Hook(s):** any advisory hook registered on PreToolUse
**Symptom:** Hook advisory messages that developers expect to appear in the terminal are invisible — Claude instead sees them as injected context, silently accumulating extra "instructions" it was never supposed to receive.

## Root Cause

On `PreToolUse`, stdout is injected into the model's context window, not displayed as terminal output. This mirrors the `UserPromptSubmit` behavior (see PROB-004). `console.log(...)` writes to stdout. Advisory hooks that use `console.log` in PreToolUse are silently adding text to Claude's context on every tool call they fire for, rather than displaying it to the developer.

The cumulative effect: every Bash command, every Read, every Grep triggers the hook, and every `console.log` call injects a new line of text into Claude's in-context instructions. Over a long session this degrades Claude's context with noise and may subtly influence its behavior in unexpected ways.

## Example Scenario

1. `memory-protocol-check.cjs` fires on PreToolUse for every Bash command.
2. It detects an action verb in context and calls `console.log('[memory-protocol] Reminder: search memories before implementing...')`.
3. This appears in Claude's context window as injected instructions — not in the terminal.
4. The developer never sees the reminder. Claude receives it on every relevant Bash call.
5. After 50 Bash invocations, Claude has 50 lines of reminder text accumulating in its context.

## Fix

Replace `console.log(...)` with `process.stderr.write(... + '\n')` in all PreToolUse hooks. Stderr is shown in the terminal and does NOT inject into the model's context.

```js
// WRONG — injects into model context silently
console.log('[memory-protocol] Reminder: search memories before implementing');

// CORRECT — shown in terminal, not injected into context
process.stderr.write('[memory-protocol] Reminder: search memories before implementing\n');
```

For hooks that intentionally communicate with Claude by injecting structured text (for example, a hook that injects a JSON instruction block into the model's context via stdout), this is the correct design — document it explicitly and be precise about what is injected.

## Behavioral Rule

> In `PreToolUse` hooks, never use `console.log`. Use `process.stderr.write(msg + '\n')` for all advisory output intended for the developer terminal. Reserve `process.stdout.write` only for deliberate, structured model-context injection — and document it explicitly.

## Verification

Watch the terminal output when a PreToolUse hook fires. The advisory message should appear as terminal output (via stderr). Inspect Claude's context to confirm it does not contain accumulated advisory text from repeated hook invocations.
