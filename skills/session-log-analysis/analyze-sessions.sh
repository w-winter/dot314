#!/bin/bash
#
# analyze-sessions.sh — Analyze pi agent session logs for patterns and issues
#
# Usage:
#   ./analyze-sessions.sh --hours 24 --pattern "rp_exec"
#   ./analyze-sessions.sh --hours 36 --edit-struggles
#   ./analyze-sessions.sh --hours 48 --errors
#   ./analyze-sessions.sh --hours 24 --report
#   ./analyze-sessions.sh --hours 24 --tool-stats
#

set -e

SESSIONS_DIR="${SESSIONS_DIR:-$HOME/dot314/agent/sessions}"
HOURS=24
PATTERN=""
MODE="search"

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --hours N           Look back N hours (default: 24)
  --pattern REGEX     Search for sessions containing pattern
  --edit-struggles    Find sessions with edit failures/retries
  --errors            Find sessions with high error counts
  --tool-stats        Show tool usage statistics
  --report            Full analysis report
  --list              Just list matching session files
  --help              Show this help

Environment:
  SESSIONS_DIR        Override sessions directory (default: ~/agent/sessions)

Examples:
  $(basename "$0") --hours 36 --edit-struggles
  $(basename "$0") --hours 24 --pattern "apply_edits"
  $(basename "$0") --hours 48 --report
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --hours)
            HOURS="$2"
            shift 2
            ;;
        --pattern)
            PATTERN="$2"
            MODE="pattern"
            shift 2
            ;;
        --edit-struggles)
            MODE="edit-struggles"
            shift
            ;;
        --errors)
            MODE="errors"
            shift
            ;;
        --tool-stats)
            MODE="tool-stats"
            shift
            ;;
        --report)
            MODE="report"
            shift
            ;;
        --list)
            MODE="list"
            shift
            ;;
        --help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage
            exit 1
            ;;
    esac
done

MINUTES=$((HOURS * 60))

# Find session files within time window
find_sessions() {
    find "$SESSIONS_DIR" -type f -name "*.jsonl" -mmin -"$MINUTES" 2>/dev/null
}

# Count pattern occurrences in a file
# Note: grep -c outputs 0 for no matches but exits with code 1, so we capture output and ignore exit code
count_pattern() {
    local file="$1"
    local pattern="$2"
    local count
    count=$(grep -c -E "$pattern" "$file" 2>/dev/null) || true
    echo "${count:-0}"
}

# Main modes

mode_list() {
    echo "=== Sessions from last $HOURS hours ==="
    find_sessions | while read -r f; do
        local size=$(wc -c < "$f" | tr -d ' ')
        local lines=$(wc -l < "$f" | tr -d ' ')
        echo "$f (${lines} entries, ${size} bytes)"
    done | sort
}

mode_pattern() {
    echo "=== Sessions containing: $PATTERN ==="
    find_sessions | while read -r f; do
        if grep -q -E "$PATTERN" "$f" 2>/dev/null; then
            local count=$(count_pattern "$f" "$PATTERN")
            echo "$f ($count matches)"
        fi
    done | sort -t'(' -k2 -rn
}

mode_edit_struggles() {
    echo "=== Edit Struggles (last $HOURS hours) ==="
    echo ""
    
    local edit_patterns="apply_edits|\"name\":\"Edit\"|\"name\":\"rp_exec\".*edit"
    local error_patterns="search block not found|0 edits applied|no changes|oldText.*not found|not match"
    local struggle_patterns="let me try|try again|didn.t match|failed to|try smaller|different approach|try another"
    
    find_sessions | while read -r f; do
        local edit_count=$(count_pattern "$f" "$edit_patterns")
        local error_count=$(count_pattern "$f" "$error_patterns")
        local struggle_count=$(count_pattern "$f" "$struggle_patterns")
        
        if [[ "$edit_count" -gt 3 && "$error_count" -gt 0 ]] || [[ "$struggle_count" -gt 2 ]]; then
            echo "----------------------------------------"
            echo "File: $f"
            echo "  Edit attempts: $edit_count"
            echo "  Edit errors: $error_count"
            echo "  Struggle mentions: $struggle_count"
            echo ""
            echo "  Error samples:"
            grep -o -E "$error_patterns.{0,50}" "$f" 2>/dev/null | head -3 | sed 's/^/    /'
            echo ""
        fi
    done
}

mode_errors() {
    echo "=== Sessions with Errors (last $HOURS hours) ==="
    echo ""
    
    find_sessions | while read -r f; do
        local tool_errors=$(count_pattern "$f" "\"isError\":true|\"isError\": true")
        local exec_errors=$(count_pattern "$f" "Error:|error\":")
        
        if [[ "$tool_errors" -gt 2 ]] || [[ "$exec_errors" -gt 5 ]]; then
            echo "$f"
            echo "  Tool errors (isError:true): $tool_errors"
            echo "  Error mentions: $exec_errors"
            echo ""
        fi
    done
}

mode_tool_stats() {
    echo "=== Tool Usage Stats (last $HOURS hours) ==="
    echo ""
    
    local tmpfile=$(mktemp)
    
    # Aggregate tool usage across all sessions
    find_sessions | while read -r f; do
        grep -o '"toolName":"[^"]*"' "$f" 2>/dev/null
    done | sort | uniq -c | sort -rn > "$tmpfile"
    
    echo "Tool call counts:"
    cat "$tmpfile" | head -20 | sed 's/^/  /'
    
    echo ""
    echo "Tool error rates:"
    
    # For top tools, calculate error rate
    for tool in rp_exec Edit read Bash Write Grep find; do
        local total=$(find_sessions -exec grep -c "\"toolName\":\"$tool\"" {} + 2>/dev/null | awk '{sum+=$1}END{print sum}')
        local errors=$(find_sessions -exec grep -l "\"toolName\":\"$tool\"" {} + 2>/dev/null | xargs grep -c "\"toolName\":\"$tool\".*isError.*true\|isError.*true.*\"toolName\":\"$tool\"" 2>/dev/null | awk -F: '{sum+=$2}END{print sum}')
        
        if [[ "$total" -gt 0 ]]; then
            echo "  $tool: $errors errors / $total calls"
        fi
    done 2>/dev/null
    
    rm -f "$tmpfile"
}

mode_report() {
    echo "╔══════════════════════════════════════════════════════════════════╗"
    echo "║           Session Analysis Report — Last $HOURS hours              ║"
    echo "╚══════════════════════════════════════════════════════════════════╝"
    echo ""
    
    # Count sessions
    local session_count=$(find_sessions | wc -l | tr -d ' ')
    local total_size=$(find_sessions -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
    local total_mb=$((total_size / 1024 / 1024))
    
    echo "Summary:"
    echo "  Sessions: $session_count"
    echo "  Total size: ${total_mb}MB"
    echo ""
    
    # Top projects by session count
    echo "Sessions by project (top 10):"
    find_sessions | sed 's|.*/--\([^/]*\)--/.*|\1|' | sort | uniq -c | sort -rn | head -10 | sed 's/^/  /'
    echo ""
    
    # Edit struggles summary
    echo "Edit Struggle Summary:"
    local struggle_count=0
    local error_total=0
    
    while read -r f; do
        local errors=$(count_pattern "$f" "search block not found|0 edits applied|no changes")
        if [[ "$errors" -gt 0 ]]; then
            struggle_count=$((struggle_count + 1))
            error_total=$((error_total + errors))
        fi
    done < <(find_sessions)
    
    echo "  Sessions with edit errors: $struggle_count"
    echo "  Total edit errors: $error_total"
    
    echo ""
    
    # rp_exec specific
    echo "rp_exec Usage:"
    local rp_sessions=0
    local rp_calls=0
    while read -r f; do
        if grep -q "rp_exec" "$f" 2>/dev/null; then
            rp_sessions=$((rp_sessions + 1))
            local c=$(count_pattern "$f" "rp_exec")
            rp_calls=$((rp_calls + c))
        fi
    done < <(find_sessions)
    echo "  Sessions using rp_exec: $rp_sessions"
    echo "  Total rp_exec calls: $rp_calls"
    echo ""
    
    # Common error patterns
    echo "Top Error Patterns:"
    find_sessions | xargs grep -h -o -E "(search block not found|0 edits applied|oldText.*not found|blocked|timeout|not match)" 2>/dev/null | sort | uniq -c | sort -rn | head -10 | sed 's/^/  /'
    echo ""
    
    echo "════════════════════════════════════════════════════════════════════"
}

# Run selected mode
case $MODE in
    list)
        mode_list
        ;;
    pattern)
        mode_pattern
        ;;
    edit-struggles)
        mode_edit_struggles
        ;;
    errors)
        mode_errors
        ;;
    tool-stats)
        mode_tool_stats
        ;;
    report)
        mode_report
        ;;
    *)
        echo "No mode selected. Use --help for usage."
        exit 1
        ;;
esac
