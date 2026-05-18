// write-confirm.cjs
// PostToolUse — confirms Write/Edit landed; surfaces silent tool failures
//
// Register on: PostToolUse — matcher: Write|Edit
// IMPORTANT: Register this FIRST among PostToolUse Write|Edit hooks.
// If a sync or deploy hook runs first and crashes, the confirmation signal never fires.
//
// What it does:
//   - Emits [write-confirm] OK after every successful Write or Edit
//   - Emits [write-confirm] FAILED when the tool response signals an error
//     (is_error: true, or error keywords in response text)
//   - Silent for all other tool types
//
// Why: Claude Code's Write/Edit tools can fail silently. Without this hook,
// Claude may assume a write succeeded and proceed on stale context, causing
// loops where it re-reads the same file and re-attempts the same write.

'use strict';

const path = require('path');

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

// --- error detection ---

function isError(response) {
  if (!response) return false;
  if (response.is_error === true) return true;
  const text = typeof response === 'string' ? response
    : typeof response.content === 'string' ? response.content
    : Array.isArray(response.content) ? response.content.map(c => c.text ?? '').join(' ')
    : JSON.stringify(response);
  return /\b(internal error|timed out|failed|error)\b/i.test(text);
}

// --- main ---

async function main() {
  let payload;
  try { payload = await readStdinJson(); } catch { process.exit(0); }

  const { tool_name, tool_input, tool_response } = parseToolInput(payload);

  if (tool_name !== 'Write' && tool_name !== 'Edit') { process.exit(0); }

  const filename = path.basename(tool_input.file_path ?? tool_input.path ?? '');
  if (!filename) { process.exit(0); }

  if (isError(tool_response)) {
    process.stderr.write(`[write-confirm] FAILED ${tool_name} ${filename} — tool returned error. Re-read may be needed.\n`);
  } else {
    process.stderr.write(`[write-confirm] OK ${tool_name} ${filename}\n`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
