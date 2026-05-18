// diagnose.cjs
// Checks whether the 3 recovery hooks are correctly wired in settings.json
//
// Usage:
//   node diagnose.cjs
//   node diagnose.cjs --settings /path/to/.claude/settings.json
//   node diagnose.cjs --fix

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const showFix = args.includes('--fix');

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
  process.stdout.write(`[PASS] ${label.padEnd(22)} ${note}\n`);
}

function warn(label, note, snippet) {
  warnCount++;
  process.stdout.write(`[WARN] ${label.padEnd(22)} ${note}\n`);
  if (snippet) fixSnippets.push({ label, json: snippet });
}

function fail(label, note, snippet) {
  failCount++;
  process.stdout.write(`[FAIL] ${label.padEnd(22)} ${note}\n`);
  if (snippet) fixSnippets.push({ label, json: snippet });
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
 * settings.hooks may be an object keyed by event name.
 * Each entry is either a string command or an object with { command, matcher }.
 * Returns an array of { command: string, matcher: string|undefined }.
 */
function getHookEntries(settings, event) {
  const hooks = settings.hooks;
  if (!hooks || !hooks[event]) return [];
  const raw = hooks[event];
  if (!Array.isArray(raw)) return [];
  return raw.map(entry => {
    if (typeof entry === 'string') return { command: entry, matcher: undefined };
    if (typeof entry === 'object' && entry !== null) {
      return {
        command: entry.command ?? '',
        matcher: entry.matcher,
        env: entry.env,
      };
    }
    return { command: '', matcher: undefined };
  });
}

/**
 * Check if any entry in a list matches a filename and optional matcher pattern.
 * matcher is a pipe-separated list like "Read|Agent|Grep|Glob".
 */
function findHookEntry(entries, filename, requiredMatcher) {
  return entries.filter(e => e.command.includes(filename)).filter(e => {
    if (!requiredMatcher) return true;
    if (!e.matcher) return false;
    // Both sides are pipe-separated — check that all required tools appear
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
// Main diagnostic
// ---------------------------------------------------------------------------

async function main() {
  process.stdout.write('claude-code-hook-recovery diagnose\n');
  process.stdout.write('==================================\n\n');

  // --- 1. Find settings file ---
  const settingsPath = findSettingsFile(settingsPathOverride);
  const displayPath = settingsPath
    ? path.relative(process.cwd(), settingsPath) || settingsPath
    : (settingsPathOverride ?? '.claude/settings.json or ~/.claude/settings.json');

  process.stdout.write(`Checking: ${displayPath} ... `);

  if (!settingsPath) {
    process.stdout.write('NOT FOUND\n\n');
    fail(
      'settings.json',
      `not found. Create .claude/settings.json in your project root (or pass --settings <path>).`,
      JSON.stringify({
        hooks: {
          PreToolUse: [],
          PostToolUse: [],
          UserPromptSubmit: [],
        },
      }, null, 2)
    );
    printSummary();
    return;
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    process.stdout.write('found\n\n');
  } catch (e) {
    process.stdout.write(`parse error\n\n`);
    fail('settings.json', `could not parse: ${e.message}`);
    printSummary();
    return;
  }

  // --- 2. token-guard.cjs on PreToolUse ---
  {
    const entries = getHookEntries(settings, 'PreToolUse');
    const matches = findHookEntry(entries, 'token-guard.cjs', 'Read|Agent|Grep|Glob');

    if (matches.length === 0) {
      // Check if it's registered but with wrong matcher
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

  // --- 3. write-confirm.cjs on PostToolUse, must be first ---
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
      // Check if it's first among Write|Edit entries
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

  // --- 4. hookify-prompt.cjs on UserPromptSubmit ---
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

  // --- 5. TOKEN_GUARD_STATE_FILE consistency ---
  {
    const preEntries = getHookEntries(settings, 'PreToolUse');
    const upEntries = getHookEntries(settings, 'UserPromptSubmit');

    const guardEntry = findHookEntry(preEntries, 'token-guard.cjs', null)[0];
    const hookifyEntry = findHookEntry(upEntries, 'hookify-prompt.cjs', null)[0];

    if (guardEntry && hookifyEntry) {
      const guardVal = getEnvVar(guardEntry, 'TOKEN_GUARD_STATE_FILE');
      const hookifyVal = getEnvVar(hookifyEntry, 'TOKEN_GUARD_STATE_FILE');

      if (guardVal !== undefined || hookifyVal !== undefined) {
        // At least one has it set — check they match
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
        // Neither sets it — both will use the OS temp default, which is fine
        pass('STATE_FILE env', 'not set in either hook — both will use OS temp default (consistent)');
      }
    } else {
      // Can't check — one or both hooks missing, already reported above
      pass('STATE_FILE env', 'skipped — requires both token-guard and hookify-prompt to be registered');
    }
  }

  // --- 6. Node.js version ---
  {
    const [, major] = process.version.match(/^v(\d+)/) || [];
    if (parseInt(major, 10) >= 18) {
      pass('Node.js', `${process.version} >= 18`);
    } else {
      warn('Node.js', `${process.version} — hooks require Node.js >= 18`);
    }
  }

  // --- Summary + fix snippets ---
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
