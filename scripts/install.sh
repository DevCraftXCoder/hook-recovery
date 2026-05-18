#!/usr/bin/env sh
# install.sh — copies the 3 recovery hooks into .claude/hooks/
#
# Usage:
#   sh scripts/install.sh
#   CLAUDE_HOOKS_DIR=/path/to/.claude/hooks sh scripts/install.sh
#
# Respects CLAUDE_HOOKS_DIR env var; defaults to .claude/hooks relative to cwd.

set -e

HOOKS_DIR="${CLAUDE_HOOKS_DIR:-.claude/hooks}"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$SCRIPT_DIR/hooks"

HOOKS="token-guard.cjs write-confirm.cjs hookify-prompt.cjs"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }

confirm_overwrite() {
  # $1 = file path to display
  printf 'Overwrite %s? [y/N] ' "$1"
  read -r answer || answer='n'
  case "$answer" in
    [yY]*) return 0 ;;
    *)     return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Create target directory if needed
# ---------------------------------------------------------------------------

if [ ! -d "$HOOKS_DIR" ]; then
  say "Creating $HOOKS_DIR ..."
  mkdir -p "$HOOKS_DIR"
fi

# ---------------------------------------------------------------------------
# Copy hooks
# ---------------------------------------------------------------------------

copied=0
skipped=0

for hook in $HOOKS; do
  src="$SRC_DIR/$hook"
  dst="$HOOKS_DIR/$hook"

  if [ ! -f "$src" ]; then
    say "WARNING: source not found: $src — skipping"
    skipped=$((skipped + 1))
    continue
  fi

  if [ -f "$dst" ]; then
    if confirm_overwrite "hooks/$hook"; then
      cp "$src" "$dst"
      say "  Copied  $hook"
      copied=$((copied + 1))
    else
      say "  Skipped $hook"
      skipped=$((skipped + 1))
    fi
  else
    cp "$src" "$dst"
    say "  Copied  $hook"
    copied=$((copied + 1))
  fi
done

# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------

say ""
say "Hooks copied to $HOOKS_DIR/"
say ""
say "Next: add to .claude/settings.json:"
say "(run: node diagnose.cjs --fix  for exact JSON snippets)"
say ""

# ---------------------------------------------------------------------------
# Run diagnose if node is available
# ---------------------------------------------------------------------------

if command -v node >/dev/null 2>&1; then
  diagnose_script="$SCRIPT_DIR/diagnose.cjs"
  if [ -f "$diagnose_script" ]; then
    say "Running diagnose ..."
    say ""
    node "$diagnose_script" || true
  fi
else
  say "node not found — skipping diagnose. Install Node.js >= 18 and run:"
  say "  node diagnose.cjs"
fi
