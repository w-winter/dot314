#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

exec npx tsx "xcodebuildmcp.ts" "$@"
