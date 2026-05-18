# PROB-001: Re-read Advisory Loop

**Status:** resolved
**Added:** 2026-05-18
**Hook(s):** token-guard.cjs
**Symptom:** Claude is blocked from re-reading a file it already read this session, even when a prior Write/Edit failed and re-reading is the correct recovery action.

## Root Cause

The original token-guard used exit code 2 (hard block) for ALL duplicate reads, including legitimate post-failure recovery reads. A failed write leaves the model with stale context — its in-memory representation of the file no longer matches what is on disk. The hard block prevents it from refreshing that context, so Claude either hallucinates the current file state or gives up.

## Example Scenario

1. Claude reads `src/routes/posts.ts` to understand the current state.
2. Claude attempts an Edit — the tool returns an error (old_string not found, file changed on disk).
3. Claude needs to re-read to get the actual current content before retrying.
4. token-guard fires with exit 2: "Already read this file — skipping duplicate."
5. Claude cannot recover. It either guesses the content or stops the task.

## Fix

Downgrade all duplicate read detections from exit 2 (hard block) to exit 0 (advisory warning). Hard block is reserved exclusively for large files (>500 lines) read without an `offset`/`limit`, where the intent is to prevent dumping an entire file unnecessarily. Re-reads — regardless of whether they're duplicates — never warrant a hard block.

## Behavioral Rule

> Read once, write immediately. If Edit fails, go straight to Write (full rewrite). If stuck after 2 reads with no file change, say "stuck" and ask the user.

## Verification

After a failed Edit, token-guard should emit an advisory message (visible in hook output) but return exit 0. Claude should proceed to re-read the file. Look for the advisory text in the PreToolUse output without a blocked tool call.
