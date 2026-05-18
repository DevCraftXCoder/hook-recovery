# PROB-003: Post-compact Re-read Blocked

**Status:** resolved
**Added:** 2026-05-18
**Hook(s):** hookify-prompt.cjs, token-guard.cjs
**Symptom:** After the user runs `/compact` to compress conversation context, Claude is immediately blocked from re-reading files it read before the compact. These re-reads are legitimate — `/compact` evicted the prior context.

## Root Cause

`token-guard.cjs` persists session read state in a JSON file (`token-guard-state.json`) on disk. `/compact` evicts Claude's in-memory conversation context but does not clear the hook state file. So from the hook's perspective, re-reads of files that were read before `/compact` look like wasteful duplicate reads within the same session — they are tracked and blocked. From Claude's perspective, it has no memory of those reads at all.

## Example Scenario

1. Claude reads `packages/underground-api/src/routes/posts.ts` at the start of a session.
2. The session grows long. User runs `/compact`.
3. All conversation context is compressed. Claude no longer knows what it has read.
4. Claude needs to re-read `posts.ts` to continue the task.
5. token-guard fires: "Already read this file" — because the state file still has the pre-compact read logged.
6. Claude cannot access the file it needs.

## Fix

`hookify-prompt.cjs` runs on `UserPromptSubmit` and detects the `/compact` command in the submitted prompt text. When detected, it atomically clears both the `reads` and `searches` keys in `token-guard-state.json`. The state file is zeroed in the same synchronous write, so the next read of any file is treated as fresh by token-guard.

## Behavioral Rule

> After `/compact`, all file reads are fresh. The token-guard state is automatically cleared by the hookify-prompt hook — no manual intervention needed.

## Verification

1. Read any file during a session (token-guard logs the read to state).
2. Submit `/compact` as a prompt.
3. Inspect `token-guard-state.json` — `reads` and `searches` should both be empty objects `{}`.
4. Attempt to read the same file again — token-guard should not emit any advisory for it.
