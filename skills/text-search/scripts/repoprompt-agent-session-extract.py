#!/usr/bin/env python3
"""
Readable diagnostic view of RepoPrompt AgentSession JSON files

Renders RepoPrompt's compressed transcript projection into a dense, human-readable
text view and includes the path to the full Codex rollout JSONL
(Claude Code JSONL not yet supported)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

FAILURE_STATUSES = {"failed", "error", "cancelled", "canceled", "timeout", "timed_out"}
DETAIL_OMIT_KEYS = {
    "summary_only",
    "summaryOnly",
    "summary_text",
    "summaryText",
    "status",
    "type",
}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render a RepoPrompt AgentSession JSON file into a readable transcript",
    )
    parser.add_argument("file", nargs="?", help="Path to AgentSession-*.json, or '-' for stdin")
    parser.add_argument("--latest", action="store_true", help="Render the most recent local AgentSession JSON")
    parser.add_argument(
        "--include-tool-calls",
        action="store_true",
        help="Include tool execution summaries from the compressed RepoPrompt transcript",
    )
    parser.add_argument(
        "--include-tool-results",
        action="store_true",
        help="Include parsed tool result detail blocks when available",
    )
    parser.add_argument(
        "--max-lines",
        type=int,
        default=8,
        help="Max lines per raw tool-detail block when --include-tool-results is set",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=500,
        help="Max chars per raw tool-detail block when --include-tool-results is set",
    )
    return parser.parse_args()


def _find_latest_agent_session() -> Path:
    workspace_root = Path.home() / "Library" / "Application Support" / "RepoPrompt" / "Workspaces"
    candidates = list(workspace_root.glob("Workspace-*/AgentSessions/AgentSession-*.json"))
    if not candidates:
        raise FileNotFoundError(f"No AgentSession JSON files found under {workspace_root}")
    return max(candidates, key=lambda path: path.stat().st_mtime)


def _load_session(path_arg: str | None, use_latest: bool) -> tuple[dict[str, Any], str]:
    if use_latest:
        path = _find_latest_agent_session()
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            return json.load(handle), str(path)

    if not path_arg:
        raise ValueError("Either a file path or --latest is required")

    if path_arg == "-":
        return json.load(sys.stdin), "<stdin>"

    path = Path(path_arg).expanduser()
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        return json.load(handle), str(path)


def _flatten_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        parts = [_flatten_text(item) for item in value]
        return "\n".join(part for part in parts if part)
    if isinstance(value, dict):
        for key in ("text", "content", "message", "body", "summary"):
            if key in value:
                text = _flatten_text(value[key])
                if text:
                    return text
        parts = [_flatten_text(item) for item in value.values()]
        return "\n".join(part for part in parts if part)
    return str(value)


def _format_block(prefix: str, text: str, *, continuation_prefix: str | None = None) -> list[str]:
    normalized = text.strip() or "(empty)"
    lines = normalized.splitlines() or [normalized]
    rest_prefix = continuation_prefix if continuation_prefix is not None else (" " * len(prefix))
    return [prefix + lines[0], *[rest_prefix + line for line in lines[1:]]]


def _truncate(text: str, *, max_lines: int, max_chars: int) -> str:
    if not text:
        return ""

    lines = text.splitlines()
    if len(lines) > max_lines:
        text = "\n".join(lines[:max_lines]) + f"\n... ({len(lines) - max_lines} more lines)"

    if len(text) > max_chars:
        hidden_count = len(text) - max_chars
        text = text[:max_chars] + f"... ({hidden_count} more chars)"

    return text


def _parse_json_maybe(raw: Any) -> Any:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _get_turns(session: dict[str, Any]) -> list[dict[str, Any]]:
    transcript = session.get("transcript")
    if not isinstance(transcript, dict):
        raise ValueError("Unsupported AgentSession shape: missing transcript object")

    turns = transcript.get("turns")
    if not isinstance(turns, list):
        raise ValueError("Unsupported AgentSession shape: transcript.turns is not a list")

    return turns


def _is_assistant_activity(activity: dict[str, Any]) -> bool:
    return activity.get("role") == "assistant" or activity.get("itemKind") == "assistant"


def _tool_status_symbol(tool_execution: dict[str, Any]) -> str:
    status = str(tool_execution.get("status") or "").strip().lower()
    is_error = bool(tool_execution.get("toolIsError"))
    if is_error or status in FAILURE_STATUSES:
        return "✗"
    return "✓"


def _get_tool_summary(tool_execution: dict[str, Any], parsed_result: Any | None = None) -> str:
    parsed = parsed_result if parsed_result is not None else _parse_json_maybe(tool_execution.get("resultJSON"))
    summary = _flatten_text(tool_execution.get("summaryText"))
    if not summary and isinstance(parsed, dict):
        summary = _flatten_text(parsed.get("summary_text"))
    if not summary:
        summary = _flatten_text(tool_execution.get("status")) or "(no summary)"
    return summary


def _get_tool_details(tool_execution: dict[str, Any], parsed_result: Any | None = None) -> Any | None:
    parsed = parsed_result if parsed_result is not None else _parse_json_maybe(tool_execution.get("resultJSON"))

    details: Any = None
    if isinstance(parsed, dict):
        details = {key: value for key, value in parsed.items() if key not in DETAIL_OMIT_KEYS}
        if not details:
            details = None
    elif tool_execution.get("resultJSON"):
        details = tool_execution.get("resultJSON")

    if tool_execution.get("exitCode") is not None and isinstance(details, dict):
        details = {**details, "exitCode": tool_execution.get("exitCode")}
    elif tool_execution.get("exitCode") is not None and details is None:
        details = {"exitCode": tool_execution.get("exitCode")}

    return details


def _is_generic_tool_summary(tool_name: str, summary: str) -> bool:
    normalized_tool_name = tool_name.strip().lower()
    normalized_summary = " ".join(summary.strip().lower().split())
    generic_summaries = {
        normalized_tool_name,
        f"{normalized_tool_name} • success",
        f"{normalized_tool_name} • failed",
        f"{normalized_tool_name} • error",
    }
    return normalized_summary in generic_summaries


def _should_batch_tool_summary(tool_execution: dict[str, Any], *, include_tool_results: bool) -> bool:
    tool_name = str(tool_execution.get("toolName") or "tool")
    parsed_result = _parse_json_maybe(tool_execution.get("resultJSON"))
    summary = _get_tool_summary(tool_execution, parsed_result)
    if not _is_generic_tool_summary(tool_name, summary):
        return False

    if include_tool_results:
        return _get_tool_details(tool_execution, parsed_result) is None

    return True


def _format_tool_batch(tool_executions: list[dict[str, Any]]) -> list[str]:
    success_counts: dict[str, int] = {}
    failure_counts: dict[str, int] = {}

    for tool_execution in tool_executions:
        tool_name = str(tool_execution.get("toolName") or "tool")
        target = failure_counts if _tool_status_symbol(tool_execution) == "✗" else success_counts
        target[tool_name] = target.get(tool_name, 0) + 1

    def format_counts(counts: dict[str, int]) -> str:
        return ", ".join(
            f"{tool_name}×{count}" if count > 1 else tool_name
            for tool_name, count in counts.items()
        )

    lines: list[str] = []
    if success_counts:
        lines.append(f"TOOLS: {format_counts(success_counts)}")
    if failure_counts:
        lines.append(f"TOOL FAILURES: {format_counts(failure_counts)}")
    return lines


def _format_tool_summary(
    tool_execution: dict[str, Any],
    *,
    include_tool_results: bool,
    max_lines: int,
    max_chars: int,
) -> list[str]:
    tool_name = str(tool_execution.get("toolName") or "tool")
    symbol = _tool_status_symbol(tool_execution)
    parsed_result = _parse_json_maybe(tool_execution.get("resultJSON"))
    summary = _get_tool_summary(tool_execution, parsed_result)

    lines = _format_block(f"TOOL [{tool_name}]: {symbol} ", summary)

    if include_tool_results:
        details = _get_tool_details(tool_execution, parsed_result)
        if details is not None:
            detail_text = (
                json.dumps(details, ensure_ascii=False, indent=2, sort_keys=True)
                if isinstance(details, dict)
                else str(details)
            )
            lines.extend(
                _format_block(
                    "  details: ",
                    _truncate(detail_text, max_lines=max_lines, max_chars=max_chars),
                    continuation_prefix="           ",
                )
            )

    return lines


def render_session(
    session: dict[str, Any],
    *,
    include_tool_calls: bool,
    include_tool_results: bool,
    max_lines: int,
    max_chars: int,
) -> str:
    turns = _get_turns(session)

    lines = [
        f"Session ID: {session.get('id') or '(unknown)'}",
        f"Name: {session.get('name') or '(unnamed)'}",
        f"Agent: {session.get('agentKind') or '?'} • {session.get('agentModel') or session.get('codexModel') or '?'}",
    ]

    rollout_path = session.get("codexRolloutPath")
    if isinstance(rollout_path, str) and rollout_path.strip():
        lines.append(f"Codex session JSONL: {rollout_path}")

    lines.extend(["", "Transcript", ""])

    for turn_index, turn in enumerate(turns, start=1):
        lines.append(f"[turn {turn_index}]")
        pending_tool_batch: list[dict[str, Any]] = []

        def flush_pending_tool_batch() -> None:
            nonlocal pending_tool_batch
            if pending_tool_batch:
                lines.extend(_format_tool_batch(pending_tool_batch))
                pending_tool_batch = []

        request = turn.get("request")
        if isinstance(request, dict):
            request_text = _flatten_text(request.get("text"))
            if request_text:
                lines.extend(_format_block("USER: ", request_text))
                lines.append("")

        for span in turn.get("responseSpans") or []:
            if not isinstance(span, dict):
                continue
            for activity in span.get("activities") or []:
                if not isinstance(activity, dict):
                    continue

                tool_execution = activity.get("toolExecution")
                if isinstance(tool_execution, dict):
                    if not include_tool_calls and not include_tool_results:
                        continue
                    if _should_batch_tool_summary(tool_execution, include_tool_results=include_tool_results):
                        pending_tool_batch.append(tool_execution)
                    else:
                        flush_pending_tool_batch()
                        lines.extend(
                            _format_tool_summary(
                                tool_execution,
                                include_tool_results=include_tool_results,
                                max_lines=max_lines,
                                max_chars=max_chars,
                            )
                        )
                    continue

                flush_pending_tool_batch()

                if _is_assistant_activity(activity):
                    assistant_text = _flatten_text(activity.get("text"))
                    if assistant_text:
                        lines.extend(_format_block("ASSISTANT: ", assistant_text, continuation_prefix="           "))
                        continue

                if activity.get("role") == "user":
                    user_text = _flatten_text(activity.get("text"))
                    if user_text:
                        lines.extend(_format_block("USER: ", user_text))

        flush_pending_tool_batch()
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = _parse_args()

    try:
        session, source_label = _load_session(args.file, args.latest)
        rendered = render_session(
            session,
            include_tool_calls=args.include_tool_calls,
            include_tool_results=args.include_tool_results,
            max_lines=max(1, args.max_lines),
            max_chars=max(50, args.max_chars),
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
