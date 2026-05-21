# PROB-005: exit 2 in PostToolUse Hooks

**Status:** resolved
**Added:** 2026-05-21
**Hook(s):** any PostToolUse hook
**Symptom:** A PostToolUse hook calls `process.exit(2)`. The behavior is undefined — depending on Claude Code version, it may silently fail, crash the hook runner, or surface a confusing error unrelated to the hook's actual intent.

## Root Cause

Exit code semantics in Claude Code hooks are event-specific:

| Event | exit 0 | exit 1 | exit 2 |
|-------|--------|--------|--------|
| PreToolUse | allow | allow (with warning) | block the tool call |
| PostToolUse | continue | continue | **undefined behavior** |
| UserPromptSubmit | allow | allow | block the prompt |
| Stop | continue | continue | undefined |

`PostToolUse` fires *after* the tool has already run — there is nothing left to block. Exit 2 has no defined meaning. In practice, Claude Code treats it as an error in the hook itself, which may:
- Print a confusing "hook exited with unexpected code" message
- Suppress the hook's actual stderr message (the one the developer wanted to see)
- Cause Claude to misattribute the error to the tool that just ran rather than the hook

The correct pattern for PostToolUse hooks that want to surface a warning: write to stderr (Claude reads it), then exit 0.

## Example Scenario

1. A `git-health-guard.cjs` hook is registered on `PostToolUse(Bash)`.
2. A git command runs and leaves a detached HEAD state.
3. The hook detects this and wants to warn:
   ```js
   process.stderr.write('[git-health] WARNING: Detached HEAD state detected.\n');
   process.exit(2);  // ← wrong
   ```
4. The warning may be swallowed, delayed, or cause Claude Code to log a hook error rather than surfacing the git warning.

## Fix

Change `process.exit(2)` to `process.exit(0)` in all PostToolUse hooks. The `process.stderr.write` call already ensures the message reaches Claude's context — the exit code is redundant and harmful.

```js
// WRONG:
process.stderr.write('[git-health] WARNING: ...\n');
process.exit(2);

// CORRECT:
process.stderr.write('[git-health] WARNING: ...\n');
process.exit(0);
```

## Behavioral Rule

> PostToolUse hooks always exit 0. Use stderr for warnings. Exit code has no blocking power after a tool has already run.

## Verification

Check all PostToolUse hook files for `process.exit(2)`. There should be none.

`diagnose.cjs --scan` detects this pattern automatically.
