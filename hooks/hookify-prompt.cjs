// hookify-prompt.cjs
// UserPromptSubmit — /compact detection + token-guard state reset
//
// Register on: UserPromptSubmit
//
// What it does:
//   - Detects when the user runs /compact
//   - On /compact: atomically clears both `reads` and `searches` from the token-guard
//     state file so re-reads and re-searches post-compact are unblocked
//     (after /compact, Claude's context is evicted — re-reading files is legitimate)
//   - Optionally emits a reminder on action-verb prompts (implement, build, fix, etc.)
//     to remind Claude to check project memory before implementing
//
// State file: JSON at TOKEN_GUARD_STATE_FILE env var path (default: OS temp dir)
// Must match the same path used by token-guard.cjs

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const TOKEN_GUARD_STATE = process.env.TOKEN_GUARD_STATE_FILE
  || path.join(os.tmpdir(), 'token-guard-state.json');

const ACTION_VERBS = /\b(implement|build|add|fix|create|update|refactor|deploy|migrate)\b/i;
const COMPACT_PATTERN = /^\s*\/compact\b/i;

// --- stdin helpers ---

function readStdinJson(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    const timer = setTimeout(() => reject(new Error('stdin timeout')), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`stdin parse error: ${e.message}`)); }
    });
    process.stdin.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// --- main ---

async function main() {
  let payload;
  try { payload = await readStdinJson(); } catch { process.exit(0); }

  const prompt = payload.prompt ?? payload.user_prompt ?? '';

  // /compact resets both reads and searches — re-reads/re-searches post-compact are legitimate
  if (COMPACT_PATTERN.test(prompt)) {
    try {
      let state = {};
      try { state = JSON.parse(fs.readFileSync(TOKEN_GUARD_STATE, 'utf8')); } catch { /* ok */ }
      state.reads = {};
      state.searches = {};
      state.compactTs = Date.now();
      const tmp = TOKEN_GUARD_STATE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, TOKEN_GUARD_STATE);
      process.stderr.write('[hookify-prompt] /compact detected — token-guard read+search cache cleared.\n');
    } catch { /* best effort */ }
  }

  // Optional: emit a reminder on action verbs so Claude checks project context before acting
  // Customize or remove this block to match your own memory/context workflow
  if (ACTION_VERBS.test(prompt)) {
    console.log('[hookify-prompt] Reminder: check project context or memory before implementing.');
  }
}

main().catch(() => process.exit(0));
