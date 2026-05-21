# PROB-007: Raw process.stdin Instead of readStdinJson()

**Status:** known
**Added:** 2026-05-21
**Hook(s):** any hook that reads stdin for tool input/response data
**Symptom:** Under rare race conditions, a hook hangs indefinitely — Claude Code appears frozen, the terminal produces no output, and the session must be killed manually.

## Root Cause

Claude Code delivers tool input and response data to hooks via stdin. Hooks must read and parse this JSON payload. Using raw `process.stdin.on('data', ...)` has no built-in timeout. In normal operation this works fine because stdin always closes promptly. But there is a real (if rare) race condition: if stdin closes without emitting the `end` event — for example due to a pipe error, a very fast tool completion, or a platform-specific buffering edge case on Windows — the raw event listener never fires and the hook waits forever.

A hanging hook blocks the entire Claude Code session because hooks run synchronously in the tool call pipeline. The session freezes with no output and no error message.

A project-standard `readStdinJson()` utility (e.g., from `hook-utils.cjs`) solves this by wrapping stdin with a configurable timeout. If stdin does not complete within N milliseconds, it resolves with whatever was buffered (or an empty object) and the hook exits cleanly.

## Example Scenario

1. `sync-prompt-libraries.cjs` uses `process.stdin.on('data', chunk => ...)` directly.
2. On a Windows system under high I/O load, stdin closes before the `end` event fires.
3. The data handler never receives the full payload; the `end` handler never fires.
4. The hook hangs. The entire PostToolUse Write|Edit pipeline is blocked.
5. Claude Code appears frozen. No timeout, no error. Session must be killed.

## Fix

Use a `readStdinJson()` helper that wraps stdin with a timeout. A standard implementation:

```js
function readStdinJson(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let raw = '';
    const timer = setTimeout(() => resolve({}), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    process.stdin.on('error', () => { clearTimeout(timer); resolve({}); });
  });
}
```

Replace all direct `process.stdin.on('data', ...)` patterns with `await readStdinJson()`. If your project provides `hook-utils.cjs`, import from there instead of reimplementing.

```js
// WRONG — no timeout, hangs on stdin close without end event
let raw = '';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  // ... hook logic
});

// CORRECT — timeout ensures hook always exits
const input = await readStdinJson();
// ... hook logic
```

## Behavioral Rule

> Never use raw `process.stdin.on('data', ...)` in a hook. Always wrap stdin reads with a timeout so the hook cannot hang indefinitely. A frozen hook freezes the entire Claude Code session with no error signal.

## Verification

The hook should complete (exit 0 or exit 2) within the timeout window even on a system under I/O load. To test: pipe an empty or truncated payload to the hook manually and confirm it exits within the timeout rather than hanging:

```sh
echo '' | node .claude/hooks/your-hook.cjs
```
