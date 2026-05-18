// token-guard.cjs
// PreToolUse guard for Read|Grep|Glob|Agent — catches wasteful token patterns
//
// Register on: PreToolUse — matcher: Read|Agent|Grep|Glob
//
// What it does:
//   - Advisory (exit 0) for duplicate file reads and duplicate Grep/Glob searches
//   - Advisory (exit 0) for Agent calls missing subagent_type or with oversized prompts
//   - Hard block (exit 2) ONLY for large files (>500 lines) without offset/limit — prevents
//     accidental full-dump of large files that waste context budget
//   - willBlock flag prevents false-positive re-read advisory when retrying with limit:
//     after a blocked attempt
//
// State file: JSON at TOKEN_GUARD_STATE_FILE env var path (default: OS temp dir)
// State resets on /compact via hookify-prompt.cjs

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = process.env.TOKEN_GUARD_STATE_FILE
  || path.join(os.tmpdir(), 'token-guard-state.json');
const LARGE_FILE_SIZE_THRESHOLD = 25000; // ~500 lines heuristic (~50 bytes/line)
const MAX_AGENT_PROMPT_WORDS = 300;
const MAX_STATE_ENTRIES = 500;

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

function parseToolInput(payload) {
  return {
    tool_name: payload.tool_name ?? '',
    tool_input: payload.tool_input ?? {},
    tool_response: payload.tool_response,
  };
}

// --- state helpers ---

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* missing or corrupt — start fresh */ }
  return { reads: {}, searches: {} };
}

function saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch { /* best effort */ }
  }
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function capEntries(obj) {
  const keys = Object.keys(obj);
  if (keys.length > MAX_STATE_ENTRIES) {
    const toRemove = keys.slice(0, Math.floor(keys.length / 2));
    for (const k of toRemove) delete obj[k];
  }
}

// --- main ---

async function main() {
  let payload;
  try { payload = await readStdinJson(); } catch { process.exit(0); }

  const { tool_name, tool_input } = parseToolInput(payload);
  const warnings = [];

  // Agent fast path — skip state I/O, advisory only
  if (tool_name === 'Agent') {
    const prompt = tool_input.prompt ?? '';
    const subagentType = tool_input.subagent_type ?? '';
    const wordCount = countWords(prompt);
    const advisories = [];
    if (!subagentType) {
      advisories.push(`[token-guard] Advisory: Agent spawned without subagent_type — specify an agent type to avoid wasting context.`);
    }
    if (wordCount > MAX_AGENT_PROMPT_WORDS) {
      advisories.push(`[token-guard] Advisory: Agent prompt is ${wordCount} words (guideline: ${MAX_AGENT_PROMPT_WORDS}). Trim to essential context only.`);
    }
    if (advisories.length > 0) process.stderr.write(advisories.join('\n') + '\n');
    process.exit(0);
  }

  const state = loadState();
  if (!state.reads || typeof state.reads !== 'object') state.reads = {};
  if (!state.searches || typeof state.searches !== 'object') state.searches = {};

  if (tool_name === 'Read') {
    const filePath = tool_input.file_path ?? '';
    const hasOffset = tool_input.offset != null;
    const hasLimit = tool_input.limit != null;
    const hasPages = tool_input.pages != null;
    const isBoundedRead = hasOffset || hasLimit || hasPages;

    // Advisory for duplicate reads — exit 0, never blocks recovery paths
    if (filePath && state.reads[filePath]) {
      process.stderr.write(
        `[token-guard] Advisory: Re-reading "${path.basename(filePath)}" — already read this session ` +
        `(${Math.round((Date.now() - state.reads[filePath]) / 1000)}s ago). Use context if available.\n`
      );
    }

    // Hard block for large files without bounds — the one case where blocking is justified
    if (filePath && !isBoundedRead) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > LARGE_FILE_SIZE_THRESHOLD) {
          const estLines = Math.round(stat.size / 50);
          warnings.push(
            `[token-guard] "${path.basename(filePath)}" is ~${estLines} lines ` +
            `(${Math.round(stat.size / 1024)}KB) — use offset/limit to read only what you need.`
          );
        }
      } catch { /* can't stat — skip check */ }
    }

    // Track the read only if it won't be blocked and is unbounded
    const willBlock = warnings.length > 0;
    if (filePath && !state.reads[filePath] && !willBlock && !isBoundedRead) {
      state.reads[filePath] = Date.now();
      capEntries(state.reads);
      saveState(state);
    }
  }

  if (tool_name === 'Grep' || tool_name === 'Glob') {
    const pattern = tool_input.pattern ?? '';
    const searchPath = tool_input.path ?? '';
    const searchKey = `${tool_name}:${pattern}:${searchPath}`;

    if (pattern && state.searches[searchKey]) {
      process.stderr.write(
        `[token-guard] Advisory: Duplicate ${tool_name} "${pattern}" — same pattern+path already searched this session.\n`
      );
    }

    if (pattern && !state.searches[searchKey]) {
      state.searches[searchKey] = Date.now();
      capEntries(state.searches);
      saveState(state);
    }
  }

  if (warnings.length > 0) {
    process.stderr.write(warnings.join('\n') + '\n');
    process.exit(2);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
