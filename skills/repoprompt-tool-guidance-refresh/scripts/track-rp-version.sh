#!/usr/bin/env bash
# Tracks rp-cli changes across versions
# Usage: ./track-rp-version.sh [--pre | --post | --check | --force]

set -euo pipefail

# Script lives in scripts/, outputs go to rp-tool-defs/
SCRIPT_DIR="$(dirname "$0")"
OUTPUT_DIR="${SCRIPT_DIR}/../rp-tool-defs"
mkdir -p "$OUTPUT_DIR"

# Parse version from `rp-cli -v` output like "rp-cli (repoprompt-mcp) 1.6.0"
get_version() {
    rp-cli -v 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

CURRENT_VERSION=$(get_version)
BASELINE_FILE="${OUTPUT_DIR}/.baseline_version"

if [ -z "$CURRENT_VERSION" ]; then
    echo "ERROR: Could not detect rp-cli version. Is rp-cli installed?" >&2
    exit 1
fi

snapshot() {
    local v="$1"
    echo "Capturing snapshot for v${v}..."
    rp-cli --help > "${OUTPUT_DIR}/rpcli-help__${v}.txt"
    rp-cli -l > "${OUTPUT_DIR}/rpcli-l__${v}.txt"
    echo "$v" > "$BASELINE_FILE"
}

diff_versions() {
    local old="$1" new="$2"

    # Generate diffs (diff returns 1 if files differ, so || true)
    diff "${OUTPUT_DIR}/rpcli-help__${old}.txt" "${OUTPUT_DIR}/rpcli-help__${new}.txt" > "${OUTPUT_DIR}/rpcli-help__${new}.diff" 2>/dev/null || true
    diff "${OUTPUT_DIR}/rpcli-l__${old}.txt" "${OUTPUT_DIR}/rpcli-l__${new}.txt" > "${OUTPUT_DIR}/rpcli-l__${new}.diff" 2>/dev/null || true

    echo ""
    echo "Generated diffs (in rp-tool-defs/):"
    echo "  rpcli-help__${new}.diff"
    echo "  rpcli-l__${new}.diff"
    echo ""

    if [ -s "${OUTPUT_DIR}/rpcli-l__${new}.diff" ]; then
        echo "⚠️  Tool definitions changed. Review rp-tool-defs/rpcli-l__${new}.diff"
    else
        echo "✓ No tool definition changes detected"
    fi

    if [ -s "${OUTPUT_DIR}/rpcli-help__${new}.diff" ]; then
        echo "⚠️  CLI help changed. Review rp-tool-defs/rpcli-help__${new}.diff"
    else
        echo "✓ No CLI help changes detected"
    fi
}

show_status() {
    echo "Current version: $CURRENT_VERSION"
    if [ -f "$BASELINE_FILE" ]; then
        echo "Baseline version: $(cat "$BASELINE_FILE")"
    else
        echo "Baseline version: (none)"
    fi
}

case "${1:---check}" in
    --check|-c)
        show_status
        echo ""
        if [ ! -f "$BASELINE_FILE" ]; then
            echo "No baseline captured. Run with --pre before upgrading."
            exit 1
        fi

        baseline=$(cat "$BASELINE_FILE")
        if [ "$baseline" = "$CURRENT_VERSION" ]; then
            echo "✓ Version unchanged"
        else
            echo "⚠️  Version changed: $baseline → $CURRENT_VERSION"
            echo "Run with --post to capture new version and generate diffs."
        fi
        ;;

    --pre|-p)
        show_status
        echo ""
        if [ -f "$BASELINE_FILE" ]; then
            baseline=$(cat "$BASELINE_FILE")
            if [ "$baseline" = "$CURRENT_VERSION" ]; then
                echo "✓ Baseline already captured at v${CURRENT_VERSION}"
                echo ""
                echo "Ready to upgrade. After updating RepoPrompt, run:"
                echo "  ./track-rp-version.sh --post"
                exit 0
            else
                echo "Baseline was at v${baseline}, now at v${CURRENT_VERSION}"
                echo "Re-capturing baseline..."
            fi
        fi
        snapshot "$CURRENT_VERSION"
        echo ""
        echo "✓ Baseline captured at v${CURRENT_VERSION}"
        echo ""
        echo "Ready to upgrade. After updating RepoPrompt, run:"
        echo "  ./track-rp-version.sh --post"
        ;;

    --post|-o)
        show_status
        echo ""
        if [ ! -f "$BASELINE_FILE" ]; then
            echo "ERROR: No baseline found. Run --pre before upgrading." >&2
            exit 1
        fi

        baseline=$(cat "$BASELINE_FILE")
        if [ "$baseline" = "$CURRENT_VERSION" ]; then
            echo "Version unchanged ($CURRENT_VERSION). Did you upgrade RepoPrompt?"
            exit 1
        fi

        echo "Upgrade detected: $baseline → $CURRENT_VERSION"
        echo ""
        snapshot "$CURRENT_VERSION"
        diff_versions "$baseline" "$CURRENT_VERSION"
        echo ""
        echo "✓ Post-upgrade capture complete"
        echo ""
        echo "Files to review (in rp-tool-defs/):"
        echo "  rpcli-l__${CURRENT_VERSION}.diff   (tool definitions)"
        echo "  rpcli-help__${CURRENT_VERSION}.diff (CLI help)"
        ;;

    --force|-f)
        echo "Force-capturing snapshot for v${CURRENT_VERSION}..."
        snapshot "$CURRENT_VERSION"
        echo "✓ Snapshot captured (no diff generated)"
        ;;

    --version|-v)
        echo "$CURRENT_VERSION"
        ;;

    --help|-h|*)
        echo "Usage: $0 [--pre | --post | --check | --force | --version]"
        echo ""
        echo "Commands:"
        echo "  --pre, -p     Capture baseline before upgrading RepoPrompt"
        echo "  --post, -o    Capture new version after upgrade, generate diffs"
        echo "  --check, -c   Show current vs baseline version (default)"
        echo "  --force, -f   Force re-capture current version (no diff)"
        echo "  --version, -v Print current rp-cli version"
        echo ""
        echo "Workflow:"
        echo "  1. ./track-rp-version.sh --pre    # Before upgrading"
        echo "  2. (Update RepoPrompt)"
        echo "  3. ./track-rp-version.sh --post   # After upgrading"
        ;;
esac