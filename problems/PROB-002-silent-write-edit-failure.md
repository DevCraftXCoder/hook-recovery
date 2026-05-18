# PROB-002: Silent Write/Edit Failure

**Status:** resolved
**Added:** 2026-05-18
**Hook(s):** write-confirm.cjs
**Symptom:** Claude proceeds as if a file was written successfully, but the file was never changed. The next read still shows the old content, confusing Claude about its own state.

## Root Cause

Claude Code's Write/Edit tools can return an error response (`is_error: true` or error text in the tool response body) that the model does not always surface prominently in its reasoning chain. PostToolUse hooks fire even on tool errors — but without a hook explicitly checking the response payload, there is no signal in the conversation context that the write failed. Claude's next action assumes success.

## Example Scenario

1. Claude calls Edit on `src/index.ts` with an `old_string` that no longer matches (file changed since last read).
2. The tool returns `{ is_error: true, content: "String not found" }`.
3. No hook checks this — the PostToolUse event fires silently.
4. Claude's next message: "I've updated `src/index.ts`. Let me now update the tests."
5. The file was never changed. Tests will fail for the "wrong" reason. Claude is confused.

## Fix

`write-confirm.cjs` registers as a PostToolUse hook for Write and Edit tools. It inspects the tool response for `is_error: true` or error-keyword strings. On success it emits `[write-confirm] OK <filename>`. On failure it emits `[write-confirm] FAILED <filename>`. This signal appears in Claude's context before the next reasoning step.

## Behavioral Rule

> After any Write/Edit, look for `[write-confirm] OK` or `[write-confirm] FAILED` in the hook output before proceeding. If FAILED, do not assume the file changed.

## Verification

Trigger a deliberate Edit failure (use an old_string that does not exist in the file). The hook output should include `[write-confirm] FAILED`. Claude should not proceed as if the file was updated.

**Known limitation:** write-confirm emits FAILED when tool metadata reports "internal error" but the file actually landed correctly (a Claude Code tool bug). Use `Bash cat <file>` to verify disk state before rewriting in this case.
