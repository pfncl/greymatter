#!/bin/bash
# Staged dependency bootstrap — never let a failed npm install destroy a
# working node_modules tree (a partial npm reify guts packages: dir stays,
# package.json inside vanishes, and every hook + the MCP server dies on
# "Cannot find module"). Install into .staging, verify the critical modules
# actually load, then swap. On any failure the current tree stays intact and
# the version marker stays stale, so the next session retries.
#
# Args: $1 = CLAUDE_PLUGIN_ROOT, $2 = CLAUDE_PLUGIN_DATA
set -u
ROOT="${1:?usage: bootstrap-deps.sh <plugin-root> <plugin-data>}"
DATA="${2:?usage: bootstrap-deps.sh <plugin-root> <plugin-data>}"

mkdir -p "$DATA"
diff -q "$ROOT/package.json" "$DATA/package.json" >/dev/null 2>&1 && exit 0

STAGE="$DATA/.staging"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$ROOT/package.json" "$STAGE/" || exit 0

if ! (cd "$STAGE" && npm install --omit=dev --no-audit --no-fund); then
  echo "greymatter bootstrap: npm install failed — keeping existing node_modules" >&2
  rm -rf "$STAGE"
  exit 0
fi

# Load check mirrors what hooks + mcp-server actually require.
if ! NODE_PATH="$STAGE/node_modules" node -e "require('better-sqlite3'); require('@modelcontextprotocol/sdk/server')"; then
  echo "greymatter bootstrap: installed tree failed load check — keeping existing node_modules" >&2
  rm -rf "$STAGE"
  exit 0
fi

rm -rf "$DATA/node_modules.old"
[ -d "$DATA/node_modules" ] && mv "$DATA/node_modules" "$DATA/node_modules.old"
mv "$STAGE/node_modules" "$DATA/node_modules"
cp "$STAGE/package.json" "$DATA/package.json"
rm -rf "$DATA/node_modules.old" "$STAGE"
exit 0
