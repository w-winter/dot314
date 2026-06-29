#!/usr/bin/env bash
# Tracks RepoPrompt CLI tool/help changes:
#   - across versions of the SAME CLI (older rpce-cli -> newer rpce-cli)
#   - across apps (Classic rp-cli vs CE rpce-cli) via --compare-apps
#
# RepoPrompt CE (rpce-cli) is the maintained target and the default.
# RepoPrompt Classic (rp-cli) is frozen; select it with --classic (or
# RP_CLI_BIN=rp-cli) only to (re)capture the baseline used for cross-app diffs.
#
# Usage: ./track-rp-version.sh [--ce|--classic] [--pre|--post|--check|--force|--compare-apps|--version]

set -euo pipefail

# Script lives in scripts/, outputs go to rp-tool-defs/
SCRIPT_DIR="$(dirname "$0")"
OUTPUT_DIR="${SCRIPT_DIR}/../rp-tool-defs"
mkdir -p "$OUTPUT_DIR"

# Target CLI selection (CE is canonical; Classic is frozen).
CLI_BIN="${RP_CLI_BIN:-rpce-cli}"
MODE=""

for arg in "$@"; do
    case "$arg" in
        --ce)      CLI_BIN="rpce-cli" ;;
        --classic) CLI_BIN="rp-cli" ;;
        --pre|-p|--post|-o|--check|-c|--force|-f|--compare-apps|-x|--version|-v|--help|-h)
            if [ -n "$MODE" ]; then
                echo "ERROR: multiple modes given ($MODE and $arg)" >&2
                exit 1
            fi
            MODE="$arg"
            ;;
        *)
            echo "ERROR: unknown argument '$arg'" >&2
            echo "Run '$0 --help' for usage." >&2
            exit 1
            ;;
    esac
done
MODE="${MODE:---check}"

# Filename prefix + baseline file are namespaced per CLI so Classic and CE
# snapshots never collide.
case "$CLI_BIN" in
    rpce-cli) PREFIX="rpcecli" ;;
    rp-cli)   PREFIX="rpcli" ;;
    *)        PREFIX="$(basename "$CLI_BIN" | tr -cd 'A-Za-z0-9')" ;;
esac
BASELINE_FILE="${OUTPUT_DIR}/.baseline_version__${PREFIX}"

SELECT_FLAG=""
if [ "$CLI_BIN" = "rp-cli" ]; then
    SELECT_FLAG="--classic "
fi

# Parse version from "<cli> (repoprompt-mcp) X.Y.Z"
get_version() {
    "$CLI_BIN" -v 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

require_version() {
    local v
    v="$(get_version || true)"
    if [ -z "$v" ]; then
        echo "ERROR: could not detect ${CLI_BIN} version. Is ${CLI_BIN} installed and on PATH?" >&2
        exit 1
    fi
    printf '%s' "$v"
}

snapshot() {
    local v="$1"
    echo "Capturing ${CLI_BIN} snapshot for v${v}..."
    "$CLI_BIN" --help > "${OUTPUT_DIR}/${PREFIX}-help__${v}.txt"
    "$CLI_BIN" -l > "${OUTPUT_DIR}/${PREFIX}-l__${v}.txt"
    echo "$v" > "$BASELINE_FILE"
}

diff_versions() {
    local old="$1" new="$2"

    # diff returns 1 when files differ, so || true
    diff "${OUTPUT_DIR}/${PREFIX}-help__${old}.txt" "${OUTPUT_DIR}/${PREFIX}-help__${new}.txt" \
        > "${OUTPUT_DIR}/${PREFIX}-help__${new}.diff" 2>/dev/null || true
    diff "${OUTPUT_DIR}/${PREFIX}-l__${old}.txt" "${OUTPUT_DIR}/${PREFIX}-l__${new}.txt" \
        > "${OUTPUT_DIR}/${PREFIX}-l__${new}.diff" 2>/dev/null || true

    echo ""
    echo "Generated diffs (in rp-tool-defs/):"
    echo "  ${PREFIX}-help__${new}.diff"
    echo "  ${PREFIX}-l__${new}.diff"
    echo ""

    if [ -s "${OUTPUT_DIR}/${PREFIX}-l__${new}.diff" ]; then
        echo "⚠️  Tool definitions changed. Review rp-tool-defs/${PREFIX}-l__${new}.diff"
    else
        echo "✓ No tool definition changes detected"
    fi

    if [ -s "${OUTPUT_DIR}/${PREFIX}-help__${new}.diff" ]; then
        echo "⚠️  CLI help changed. Review rp-tool-defs/${PREFIX}-help__${new}.diff"
    else
        echo "✓ No CLI help changes detected"
    fi
}

# Latest captured version for a given prefix (numeric X.Y.Z sort; BSD/GNU-safe)
latest_snapshot_version() {
    local prefix="$1" f v
    local versions=()
    for f in "${OUTPUT_DIR}/${prefix}-help__"*.txt; do
        [ -e "$f" ] || continue
        v="${f##*/${prefix}-help__}"
        v="${v%.txt}"
        versions+=("$v")
    done
    [ ${#versions[@]} -eq 0 ] && return 0
    printf '%s\n' "${versions[@]}" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1
}

compare_apps() {
    local classic_v ce_v
    classic_v="$(latest_snapshot_version rpcli)"
    ce_v="$(latest_snapshot_version rpcecli)"

    if [ -z "$classic_v" ]; then
        echo "ERROR: no Classic (rpcli) snapshot found in rp-tool-defs/." >&2
        echo "Capture one with: $0 --classic --force" >&2
        exit 1
    fi
    if [ -z "$ce_v" ]; then
        echo "ERROR: no CE (rpcecli) snapshot found in rp-tool-defs/." >&2
        echo "Capture one with: $0 --ce --force" >&2
        exit 1
    fi

    local help_out="${OUTPUT_DIR}/xapp-help__rpcli-${classic_v}__rpcecli-${ce_v}.diff"
    local list_out="${OUTPUT_DIR}/xapp-l__rpcli-${classic_v}__rpcecli-${ce_v}.diff"

    {
        echo "# Cross-app --help diff"
        echo "# < Classic rp-cli v${classic_v}"
        echo "# > CE rpce-cli v${ce_v}"
        echo ""
        diff "${OUTPUT_DIR}/rpcli-help__${classic_v}.txt" "${OUTPUT_DIR}/rpcecli-help__${ce_v}.txt" || true
    } > "$help_out"

    {
        echo "# Cross-app tool-definition (-l) diff"
        echo "# < Classic rp-cli v${classic_v}"
        echo "# > CE rpce-cli v${ce_v}"
        echo ""
        diff "${OUTPUT_DIR}/rpcli-l__${classic_v}.txt" "${OUTPUT_DIR}/rpcecli-l__${ce_v}.txt" || true
    } > "$list_out"

    echo "Compared Classic rp-cli v${classic_v}  →  CE rpce-cli v${ce_v}"
    echo ""
    echo "Generated cross-app diffs (in rp-tool-defs/):"
    echo "  $(basename "$help_out")"
    echo "  $(basename "$list_out")"
    echo ""
    echo "These are large by design (different apps). Use them to spot CE tools,"
    echo "flags, or parameters that diverge from Classic when updating guidance."
}

show_status() {
    echo "Target CLI: ${CLI_BIN} (prefix: ${PREFIX})"
    echo "Current version: ${CURRENT_VERSION:-<unknown>}"
    if [ -f "$BASELINE_FILE" ]; then
        echo "Baseline version: $(cat "$BASELINE_FILE")"
    else
        echo "Baseline version: (none)"
    fi
}

# Modes that do not need a live CLI.
case "$MODE" in
    --compare-apps|-x)
        compare_apps
        exit 0
        ;;

    --help|-h)
        echo "Usage: $0 [--ce|--classic] [--pre|--post|--check|--force|--compare-apps|--version]"
        echo ""
        echo "Target selection (default: --ce, the maintained RepoPrompt CE CLI):"
        echo "  --ce          Track CE (rpce-cli)"
        echo "  --classic     Track Classic (rp-cli, frozen)"
        echo "                env override: RP_CLI_BIN=<binary>"
        echo ""
        echo "Modes:"
        echo "  --pre, -p           Capture baseline before upgrading the selected app"
        echo "  --post, -o          Capture new version after upgrade, generate diffs"
        echo "  --check, -c         Show current vs baseline version (default)"
        echo "  --force, -f         Force re-capture current version (no diff)"
        echo "  --compare-apps, -x  Diff latest Classic vs latest CE snapshots"
        echo "  --version, -v       Print current selected-CLI version"
        echo ""
        echo "Same-CLI version workflow (CE):"
        echo "  1. $0 --pre     # Before upgrading RepoPrompt CE"
        echo "  2. (Update RepoPrompt CE)"
        echo "  3. $0 --post    # After upgrading"
        echo ""
        echo "Cross-app workflow (one-shot):"
        echo "  $0 --ce --force        # snapshot current CE CLI"
        echo "  $0 --classic --force   # (optional) refresh frozen Classic snapshot"
        echo "  $0 --compare-apps      # diff Classic vs CE"
        exit 0
        ;;
esac

# Remaining modes require a live CLI version.
CURRENT_VERSION="$(require_version)"

case "$MODE" in
    --check|-c)
        show_status
        echo ""
        if [ ! -f "$BASELINE_FILE" ]; then
            echo "No baseline captured for ${CLI_BIN}. Run with --pre before upgrading."
            exit 1
        fi
        baseline="$(cat "$BASELINE_FILE")"
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
            baseline="$(cat "$BASELINE_FILE")"
            if [ "$baseline" = "$CURRENT_VERSION" ]; then
                echo "✓ Baseline already captured at v${CURRENT_VERSION}"
                echo ""
                echo "Ready to upgrade. After updating RepoPrompt, run:"
                echo "  $0 ${SELECT_FLAG}--post"
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
        echo "  $0 ${SELECT_FLAG}--post"
        ;;

    --post|-o)
        show_status
        echo ""
        if [ ! -f "$BASELINE_FILE" ]; then
            echo "ERROR: No baseline found for ${CLI_BIN}. Run --pre before upgrading." >&2
            exit 1
        fi
        baseline="$(cat "$BASELINE_FILE")"
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
        echo "  ${PREFIX}-l__${CURRENT_VERSION}.diff   (tool definitions)"
        echo "  ${PREFIX}-help__${CURRENT_VERSION}.diff (CLI help)"
        ;;

    --force|-f)
        echo "Force-capturing ${CLI_BIN} snapshot for v${CURRENT_VERSION}..."
        snapshot "$CURRENT_VERSION"
        echo "✓ Snapshot captured (no diff generated)"
        ;;

    --version|-v)
        echo "$CURRENT_VERSION"
        ;;

    *)
        echo "ERROR: unhandled mode '$MODE'" >&2
        exit 1
        ;;
esac