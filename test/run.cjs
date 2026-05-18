// run.cjs — test suite for hook-recovery hooks
// Pure Node.js, no dependencies, CommonJS.
// Run: node test/run.cjs

/* eslint-disable no-console */
'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const HOOKS = path.join(ROOT, 'hooks');
const TOKEN_GUARD = path.join(HOOKS, 'token-guard.cjs');
const WRITE_CONFIRM = path.join(HOOKS, 'write-confirm.cjs');
const HOOKIFY_PROMPT = path.join(HOOKS, 'hookify-prompt.cjs');

// Isolated state file — shared across the full run so integration tests work
const STATE_FILE = path.join(os.tmpdir(), `token-guard-test-${Date.now()}.json`);
process.env.TOKEN_GUARD_STATE_FILE = STATE_FILE;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a hook, send JSON payload, collect stdout+stderr+exitCode.
 */
function runHook(hookPath, payload) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('node', [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('error', reject);
    child.on('close', exitCode => resolve({ stdout, stderr, exitCode }));

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/** Reset state file to a clean slate. */
function resetState() {
  try { fs.unlinkSync(STATE_FILE); } catch { /* ok if missing */ }
}

/** Write a known state into the state file. */
function seedState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

/**
 * Create a temp file larger than the 25,000-byte threshold.
 * Returns the path; caller must unlink after use.
 */
function makeLargeFile() {
  const p = path.join(os.tmpdir(), `tg-large-${Date.now()}.ts`);
  fs.writeFileSync(p, 'x'.repeat(25001));
  return p;
}

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let total = 0;
let passed = 0;
let failed = 0;
const failures = [];
let testIndex = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function test(label, fn) {
  testIndex++;
  const idx = testIndex;
  try {
    await fn();
    const padded = String(idx).padStart(2, ' ');
    console.log(`  [PASS] ${padded}. ${label}`);
    passed++;
  } catch (err) {
    const padded = String(idx).padStart(2, ' ');
    console.log(`  [FAIL] ${padded}. ${label}`);
    console.log(`         ${err.message}`);
    failed++;
    failures.push({ idx, label, message: err.message });
  }
  total++;
}

function section(title, count) {
  console.log(`\n${title} (${count} tests)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('hook-recovery test suite');
  console.log('=====================================');

  // -------------------------------------------------------------------------
  // token-guard.cjs
  // -------------------------------------------------------------------------
  section('token-guard.cjs', 8);

  await test('advisory on duplicate Read', async () => {
    resetState();
    const payload = { tool_name: 'Read', tool_input: { file_path: '/tmp/test-advisory.ts' } };
    // First read — seeds the state
    await runHook(TOKEN_GUARD, payload);
    // Second read — should produce advisory
    const r = await runHook(TOKEN_GUARD, payload);
    assert(r.exitCode === 0, `exit code should be 0 (advisory), got ${r.exitCode}`);
    assert(r.stderr.includes('[token-guard] Advisory'), `expected advisory in stderr, got: ${r.stderr}`);
    assert(r.stderr.includes('test-advisory.ts'), `advisory should mention filename, got: ${r.stderr}`);
  });

  await test('no advisory on first Read', async () => {
    resetState();
    const payload = { tool_name: 'Read', tool_input: { file_path: '/tmp/first-read-once.ts' } };
    const r = await runHook(TOKEN_GUARD, payload);
    assert(r.exitCode === 0, `exit code should be 0, got ${r.exitCode}`);
    assert(!r.stderr.includes('Advisory'), `no advisory expected on first read, got: ${r.stderr}`);
  });

  await test('hard block large file without limit', async () => {
    resetState();
    const largeFile = makeLargeFile();
    try {
      const payload = { tool_name: 'Read', tool_input: { file_path: largeFile } };
      const r = await runHook(TOKEN_GUARD, payload);
      assert(r.exitCode === 2, `exit code should be 2 (hard block), got ${r.exitCode}`);
      assert(r.stderr.includes('[token-guard]'), `expected block message in stderr, got: ${r.stderr}`);
      assert(r.stderr.includes('offset/limit'), `message should mention offset/limit, got: ${r.stderr}`);
    } finally {
      try { fs.unlinkSync(largeFile); } catch { /* ok */ }
    }
  });

  await test('no block on large file with offset+limit', async () => {
    resetState();
    const largeFile = makeLargeFile();
    try {
      const payload = { tool_name: 'Read', tool_input: { file_path: largeFile, offset: 0, limit: 50 } };
      const r = await runHook(TOKEN_GUARD, payload);
      assert(r.exitCode === 0, `exit code should be 0 (bounded read allowed), got ${r.exitCode}`);
    } finally {
      try { fs.unlinkSync(largeFile); } catch { /* ok */ }
    }
  });

  await test('advisory on duplicate Grep', async () => {
    resetState();
    const payload = { tool_name: 'Grep', tool_input: { pattern: 'myPattern', path: '/tmp' } };
    // First Grep — seeds the state
    await runHook(TOKEN_GUARD, payload);
    // Second Grep — same pattern+path should produce advisory
    const r = await runHook(TOKEN_GUARD, payload);
    assert(r.exitCode === 0, `exit code should be 0 (advisory), got ${r.exitCode}`);
    assert(r.stderr.includes('[token-guard] Advisory'), `expected advisory in stderr, got: ${r.stderr}`);
    assert(r.stderr.includes('Grep'), `advisory should mention Grep, got: ${r.stderr}`);
  });

  await test('no advisory on first Grep', async () => {
    resetState();
    const payload = { tool_name: 'Grep', tool_input: { pattern: 'uniquePatternXYZ', path: '/tmp' } };
    const r = await runHook(TOKEN_GUARD, payload);
    assert(r.exitCode === 0, `exit code should be 0, got ${r.exitCode}`);
    assert(!r.stderr.includes('Advisory'), `no advisory expected on first Grep, got: ${r.stderr}`);
  });

  await test('advisory Agent missing subagent_type', async () => {
    const payload = { tool_name: 'Agent', tool_input: { prompt: 'do something useful' } };
    const r = await runHook(TOKEN_GUARD, payload);
    assert(r.exitCode === 0, `exit code should be 0 (advisory only), got ${r.exitCode}`);
    assert(r.stderr.includes('subagent_type'), `expected subagent_type advisory, got: ${r.stderr}`);
  });

  await test('advisory Agent prompt over 300 words', async () => {
    // Generate a 310-word prompt
    const prompt = Array.from({ length: 310 }, (_, i) => `word${i}`).join(' ');
    const payload = { tool_name: 'Agent', tool_input: { subagent_type: 'implementation-expert', prompt } };
    const r = await runHook(TOKEN_GUARD, payload);
    assert(r.exitCode === 0, `exit code should be 0 (advisory only), got ${r.exitCode}`);
    assert(r.stderr.includes('310 words'), `expected word count in advisory, got: ${r.stderr}`);
  });

  // -------------------------------------------------------------------------
  // write-confirm.cjs
  // -------------------------------------------------------------------------
  section('write-confirm.cjs', 7);

  await test('OK on successful Write', async () => {
    const payload = {
      tool_name: 'Write',
      tool_input: { file_path: '/some/component.ts' },
      tool_response: { content: 'File written successfully' },
    };
    const r = await runHook(WRITE_CONFIRM, payload);
    assert(r.exitCode === 0, `exit code should be 0, got ${r.exitCode}`);
    assert(r.stderr.includes('[write-confirm] OK'), `expected OK signal, got: ${r.stderr}`);
    assert(r.stderr.includes('Write'), `OK message should mention tool, got: ${r.stderr}`);
    assert(r.stderr.includes('component.ts'), `OK message should mention filename, got: ${r.stderr}`);
  });

  await test('OK on successful Edit', async () => {
    const payload = {
      tool_name: 'Edit',
      tool_input: { file_path: '/some/utils.ts' },
      tool_response: { content: 'Edit applied' },
    };
    const r = await runHook(WRITE_CONFIRM, payload);
    assert(r.exitCode === 0, `exit code should be 0, got ${r.exitCode}`);
    assert(r.stderr.includes('[write-confirm] OK'), `expected OK signal, got: ${r.stderr}`);
    assert(r.stderr.includes('utils.ts'), `OK message should mention filename, got: ${r.stderr}`);
  });

  await test('FAIL on is_error: true response', async () => {
    const payload = {
      tool_name: 'Write',
      tool_input: { file_path: '/some/broken.ts' },
      tool_response: { is_error: true, content: 'something went wrong' },
    };
    const r = await runHook(WRITE_CONFIRM, payload);
    assert(r.exitCode === 0, `exit code should always be 0, got ${r.exitCode}`);
    assert(r.stderr.includes('[write-confirm] FAILED'), `expected FAILED signal, got: ${r.stderr}`);
    assert(r.stderr.includes('broken.ts'), `FAILED message should mention filename, got: ${r.stderr}`);
  });

  await test('FAIL on "internal error" in response text', async () => {
    const payload = {
      tool_name: 'Edit',
      tool_input: { file_path: '/some/route.ts' },
      tool_response: { content: 'internal error occurred during write' },
    };
    const r = await runHook(WRITE_CONFIRM, payload);
    assert(r.exitCode === 0, `exit code should always be 0, got ${r.exitCode}`);
    assert(r.stderr.includes('[write-confirm] FAILED'), `expected FAILED on error keyword, got: ${r.stderr}`);
  });

  await test('silent on non-Write/Edit tool', async () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_response: { content: 'hello' },
    };
    const r = await runHook(WRITE_CONFIRM, payload);
    assert(r.exitCode === 0, `exit code should be 0, got ${r.exitCode}`);
    assert(r.stderr === '', `no output expected for Bash tool, got: ${r.stderr}`);
    assert(r.stdout === '', `no stdout expected for Bash tool, got: ${r.stdout}`);
  });

  await test('exit 0 always (never blocks)', async () => {
    // Even with a hard error, write-confirm must not block (exit 2)
    const payload = {
      tool_name: 'Write',
      tool_input: { file_path: '/some/critical.ts' },
      tool_response: { is_error: true, content: 'disk full error' },
    };
    const r = await runHook(WRITE_CONFIRM, payload);
    assert(r.exitCode === 0, `write-confirm must always exit 0, got ${r.exitCode}`);
  });

  await test('handles missing file_path gracefully', async () => {
    const payload = {
      tool_name: 'Write',
      tool_input: {},  // no file_path
      tool_response: { content: 'written' },
    };
    const r = await runHook(WRITE_CONFIRM, payload);
    // Missing filename — hook silently exits 0 (basename of '' resolves to '' and hook bails)
    assert(r.exitCode === 0, `exit code should be 0, got ${r.exitCode}`);
    assert(!r.stderr.includes('Error:'), `should not throw an unhandled error, got: ${r.stderr}`);
  });

  // -------------------------------------------------------------------------
  // hookify-prompt.cjs
  // -------------------------------------------------------------------------
  section('hookify-prompt.cjs', 5);

  await test('clears reads+searches on /compact', async () => {
    // Seed a non-empty state
    seedState({ reads: { '/tmp/a.ts': 1234 }, searches: { 'Grep:foo:/tmp': 5678 } });
    const payload = { prompt: '/compact' };
    const r = await runHook(HOOKIFY_PROMPT, payload);
    assert(r.exitCode === 0, `exit code should be 0, got ${r.exitCode}`);
    // Check state file was cleared
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert(Object.keys(state.reads).length === 0, `reads should be cleared, got: ${JSON.stringify(state.reads)}`);
    assert(Object.keys(state.searches).length === 0, `searches should be cleared, got: ${JSON.stringify(state.searches)}`);
    assert(r.stderr.includes('[hookify-prompt] /compact detected'), `expected compact notice, got: ${r.stderr}`);
  });

  await test('clears reads+searches on /compact with trailing space', async () => {
    seedState({ reads: { '/tmp/b.ts': 9999 }, searches: {} });
    const payload = { prompt: '/compact   ' };
    const r = await runHook(HOOKIFY_PROMPT, payload);
    assert(r.exitCode === 0, `exit code should be 0, got ${r.exitCode}`);
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert(Object.keys(state.reads).length === 0, `reads should be cleared after /compact with trailing spaces`);
  });

  await test('does NOT clear on non-compact prompt', async () => {
    seedState({ reads: { '/tmp/c.ts': 1111 }, searches: { 'Grep:bar:/src': 2222 } });
    const payload = { prompt: 'implement a new feature for the feed' };
    await runHook(HOOKIFY_PROMPT, payload);
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert(state.reads['/tmp/c.ts'] === 1111, `reads should be preserved on non-compact prompt`);
    assert(state.searches['Grep:bar:/src'] === 2222, `searches should be preserved on non-compact prompt`);
  });

  await test('exits 0 always', async () => {
    const r1 = await runHook(HOOKIFY_PROMPT, { prompt: '/compact' });
    assert(r1.exitCode === 0, `hookify-prompt must always exit 0 on /compact, got ${r1.exitCode}`);

    resetState();
    const r2 = await runHook(HOOKIFY_PROMPT, { prompt: 'build something' });
    assert(r2.exitCode === 0, `hookify-prompt must always exit 0 on action verb, got ${r2.exitCode}`);
  });

  await test('reminder emitted on action verb prompt', async () => {
    resetState();
    const payload = { prompt: 'implement the new auth route' };
    const r = await runHook(HOOKIFY_PROMPT, payload);
    assert(r.exitCode === 0, `exit code should be 0, got ${r.exitCode}`);
    // Reminder goes to stdout (console.log)
    assert(r.stdout.includes('[hookify-prompt] Reminder'), `expected reminder in stdout, got: ${r.stdout}`);
  });

  // -------------------------------------------------------------------------
  // Integration tests
  // -------------------------------------------------------------------------
  section('integration', 3);

  await test('token-guard allows re-read after hookify-prompt /compact reset', async () => {
    resetState();
    const filePath = '/tmp/integration-file.ts';
    const readPayload = { tool_name: 'Read', tool_input: { file_path: filePath } };

    // First read — seeds state
    const r1 = await runHook(TOKEN_GUARD, readPayload);
    assert(r1.exitCode === 0, `first read should pass, got exit ${r1.exitCode}`);
    assert(!r1.stderr.includes('Advisory'), `no advisory on first read, got: ${r1.stderr}`);

    // Second read — should produce advisory
    const r2 = await runHook(TOKEN_GUARD, readPayload);
    assert(r2.exitCode === 0, `second read should be advisory (exit 0), got ${r2.exitCode}`);
    assert(r2.stderr.includes('Advisory'), `expected advisory on second read, got: ${r2.stderr}`);

    // /compact resets token-guard state
    await runHook(HOOKIFY_PROMPT, { prompt: '/compact' });

    // Third read after /compact — should NOT produce advisory (state was cleared)
    const r3 = await runHook(TOKEN_GUARD, readPayload);
    assert(r3.exitCode === 0, `post-compact read should pass, got exit ${r3.exitCode}`);
    assert(!r3.stderr.includes('Advisory'), `no advisory expected after /compact reset, got: ${r3.stderr}`);
  });

  await test('write-confirm OK does not affect token-guard state', async () => {
    resetState();
    const filePath = '/tmp/wc-does-not-affect.ts';

    // Seed the state with a known read
    seedState({ reads: { [filePath]: 12345 }, searches: {} });

    // Run write-confirm for a successful write
    const wcPayload = {
      tool_name: 'Write',
      tool_input: { file_path: filePath },
      tool_response: { content: 'File written successfully' },
    };
    const wr = await runHook(WRITE_CONFIRM, wcPayload);
    assert(wr.exitCode === 0, `write-confirm should exit 0, got ${wr.exitCode}`);
    assert(wr.stderr.includes('[write-confirm] OK'), `expected OK, got: ${wr.stderr}`);

    // Token-guard state should be unchanged (write-confirm does not touch it)
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert(state.reads[filePath] === 12345, `token-guard state should be unmodified by write-confirm`);
  });

  await test('large file blocked, then allowed with limit (willBlock fix)', async () => {
    resetState();
    const largeFile = makeLargeFile();
    try {
      // Attempt 1 — no limit, large file → hard block (exit 2)
      const r1 = await runHook(TOKEN_GUARD, {
        tool_name: 'Read',
        tool_input: { file_path: largeFile },
      });
      assert(r1.exitCode === 2, `first attempt should be hard-blocked (exit 2), got ${r1.exitCode}`);

      // Attempt 2 — same file, with limit → should be allowed (no block, no dup advisory)
      // willBlock fix: the file was NOT added to state.reads on the blocked attempt,
      // so re-reading with limit should not trigger the dup advisory.
      const r2 = await runHook(TOKEN_GUARD, {
        tool_name: 'Read',
        tool_input: { file_path: largeFile, limit: 100 },
      });
      assert(r2.exitCode === 0, `bounded retry should be allowed (exit 0), got ${r2.exitCode}`);
      assert(!r2.stderr.includes('Advisory'), `no dup advisory expected on bounded retry after block, got: ${r2.stderr}`);
    } finally {
      try { fs.unlinkSync(largeFile); } catch { /* ok */ }
    }
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n=====================================');
  if (failed === 0) {
    console.log(`${passed}/${total} PASS  0 FAIL`);
  } else {
    console.log(`${passed}/${total} PASS  ${failed} FAIL`);
    console.log('\nFailed tests:');
    for (const f of failures) {
      console.log(`  ${f.idx}. ${f.label}`);
      console.log(`     ${f.message}`);
    }
  }
  console.log('');

  // Cleanup state file
  try { fs.unlinkSync(STATE_FILE); } catch { /* ok */ }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
