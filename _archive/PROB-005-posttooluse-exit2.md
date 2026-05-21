# PROB-005: exit 2 in PostToolUse Hooks

**Status:** resolved
**Added:** 2026-05-21
**Hook(s):** any hook registered on PostToolUse
**Symptom:** A PostToolUse hook that exits 2 either silently fails, produces confusing terminal output, or creates undefined behavior depending on the Claude Code version — the intended block reason is never clearly surfaced.

## Root Cause

Exit code 2 in Claude Code hooks is defined as "block the tool call and surface the stderr message as the reason." For `PreToolUse` this makes sense — the tool has not run yet and can be prevented. For `PostToolUse` the tool has already run and completed; there is nothing left to block. The exit code 2 contract is undefined in the PostToolUse context, and Claude Code's behavior varies: it may ignore the exit code, surface a confusing error, or create state inconsistency.

Advisory messages from PostToolUse hooks — things like "this file has console.log statements" or "git health warning" — should inform Claude by writing to `stderr` (which Claude reads) and always exiting 0. The exit code should never drive behavior in PostToolUse.

## Example Scenario

1. `git-health-guard.cjs` detects a dirty working tree after a Bash command.
2. Line 124: `process.exit(2)` with a warning message.
3. The git command already completed. There is nothing to block.
4. Claude Code receives exit 2 in a PostToolUse context — behavior is undefined.
5. The developer sees a confusing error that does not explain what happened.

## Fix

PostToolUse hooks must always exit 0. Use `process.stderr.write(...)` to emit advisory messages — Claude reads stderr output from PostToolUse hooks and includes it in its reasoning. The exit code must be 0 regardless of whether the hook found an issue.

```js
// WRONG — undefined behavior in PostToolUse
process.stderr.write('[git-health-guard] WARNING: working tree is dirty\n');
process.exit(2);

// CORRECT — advisory via stderr, clean exit
process.stderr.write('[git-health-guard] WARNING: working tree is dirty\n');
process.exit(0);
```

## Behavioral Rule

> `PostToolUse` hooks always exit 0. Use `process.stderr.write` for advisory messages that Claude should read. Exit code 2 is meaningful only in `PreToolUse` and `UserPromptSubmit` where something can still be blocked.

## Verification

Trigger the condition the hook detects. Confirm the advisory message appears in the terminal (stderr), Claude incorporates the advisory in its next reasoning step, and no error state is created from the hook exit code.
