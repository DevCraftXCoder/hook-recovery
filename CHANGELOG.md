# Changelog

All notable changes to this project will be documented in this file.

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
