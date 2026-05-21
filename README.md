# hook-recovery

> Recovery hooks and diagnostic tools for Claude Code — fixes for Write/Edit stuck loops,
> re-read advisory traps, post-compact unblock, stdout injection bugs, and ghost hook registrations.

---

## The Problem

Claude Code uses hooks to enforce good habits: don't re-read files you already have in context, don't dump large files without offset/limit, warn before wasteful agent calls. These guards work well during normal sessions. But they create failure modes that compound into loops — and the hook system itself has several sharp edges that cause subtle bugs across any Claude Code setup.

**Re-read advisory traps.** When a hook flags a file as already-read this session, Claude receives an advisory on every subsequent attempt to read it. If the file actually changed (because a write succeeded), Claude has no way to verify the new state without re-reading — but the hook keeps warning. Claude may spin: re-read → advisory → re-read → advisory.

**Silent Write/Edit failures.** Claude Code's Write and Edit tools can fail without surfacing a clear signal. The tool returns, Claude assumes the write landed, and continues working on stale in-context content. The file on disk is unchanged. When Claude later tries to verify its work, the mismatch triggers another read cycle.

**Post-compact state desync.** `/compact` evicts Claude's session context — all prior reads are gone from memory. But the hook state file that tracks which files were read this session is not cleared. Every file Claude legitimately needs to re-read after compaction triggers the same advisory it would for a wasteful duplicate read. The three problems compound: a failed write leaves Claude with wrong context, the re-read advisory blocks recovery, and a prior `/compact` may have made the advisory state stale from the start.

**stdout/stderr confusion.** On `UserPromptSubmit` and `PreToolUse`, stdout is injected into the model's context window — not shown in the terminal. Hooks that use `process.stdout.write` or `console.log` for advisory/block messages silently accumulate text inside Claude's instructions instead of surfacing it to the developer.

**exit 2 in PostToolUse.** The "block" exit code is undefined in `PostToolUse` context — the tool already ran. PostToolUse hooks that exit 2 produce confusing behavior. They must always exit 0 and use stderr for advisories.

**Raw stdin hangs.** Hooks that read `process.stdin` directly without a timeout can freeze indefinitely if stdin closes without emitting `end` — a real race condition on Windows under I/O load. A frozen hook freezes the entire Claude Code session.

**Ghost Bash registrations.** Hooks written for Write/Edit events (which have `file_path` in tool input) accidentally registered on Bash events (which do not) silently no-op on every shell command — spawning a full Node.js process each time without doing any useful work.

---

## What This Fixes

| # | Pattern | Status | Detectable |
|---|---------|--------|-----------|
| PROB-001 | Re-read advisory traps | hook: token-guard.cjs | via registration check |
| PROB-002 | Silent Write/Edit failures | hook: write-confirm.cjs | via registration check |
| PROB-003 | Post-compact re-read blocked | hook: hookify-prompt.cjs | via registration check |
| PROB-004 | stdout block injection on UserPromptSubmit | fix: use stderr | via code scan |
| PROB-005 | exit 2 in PostToolUse | fix: use exit 0 | via code scan |
| PROB-006 | console.log/stdout advisory in PreToolUse | fix: use stderr | via code scan |
| PROB-007 | raw process.stdin instead of readStdinJson | fix: use timeout wrapper | via code scan |
| PROB-008 | Ghost Bash registration (file_path undefined) | fix: remove dead registration | via code scan |

---

## Install

### Option 1: Install script (recommended)

```sh
git clone https://github.com/DevCraftXCoder/hook-recovery.git
cd hook-recovery
sh scripts/install.sh
```

The script copies the three hook files into `.claude/hooks/` (relative to your current directory), prompts before overwriting existing files, then runs `diagnose.cjs` to show you what still needs to be wired in `settings.json`.

To install into a specific hooks directory:

```sh
CLAUDE_HOOKS_DIR=/path/to/.claude/hooks sh scripts/install.sh
```

### Option 2: Manual copy

```sh
cp hooks/token-guard.cjs     .claude/hooks/token-guard.cjs
cp hooks/write-confirm.cjs   .claude/hooks/write-confirm.cjs
cp hooks/hookify-prompt.cjs  .claude/hooks/hookify-prompt.cjs
```

---

## Configuration

After copying the hook files, register them in `.claude/settings.json`. The exact path to each hook depends on where your `.claude/hooks/` directory lives — use an absolute path or a path relative to the project root.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Agent|Grep|Glob",
        "hooks": [
          { "type": "command", "command": "node .claude/hooks/token-guard.cjs" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "node .claude/hooks/write-confirm.cjs" },
          "...your other PostToolUse Write|Edit hooks..."
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node .claude/hooks/hookify-prompt.cjs" }
        ]
      }
    ]
  }
}
```

**Important:** `write-confirm.cjs` must be the **first** hook in `PostToolUse Write|Edit`. If a sync or deploy hook runs first and crashes, the confirmation signal never fires and failures stay silent.

### Custom state file path

`token-guard.cjs` and `hookify-prompt.cjs` share a state file. By default it lives in the OS temp directory (`os.tmpdir()/token-guard-state.json`). To use a custom path — for example, to scope state per project:

```json
{
  "env": {
    "TOKEN_GUARD_STATE_FILE": "/path/to/project/.claude/.token-guard-state.json"
  }
}
```

Both hooks read this env var. Set the same value in both hook registrations (or set it globally in the `env` block) so they share the same state file.

---

## Diagnose

Check whether the recovery hooks are correctly wired (Section I):

```sh
node diagnose.cjs
```

Add `--scan` to also run Section II — code-level pattern checks on every registered hook file:

```sh
node diagnose.cjs --scan
```

Or run Section II alone (skip registration checks):

```sh
node diagnose.cjs --scan-only
```

**Section I — Registration checks.** Verifies that `token-guard.cjs`, `write-confirm.cjs`, and `hookify-prompt.cjs` are wired in `settings.json` with the correct lifecycle events and matchers. Handles both the nested `{ matcher, hooks: [{command}] }` format (Claude Code 1.x) and the flat `{ command, matcher }` format.

**Section II — Code-level pattern scan.** Reads every registered hook file from `settings.json` and checks for five patterns: PostToolUse exit 2 (PROB-005), UserPromptSubmit stdout+exit2 block injection (PROB-004), PreToolUse console.log (PROB-006), raw process.stdin without timeout (PROB-007), and ghost Bash registrations reading file_path (PROB-008). Only emits output on issues — clean hooks are silent.

Example output (clean setup):

```
[PASS] token-guard.cjs             registered on PreToolUse Read|Agent|Grep|Glob
[PASS] write-confirm.cjs           registered on PostToolUse Write|Edit (first position)
[PASS] hookify-prompt.cjs          registered on UserPromptSubmit
[PASS] STATE_FILE env              not set in either hook — both will use OS temp default (consistent)
[PASS] Node.js                     v20.11.0 >= 18

Section II: Code-level pattern checks
==================================

Scanned 12 hook file(s) across 18 registration(s).

Summary: 0 warnings, 0 errors
```

If anything is missing or misconfigured:

```sh
node diagnose.cjs --fix
```

`--fix` prints the exact JSON snippets to add to your `settings.json`.

Point at a specific settings file:

```sh
node diagnose.cjs --settings /path/to/.claude/settings.json
```

---

## Behavioral Rules

See [`docs/behavioral-rules.md`](docs/behavioral-rules.md) for the full rules with explanations.

Quick reference — add these to your `CLAUDE.md` to improve recovery behavior:

1. **Read once, write immediately.** After reading a file, write the change before doing anything else. Don't read, then search, then write — the extra steps increase the chance of stale context.
2. **Edit failure → full rewrite.** If an Edit tool call fails, don't retry Edit. Go straight to Write with the complete file content. Retrying a failed Edit on the same file compounds the failure.
3. **Two reads, no change → say "stuck".** If you've read the same file twice in one session without making a change between reads, stop and tell the user you're stuck rather than looping again.

---

## How It Works

**`token-guard.cjs`** — `PreToolUse` on `Read|Agent|Grep|Glob`. Tracks every file path read and every search query in a persistent JSON state file. On a duplicate read: emits an advisory message (exit 0) so Claude is informed but not blocked — this means recovery reads always go through. On a large file read (>500 lines heuristic) without `offset`/`limit`: hard blocks (exit 2) to prevent accidental full-dump. The `willBlock` flag in state prevents false-positive advisories when Claude is retrying a previously blocked read with `limit:` added.

**`write-confirm.cjs`** — `PostToolUse` on `Write|Edit`. Receives the tool response payload via stdin after every write operation. Checks `is_error`, error keyword strings, and response structure to determine success. Prints `[write-confirm] OK` on success, `[write-confirm] FAILED` on detected failure. Claude is instructed (via the behavioral rules) to treat a `FAILED` signal as definitive and switch to a full rewrite rather than retrying the same Edit.

**`hookify-prompt.cjs`** — `UserPromptSubmit`. Inspects every user prompt before Claude processes it. On `/compact`: reads the token-guard state file, clears both `reads` and `searches` keys atomically (write-then-rename to avoid partial state), and exits. This ensures the first read after compaction is treated as a fresh read, not a duplicate. Also emits a memory-protocol reminder on action-verb prompts as a secondary behavior.

---

## Known Limitation

`write-confirm.cjs` can emit `[write-confirm] FAILED` when the tool metadata says "internal error" but the file actually landed correctly on disk. This happens when Claude Code's tool response pipeline signals an error at the metadata level while the file I/O itself succeeded.

Before rewriting a file after a `FAILED` signal, verify the actual state:

```sh
# In a Bash tool call — check what's actually on disk
cat <file_path>
```

If the file content looks correct, the write succeeded despite the `FAILED` signal. Proceed without rewriting.

---

## Contributing / Adding Problems

The `problems/` directory is a versioned registry of known Claude Code failure patterns. Each file documents one problem with root cause, symptoms, and the fix. The registry is intended to grow as new patterns are discovered.

To add a new problem:
1. Create `problems/<slug>.md` following the format in existing entries.
2. Implement the hook fix in `hooks/`.
3. Add fixtures to `test/fixtures/` and cover them in `test/run.cjs`.
4. Update this README's "What This Fixes" table.

---

## License

MIT
