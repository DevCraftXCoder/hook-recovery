# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] — 2026-05-21

### Added

- `problems/PROB-004-stdout-block-injection.md` — Documents the P0 pattern where a `UserPromptSubmit` hook writes its block reason to `process.stdout` instead of `process.stderr`, causing the message to be injected into Claude's context window rather than surfaced as a human-readable rejection reason. Status: resolved.
- `problems/PROB-005-exit-2-in-posttooluse.md` — Documents the P1 pattern where a `PostToolUse` hook exits with code 2, which is undefined behavior in the post-tool context. The tool already ran; exit 2 cannot block anything and may produce confusing output. Advisory messages must go to stderr with exit 0. Status: resolved.
- `problems/PROB-006-stdout-in-pretooluse.md` — Documents the P1 pattern where advisory hooks in `PreToolUse` use `console.log(...)`, which on this lifecycle event injects text into Claude's context window (not the terminal). Repeated invocations accumulate noise in Claude's instructions. Fix: use `process.stderr.write`. Status: known.
- `problems/PROB-007-raw-stdin.md` — Documents the P1 pattern where hooks use `process.stdin.on('data', ...)` directly without a timeout. On rare Windows race conditions, stdin closes without emitting `end`, hanging the hook indefinitely and freezing the Claude Code session. Fix: wrap with a `readStdinJson()` helper that has a built-in timeout. Status: known.
- `problems/PROB-008-ghost-bash-registration.md` — Documents the P1 pattern where a hook written for Write/Edit events (reading `tool_input.file_path`) is also registered on PostToolUse Bash events. Bash events have no `file_path` field, so the hook silently no-ops on every shell invocation while still spawning a Node.js process each time. Fix: remove the ghost Bash registration. Status: known.
- `diagnose.cjs` Section II — Code-level pattern scanning phase added after existing registration checks. Collects all registered hook commands from `settings.json` (handles both nested `{ hooks: [{command}] }` and flat `{command}` formats), resolves each to an absolute file path, reads the file, and runs five checks: (A) PostToolUse exit 2, (B) UserPromptSubmit stdout+exit2 block injection, (C) PreToolUse console.log, (D) raw process.stdin, (E) ghost Bash file_path access. Gracefully skips files that cannot be resolved or read. Fully synchronous.

### Changed

- `README.md` — "What This Fixes" table expanded to 8 patterns with a "Detectable?" column indicating whether `diagnose.cjs` can detect each via registration check or code scan. Problem section updated to describe all 8 failure modes. Diagnose section updated with two-phase output example.
- `package.json` — version bumped from `1.0.0` to `1.1.0`.

## [1.0.0] — 2026-05-18

### Added

- `hooks/token-guard.cjs` — PreToolUse guard on Read|Agent|Grep|Glob. Tracks reads and searches in a persistent state file. Downgrades duplicate-read blocking to advisory (exit 0) so recovery reads are never hard-blocked. Hard blocks (exit 2) only for large files (>500 lines heuristic) accessed without `offset`/`limit`. `willBlock` flag prevents false-positive re-read advisories when retrying a previously blocked large-file read with `limit:` added.
- `hooks/write-confirm.cjs` — PostToolUse hook on Write|Edit. Emits `[write-confirm] OK` after every successful write. Emits `[write-confirm] FAILED` when the tool response signals an error via `is_error: true` or error keyword detection. Must be registered first among PostToolUse Write|Edit hooks to ensure the signal fires even if a downstream hook crashes.
- `hooks/hookify-prompt.cjs` — UserPromptSubmit hook. Detects `/compact` in user prompts and atomically clears both `reads` and `searches` from the token-guard state file (write-then-rename) so re-reads and re-searches after compaction are treated as fresh. Also emits a memory-protocol reminder on action-verb prompts as a secondary behavior.
- `diagnose.cjs` — Settings registration checker. Verifies all three hooks are wired in `settings.json` with correct lifecycle events and matchers. `--fix` flag prints exact JSON snippets to add. `--settings` flag accepts a custom settings file path.
- `scripts/install.sh` — POSIX install script. Copies the three hook files into `.claude/hooks/`, prompts before overwriting, runs `diagnose.cjs` on completion. Respects `CLAUDE_HOOKS_DIR` env var for custom destinations.
- `test/run.cjs` — 23-fixture test suite covering token-guard state transitions, write-confirm signal detection, hookify-prompt compact detection, and diagnose output format.
- `problems/` — Versioned problem registry. Documents known Claude Code failure patterns (root cause, symptoms, fix) in individual Markdown files.
- `docs/behavioral-rules.md` — Three behavioral rules derived from the hook fixes, formatted for copy-paste into `CLAUDE.md`.
