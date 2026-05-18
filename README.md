# claude-code-hook-recovery

> Recovery hooks and diagnostic tools for Claude Code — fixes for Write/Edit stuck loops,
> re-read advisory traps, and post-compact unblock.

---

## The Problem

Claude Code uses hooks to enforce good habits: don't re-read files you already have in context, don't dump large files without offset/limit, warn before wasteful agent calls. These guards work well during normal sessions. But they create three failure modes that compound into loops.

**Re-read advisory traps.** When a hook flags a file as already-read this session, Claude receives an advisory on every subsequent attempt to read it. If the file actually changed (because a write succeeded), Claude has no way to verify the new state without re-reading — but the hook keeps warning. Claude may spin: re-read → advisory → re-read → advisory.

**Silent Write/Edit failures.** Claude Code's Write and Edit tools can fail without surfacing a clear signal. The tool returns, Claude assumes the write landed, and continues working on stale in-context content. The file on disk is unchanged. When Claude later tries to verify its work, the mismatch triggers another read cycle.

**Post-compact state desync.** `/compact` evicts Claude's session context — all prior reads are gone from memory. But the hook state file that tracks which files were read this session is not cleared. Every file Claude legitimately needs to re-read after compaction triggers the same advisory it would for a wasteful duplicate read. The three problems compound: a failed write leaves Claude with wrong context, the re-read advisory blocks recovery, and a prior `/compact` may have made the advisory state stale from the start.

---

## What This Fixes

| Hook | Problem | How |
|------|---------|-----|
| `token-guard.cjs` | Re-read advisory blocks recovery | Downgrades re-reads to advisory (exit 0); hard block (exit 2) only for large files without offset/limit |
| `write-confirm.cjs` | Silent Write/Edit failures | Emits `[write-confirm] OK` / `[write-confirm] FAILED` after every write so Claude knows the outcome |
| `hookify-prompt.cjs` | `/compact` doesn't reset re-read state | Detects `/compact` and atomically clears token-guard state so post-compact re-reads are allowed |

---

## Install

### Option 1: Install script (recommended)

```sh
git clone https://github.com/DevCraftXCoder/claude-code-hook-recovery.git
cd claude-code-hook-recovery
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

Check whether all three hooks are correctly wired:

```sh
node diagnose.cjs
```

Example output:

```
[PASS] token-guard        registered on PreToolUse Read|Agent|Grep|Glob
[PASS] write-confirm      registered on PostToolUse Write|Edit (first position)
[PASS] hookify-prompt     registered on UserPromptSubmit
0 warnings, 0 failures
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
