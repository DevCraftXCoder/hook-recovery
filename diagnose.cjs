// diagnose.cjs
// Checks whether the recovery hooks are correctly wired in settings.json
// and scans registered hook files for common anti-patterns.
//
// Usage:
//   node diagnose.cjs
//   node diagnose.cjs --settings /path/to/.claude/settings.json
//   node diagnose.cjs --fix
//   node diagnose.cjs --scan          (Section I + II)
//   node diagnose.cjs --scan-only     (Section II code patterns only)

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const showFix = args.includes('--fix');
const runScan = args.includes('--scan') || args.includes('--scan-only');
const scanOnly = args.includes('--scan-only');

let settingsPathOverride = null;
const settingsIdx = args.indexOf('--settings');
if (settingsIdx !== -1 && args[settingsIdx + 1]) {
  settingsPathOverride = args[settingsIdx + 1];
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

let warnCount = 0;
let failCount = 0;
const fixSnippets = []; // { label, json }

function pass(label, note) {
  process.stdout.write(`[PASS] ${label.padEnd(26)} ${note}\n`);
}

function warn(label, note, snippet) {
  warnCount++;
  process.stdout.write(`[WARN] ${label.padEnd(26)} ${note}\n`);
  if (snippet) fixSnippets.push({ label, json: snippet });
}

function fail(label, note, snippet) {
  failCount++;
  process.stdout.write(`[FAIL] ${label.padEnd(26)} ${note}\n`);
  if (snippet) fixSnippets.push({ label, json: snippet });
}

function skip(label, note) {
  process.stdout.write(`[SKIP] ${label.padEnd(26)} ${note}\n`);
}

// ---------------------------------------------------------------------------
// Settings discovery
// ---------------------------------------------------------------------------

function findSettingsFile(override) {
  if (override) {
    return fs.existsSync(override) ? override : null;
  }
  const candidates = [
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hook inspection helpers
// ---------------------------------------------------------------------------

/**
 * Get all hook entries for a given lifecycle event from the settings object.
 *
 * Handles both formats:
 *   Flat:   { command, matcher, env }
 *   Nested: { matcher, hooks: [{ type, command, env }] }   ← Claude Code 1.x format
 *
 * Returns an array of { command: string, matcher: string|undefined, env: object|undefined }.
 */
function getHookEntries(settings, event) {
  const hooks = settings.hooks;
  if (!hooks || !hooks[event]) return [];
  const raw = hooks[event];
  if (!Array.isArray(raw)) return [];

  const entries = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      entries.push({ command: entry, matcher: undefined });
    } else if (typeof entry === 'object' && entry !== null) {
      if (Array.isArray(entry.hooks)) {
        // Nested format: { matcher, hooks: [{ type, command, env }] }
        for (const h of entry.hooks) {
          if (typeof h === 'string') {
            entries.push({ command: h, matcher: entry.matcher });
          } else if (typeof h === 'object' && h !== null) {
            entries.push({
              command: h.command ?? '',
              matcher: entry.matcher,
              env: h.env ?? entry.env,
            });
          }
        }
      } else {
        // Flat format: { command, matcher, env }
        entries.push({ command: entry.command ?? '', matcher: entry.matcher, env: entry.env });
      }
    }
  }
  return entries;
}

/**
 * Check if any entry in a list matches a filename and optional matcher pattern.
 * matcher is a pipe-separated list like "Read|Agent|Grep|Glob".
 */
function findHookEntry(entries, filename, requiredMatcher) {
  return entries.filter(e => e.command.includes(filename)).filter(e => {
    if (!requiredMatcher) return true;
    if (!e.matcher) return false;
    const required = requiredMatcher.split('|').map(s => s.trim());
    const actual = (e.matcher ?? '').split('|').map(s => s.trim());
    return required.every(r => actual.includes(r));
  });
}

/**
 * Read env var from a hook entry's env block.
 */
function getEnvVar(entry, key) {
  if (!entry || !entry.env || typeof entry.env !== 'object') return undefined;
  return entry.env[key];
}

// ---------------------------------------------------------------------------
// Suggested snippet builders
// ---------------------------------------------------------------------------

function tokenGuardSnippet() {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read|Agent|Grep|Glob',
          command: 'node .claude/hooks/token-guard.cjs',
        },
      ],
    },
  }, null, 2);
}

function writeConfirmSnippet() {
  return JSON.stringify({
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write|Edit',
          command: 'node .claude/hooks/write-confirm.cjs',
          _note: 'Must be FIRST in this list',
        },
      ],
    },
  }, null, 2);
}

function hookifyPromptSnippet() {
  return JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        {
          command: 'node .claude/hooks/hookify-prompt.cjs',
        },
      ],
    },
  }, null, 2);
}

function stateFileSnippet(existingValue) {
  const val = existingValue || path.join(os.tmpdir(), 'token-guard-state.json');
  return JSON.stringify({
    _note: 'Set TOKEN_GUARD_STATE_FILE consistently in BOTH token-guard and hookify-prompt hook entries',
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read|Agent|Grep|Glob',
          command: 'node .claude/hooks/token-guard.cjs',
          env: { TOKEN_GUARD_STATE_FILE: val },
        },
      ],
      UserPromptSubmit: [
        {
          command: 'node .claude/hooks/hookify-prompt.cjs',
          env: { TOKEN_GUARD_STATE_FILE: val },
        },
      ],
    },
  }, null, 2);
}

// ---------------------------------------------------------------------------
// Code-level pattern scan helpers
// ---------------------------------------------------------------------------

/**
 * Collect all registered hook commands from settings with their event + matcher.
 * Returns [{ event, matcher, command }]
 */
function collectAllHooks(settings) {
  const result = [];
  const hooks = settings.hooks;
  if (!hooks) return result;
  for (const event of Object.keys(hooks)) {
    for (const e of getHookEntries(settings, event)) {
      if (e.command) result.push({ event, matcher: e.matcher, command: e.command });
    }
  }
  return result;
}

/**
 * Extract the .cjs file path from a hook command string.
 * Handles:
 *   node .claude/hooks/foo.cjs
 *   C:/nvm/node.exe --max-old-space-size=64 C:/path/to/hook.cjs
 */
function resolveHookFile(command, settingsPath) {
  const parts = command.trim().split(/\s+/);
  const cjsArg = [...parts].reverse().find(p => p.endsWith('.cjs'));
  if (!cjsArg) return null;
  if (path.isAbsolute(cjsArg)) return cjsArg;
  // Relative paths are relative to project root (parent of .claude/)
  const projectRoot = path.dirname(path.dirname(settingsPath));
  return path.join(projectRoot, cjsArg);
}

// Hooks that legitimately use stdout for intentional model context injection
const KNOWN_STDOUT_INJECTION_HOOKS = [
  'guard-git-scope',
  'enforce-approved',
  'enforce-opus',
  'opus-only-toggle',
  'superpowers-remind',
];

// ---------------------------------------------------------------------------
// Section I: Registration checks
// ---------------------------------------------------------------------------

async function runRegistrationChecks(settings, settingsPath) {
  // --- token-guard.cjs on PreToolUse ---
  {
    const entries = getHookEntries(settings, 'PreToolUse');
    const matches = findHookEntry(entries, 'token-guard.cjs', 'Read|Agent|Grep|Glob');

    if (matches.length === 0) {
      const anyMatch = findHookEntry(entries, 'token-guard.cjs', null);
      if (anyMatch.length > 0) {
        warn(
          'token-guard.cjs',
          `registered on PreToolUse but matcher is "${anyMatch[0].matcher ?? '(none)'}" — expected "Read|Agent|Grep|Glob"`,
          tokenGuardSnippet()
        );
      } else {
        fail(
          'token-guard.cjs',
          'not found in PreToolUse — large-file guard and re-read advisory will be inactive',
          tokenGuardSnippet()
        );
      }
    } else {
      pass('token-guard.cjs', 'registered on PreToolUse (Read|Agent|Grep|Glob)');
    }
  }

  // --- write-confirm.cjs on PostToolUse, must be first ---
  {
    const entries = getHookEntries(settings, 'PostToolUse');
    const writeEditEntries = entries.filter(e => {
      if (!e.matcher) return false;
      const parts = e.matcher.split('|').map(s => s.trim());
      return parts.includes('Write') || parts.includes('Edit');
    });

    const confirmEntries = findHookEntry(entries, 'write-confirm.cjs', null);

    if (confirmEntries.length === 0) {
      fail(
        'write-confirm.cjs',
        'not found in PostToolUse — silent write failures will not be surfaced',
        writeConfirmSnippet()
      );
    } else {
      const firstWriteEditIdx = writeEditEntries.length > 0
        ? entries.indexOf(writeEditEntries[0])
        : -1;
      const confirmIdx = entries.indexOf(confirmEntries[0]);

      if (firstWriteEditIdx !== -1 && confirmIdx > firstWriteEditIdx) {
        warn(
          'write-confirm.cjs',
          'registered but NOT first in PostToolUse Write|Edit — move it before other hooks',
          writeConfirmSnippet()
        );
      } else {
        const hasWriteEditMatcher = confirmEntries.some(e => {
          if (!e.matcher) return false;
          const parts = e.matcher.split('|').map(s => s.trim());
          return parts.includes('Write') || parts.includes('Edit');
        });
        if (!hasWriteEditMatcher) {
          warn(
            'write-confirm.cjs',
            `registered but matcher is "${confirmEntries[0].matcher ?? '(none)'}" — expected Write|Edit`,
            writeConfirmSnippet()
          );
        } else {
          pass('write-confirm.cjs', 'registered and first in PostToolUse Write|Edit');
        }
      }
    }
  }

  // --- hookify-prompt.cjs on UserPromptSubmit ---
  {
    const entries = getHookEntries(settings, 'UserPromptSubmit');
    const matches = findHookEntry(entries, 'hookify-prompt.cjs', null);

    if (matches.length === 0) {
      fail(
        'hookify-prompt.cjs',
        'not found in UserPromptSubmit — /compact will not clear token-guard state',
        hookifyPromptSnippet()
      );
    } else {
      pass('hookify-prompt.cjs', 'registered on UserPromptSubmit');
    }
  }

  // --- TOKEN_GUARD_STATE_FILE consistency ---
  {
    const preEntries = getHookEntries(settings, 'PreToolUse');
    const upEntries = getHookEntries(settings, 'UserPromptSubmit');

    const guardEntry = findHookEntry(preEntries, 'token-guard.cjs', null)[0];
    const hookifyEntry = findHookEntry(upEntries, 'hookify-prompt.cjs', null)[0];

    if (guardEntry && hookifyEntry) {
      const guardVal = getEnvVar(guardEntry, 'TOKEN_GUARD_STATE_FILE');
      const hookifyVal = getEnvVar(hookifyEntry, 'TOKEN_GUARD_STATE_FILE');

      if (guardVal !== undefined || hookifyVal !== undefined) {
        if (guardVal !== hookifyVal) {
          warn(
            'STATE_FILE env',
            `token-guard has "${guardVal ?? '(not set)'}", hookify-prompt has "${hookifyVal ?? '(not set)'}" — they must match`,
            stateFileSnippet(guardVal || hookifyVal)
          );
        } else {
          pass('STATE_FILE env', `consistent ("${guardVal}") between token-guard and hookify-prompt`);
        }
      } else {
        pass('STATE_FILE env', 'not set in either hook — both will use OS temp default (consistent)');
      }
    } else {
      pass('STATE_FILE env', 'skipped — requires both token-guard and hookify-prompt to be registered');
    }
  }

  // --- Node.js version ---
  {
    const [, major] = process.version.match(/^v(\d+)/) || [];
    if (parseInt(major, 10) >= 18) {
      pass('Node.js', `${process.version} >= 18`);
    } else {
      warn('Node.js', `${process.version} — hooks require Node.js >= 18`);
    }
  }
}

// ---------------------------------------------------------------------------
// Section II: Code-level pattern checks
// ---------------------------------------------------------------------------

function runCodePatternChecks(settings, settingsPath) {
  process.stdout.write('\nSection II: Code-level pattern checks\n');
  process.stdout.write('==================================\n\n');

  const allHooks = collectAllHooks(settings);
  if (allHooks.length === 0) {
    process.stdout.write('No hooks found to scan.\n');
    return;
  }

  const seen = new Set();
  let scanned = 0;

  for (const { event, matcher, command } of allHooks) {
    const filePath = resolveHookFile(command, settingsPath);
    if (!filePath) continue;

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
      scanned++;
    } catch {
      if (!seen.has(`read:${filePath}`)) {
        skip(path.basename(filePath), `not readable at ${filePath}`);
        seen.add(`read:${filePath}`);
      }
      continue;
    }

    const stripped = content.replace(/\/\/[^\n]*/g, ''); // strip // comments
    const basename = path.basename(filePath);
    const isKnownStdout = KNOWN_STDOUT_INJECTION_HOOKS.some(k => basename.includes(k));

    // Check A — PostToolUse: no exit(2)
    if (event === 'PostToolUse' && !seen.has(`A:${filePath}`)) {
      seen.add(`A:${filePath}`);
      if (/process\.exit\s*\(\s*2\s*\)/.test(stripped)) {
        warn('posttooluse:exit2', `${basename}: PostToolUse hooks must exit 0, not 2 — see PROB-005`);
      }
    }

    // Check B — UserPromptSubmit: stdout + exit(2) = injection bug
    if (event === 'UserPromptSubmit' && !seen.has(`B:${filePath}`) && !isKnownStdout) {
      seen.add(`B:${filePath}`);
      if (/process\.stdout\.write/.test(stripped) && /process\.exit\s*\(\s*2\s*\)/.test(stripped)) {
        fail(
          'userprompt:stdout-block',
          `${basename}: stdout + exit 2 on UserPromptSubmit injects as model context — use process.stderr.write (PROB-004)`
        );
      }
    }

    // Check C — PreToolUse: console.log injects into model context
    if (event === 'PreToolUse' && !seen.has(`C:${filePath}`) && !isKnownStdout) {
      seen.add(`C:${filePath}`);
      if (/console\.log\s*\(/.test(stripped)) {
        warn(
          'pretooluse:console-log',
          `${basename}: console.log in PreToolUse injects into model context — use process.stderr.write (PROB-006)`
        );
      }
    }

    // Check D — raw process.stdin (no timeout, can hang)
    if (!seen.has(`D:${filePath}`)) {
      seen.add(`D:${filePath}`);
      if (/process\.stdin\.on\s*\(/.test(stripped)) {
        warn('raw-stdin', `${basename}: use readStdinJson() from hook-utils instead of raw process.stdin (PROB-007)`);
      }
    }

    // Check E — PostToolUse(Bash) hook reading file_path (ghost registration)
    if (event === 'PostToolUse' && matcher && matcher.includes('Bash') && !seen.has(`E:${filePath}`)) {
      seen.add(`E:${filePath}`);
      if (/tool_input\.file_path/.test(stripped)) {
        warn(
          'bash:file_path-ghost',
          `${basename}: Bash events have no file_path — hook silently no-ops on every Bash call (PROB-008)`
        );
      }
    }
  }

  process.stdout.write(`\nScanned ${scanned} hook file(s) across ${allHooks.length} registration(s).\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  process.stdout.write('hook-recovery diagnose\n');
  process.stdout.write('==================================\n\n');

  const settingsPath = findSettingsFile(settingsPathOverride);
  const displayPath = settingsPath
    ? path.relative(process.cwd(), settingsPath) || settingsPath
    : (settingsPathOverride ?? '.claude/settings.json or ~/.claude/settings.json');

  process.stdout.write(`Checking: ${displayPath} ... `);

  if (!settingsPath) {
    process.stdout.write('NOT FOUND\n\n');
    fail(
      'settings.json',
      'not found. Create .claude/settings.json in your project root (or pass --settings <path>).',
      JSON.stringify({ hooks: { PreToolUse: [], PostToolUse: [], UserPromptSubmit: [] } }, null, 2)
    );
    printSummary();
    return;
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    process.stdout.write('found\n\n');
  } catch (e) {
    process.stdout.write('parse error\n\n');
    fail('settings.json', `could not parse: ${e.message}`);
    printSummary();
    return;
  }

  if (!scanOnly) {
    process.stdout.write('Section I: Registration checks\n');
    process.stdout.write('==================================\n\n');
    await runRegistrationChecks(settings, settingsPath);
  }

  if (runScan) {
    runCodePatternChecks(settings, settingsPath);
  }

  printSummary();

  if (showFix && fixSnippets.length > 0) {
    process.stdout.write('\n## Suggested settings.json snippets\n');
    process.stdout.write('(copy-paste the relevant entries into your .claude/settings.json)\n\n');
    for (const s of fixSnippets) {
      process.stdout.write(`### ${s.label}\n`);
      process.stdout.write(s.json + '\n\n');
    }
  } else if (fixSnippets.length > 0 && !showFix) {
    process.stdout.write('Run with --fix to see suggested settings.json snippets for any failed checks.\n');
  }
}

function printSummary() {
  process.stdout.write('\n');
  process.stdout.write(`Summary: ${warnCount} warning${warnCount !== 1 ? 's' : ''}, ${failCount} error${failCount !== 1 ? 's' : ''}\n`);
  if (failCount > 0) process.exit(2);
  if (warnCount > 0) process.exit(1);
  process.exit(0);
}

main().catch(e => {
  process.stderr.write(`diagnose error: ${e.message}\n`);
  process.exit(2);
});
