# Behavioral Rules

Three rules for Claude Code derived from the hook recovery fixes in this repo. Add them to your `CLAUDE.md` to improve Claude's recovery behavior when Write/Edit or re-read loops occur.

---

## Rule 1: Read Once, Write Immediately

After reading a file, write the change before doing anything else.

Do not read a file, then search for related context, then read another file, then write. Each additional tool call between the read and the write increases the chance that in-context content becomes stale — either because a concurrent write landed, or because a previous write failed silently and you are about to write on top of stale content.

The pattern to follow:

1. Read the file.
2. Formulate the change.
3. Write immediately.
4. Verify (if needed) with a single follow-up read or Bash check.

---

## Rule 2: Edit Failure → Full Rewrite

If an Edit tool call fails (signaled by `[write-confirm] FAILED` or a tool error), do not retry Edit on the same file.

Retrying a failed Edit compounds the failure:
- The file on disk may be partially modified, or unchanged.
- The in-context representation of the file may no longer match disk state.
- A second Edit attempt against stale context produces a second failed diff.

Instead: switch to Write with the complete intended file content. A full rewrite is idempotent — it doesn't depend on the prior disk state matching any expected baseline.

Before rewriting, verify actual disk state with a Bash `cat` call if the failure reason is ambiguous. If the file looks correct despite the `FAILED` signal, the write may have succeeded at the I/O level while failing at the metadata level — proceed without rewriting.

---

## Rule 3: Two Reads, No Change → Say "Stuck"

If you have read the same file twice in one session without making a change to it between reads, stop and tell the user you are stuck.

Do not read the file a third time. The third read will produce the same content as the second, and the same context as the first. No new information will be gained. The loop will continue.

Instead, surface the situation:

> "I've read `<file>` twice without making a change. I may be stuck in a re-read loop. Here is what I last saw in the file and what I was trying to do — can you tell me if the file looks different from what I expect, or what I should do next?"

This gives the user the information needed to break the loop: they can confirm the file state, clear the hook state manually, or redirect the task.

---

## Adding to CLAUDE.md

Copy-paste this block into your project or global `CLAUDE.md`:

```markdown
## Recovery Rules (hook-recovery)

- **Read once, write immediately.** After reading a file, write the change before any other tool calls. Don't read → search → read → write.
- **Edit failure → full rewrite.** If an Edit call returns `[write-confirm] FAILED`, switch to Write with the complete file content. Never retry a failed Edit on the same file.
- **Two reads, no change → say "stuck".** If you read the same file twice without modifying it between reads, stop and tell the user you are stuck rather than reading a third time.
```

---

## Why These Rules Work

The three rules address the three failure modes that the hooks fix:

| Rule | Hook | Failure Mode Addressed |
|------|------|----------------------|
| Read once, write immediately | `token-guard.cjs` | Reduces the chance of stale context accumulating before a write |
| Edit failure → full rewrite | `write-confirm.cjs` | Ensures a detected failure produces a recovery action, not a retry |
| Two reads, no change → say stuck | `token-guard.cjs` + `hookify-prompt.cjs` | Breaks re-read loops before they exhaust context budget |

The hooks provide signals. The behavioral rules tell Claude what to do with those signals. Both are needed: hooks without rules leave Claude receiving information it doesn't act on; rules without hooks leave Claude with no signal to trigger the rules.
