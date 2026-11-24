#!/usr/bin/env python3
"""
agy-session-extract-with-tools.py

Readable view of Antigravity (agy) agent sessions, with optional full tool calls
and bounded tool results.

Output format:
  USER: message
  ASSISTANT: assistant text
  ASSISTANT:
    [tool_name]
      {full_args_json}
  TOOL [name]: ✓/✗ truncated_output

Usage:
  python3 agy-session-extract-with-tools.py /path/to/transcript_full.jsonl
  python3 agy-session-extract-with-tools.py /path/to/brain/<conversation-id>
  python3 agy-session-extract-with-tools.py --latest
  cat transcript_full.jsonl | python3 agy-session-extract-with-tools.py -
"""

from __future__ import annotations

import argparse
from collections import deque
import json
import os
from pathlib import Path
import re
import signal
import sys
from typing import Any, Deque, Dict, Iterable, List, Optional


MAX_OUTPUT_LINES = 8
MAX_OUTPUT_CHARS = 500
USER_REQUEST_RE = re.compile(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", re.DOTALL)
USER_REQUEST_OPEN_RE = re.compile(r"^\s*<USER_REQUEST>\s*")
ERROR_STATUSES = frozenset({"ERROR", "INVALID"})


def _iter_jsonl(path: Path) -> Iterable[Dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                yield record


def _iter_stdin() -> Iterable[Dict[str, Any]]:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            yield record


def _extract_user_text(content: Any) -> str:
    """
    Extract the user's message from an agy USER_INPUT content string

    Strips the outer <USER_REQUEST> wrapper and trailing metadata tags when present.

    Args:
        content (Any): Raw content field from a USER_INPUT record

    Returns:
        Cleaned user message text
    """
    if not isinstance(content, str):
        return ""
    match = USER_REQUEST_RE.search(content)
    if match:
        return match.group(1).strip()
    return USER_REQUEST_OPEN_RE.sub("", content).strip()


def _truncate(text: str, max_lines: int = MAX_OUTPUT_LINES, max_chars: int = MAX_OUTPUT_CHARS) -> str:
    """
    Truncate tool output to bounded line and character limits

    Args:
        text (str): Tool output text
        max_lines (int): Maximum lines to keep
        max_chars (int): Maximum characters to keep

    Returns:
        Truncated text with overflow suffix when limits are exceeded
    """
    if not text:
        return ""

    lines = text.split("\n")
    if len(lines) > max_lines:
        text = "\n".join(lines[:max_lines]) + f"\n  ... ({len(lines) - max_lines} more lines)"

    if len(text) > max_chars:
        text = text[:max_chars] + f"... ({len(text) - max_chars} more chars)"

    return text


def _format_tool_call(name: str, args: Any) -> List[str]:
    """
    Format a tool call with full, deterministically ordered JSON arguments

    Args:
        name (str): Tool name
        args (Any): Tool arguments mapping or JSON string

    Returns:
        Formatted output lines for the tool invocation
    """
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            pass

    arg_str = json.dumps(args, ensure_ascii=False, indent=2, sort_keys=True)
    if "\n" not in arg_str:
        return [f"[{name}] {arg_str}"]
    return [f"[{name}]", *[f"  {line}" for line in arg_str.splitlines()]]


def _format_tool_result(
    name: str,
    is_error: bool,
    content: str,
    *,
    max_lines: int = MAX_OUTPUT_LINES,
    max_chars: int = MAX_OUTPUT_CHARS,
) -> str:
    """
    Format a tool result line with status marker and bounded output

    Args:
        name (str): Tool name
        is_error (bool): Whether the tool execution failed
        content (str): Tool result or error text
        max_lines (int): Maximum output lines
        max_chars (int): Maximum output characters

    Returns:
        Formatted TOOL result block
    """
    status = "✗" if is_error else "✓"

    if not content:
        return f"TOOL [{name}]: {status}"

    truncated = _truncate(content, max_lines=max_lines, max_chars=max_chars)
    lines = truncated.split("\n")
    if len(lines) > 1:
        indented = lines[0] + "\n" + "\n".join(f"  {line}" for line in lines[1:])
        return f"TOOL [{name}]: {status} {indented}"
    return f"TOOL [{name}]: {status} {truncated}"


def process_session(
    records: Iterable[Dict[str, Any]],
    *,
    include_tool_calls: bool,
    include_tool_results: bool,
    max_lines: int,
    max_chars: int,
) -> List[str]:
    """
    Convert agy transcript records into readable diagnostic blocks

    Args:
        records (Iterable[Dict[str, Any]]): Parsed JSONL transcript records
        include_tool_calls (bool): Include assistant tool invocations with full arguments
        include_tool_results (bool): Include bounded tool result blocks
        max_lines (int): Max lines per tool result
        max_chars (int): Max chars per tool result

    Returns:
        List of formatted conversation blocks
    """
    output: List[str] = []
    pending_tools: Deque[str] = deque()

    for rec in records:
        record_type = rec.get("type")

        if record_type == "USER_INPUT":
            text = _extract_user_text(rec.get("content"))
            if text:
                output.append(f"USER: {text}")

        elif record_type == "PLANNER_RESPONSE":
            raw_content = rec.get("content")
            text = raw_content.strip() if isinstance(raw_content, str) else ""
            tool_parts: List[str] = []

            tool_calls = rec.get("tool_calls")
            if isinstance(tool_calls, list):
                for tool_call in tool_calls:
                    if not isinstance(tool_call, dict):
                        continue
                    tool_name = tool_call.get("name") or "tool"
                    pending_tools.append(str(tool_name))
                    if include_tool_calls:
                        formatted = _format_tool_call(str(tool_name), tool_call.get("args", {}))
                        tool_parts.extend(f"  {line}" for line in formatted)

            if text or tool_parts:
                lines: List[str] = []
                if text:
                    text_lines = text.split("\n")
                    lines.append(f"ASSISTANT: {text_lines[0]}")
                    lines.extend(f"   {line}" for line in text_lines[1:])

                if tool_parts:
                    if not text:
                        lines.append("ASSISTANT:")
                    lines.extend(tool_parts)

                output.append("\n".join(lines))

        elif record_type == "GENERIC":
            tool_name = pending_tools.popleft() if pending_tools else "tool"
            if not include_tool_results:
                continue

            error_text = rec.get("error")
            raw_content = rec.get("content")
            is_error = bool(error_text) or rec.get("status") in ERROR_STATUSES

            parts: List[str] = []
            if isinstance(error_text, str) and error_text.strip():
                parts.append(error_text.strip())
            if isinstance(raw_content, str) and raw_content.strip():
                parts.append(raw_content.strip())
            result_text = "\n".join(parts)

            output.append(
                _format_tool_result(
                    tool_name,
                    is_error,
                    result_text,
                    max_lines=max_lines,
                    max_chars=max_chars,
                )
            )

    return output


def _find_default_root() -> Optional[Path]:
    root = Path(os.path.expanduser("~/.gemini/antigravity-cli/brain"))
    if root.exists() and root.is_dir():
        return root
    return None


def _find_latest_transcript(root: Path) -> Optional[Path]:
    direct = root / ".system_generated" / "logs" / "transcript_full.jsonl"
    if direct.is_file():
        return direct

    newest: Optional[Path] = None
    newest_mtime = -1.0
    for path in root.glob("*/.system_generated/logs/transcript_full.jsonl"):
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if mtime > newest_mtime:
            newest_mtime = mtime
            newest = path
    return newest


def main(argv: Optional[List[str]] = None) -> int:
    if hasattr(signal, "SIGPIPE"):
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    parser = argparse.ArgumentParser(
        description="Readable view of Antigravity (agy) sessions, with optional full tool calls and bounded tool results"
    )
    parser.add_argument(
        "jsonl",
        nargs="?",
        default=None,
        help="Path to transcript_full.jsonl (or conversation directory), or '-' for stdin",
    )
    parser.add_argument(
        "--latest",
        action="store_true",
        help="Process the newest session under ~/.gemini/antigravity-cli/brain",
    )
    parser.add_argument(
        "--include-tool-calls",
        action="store_true",
        help="Include assistant tool invocations with full arguments (default: omitted)",
    )
    parser.add_argument(
        "--include-tool-results",
        action="store_true",
        help="Include tool result/output blocks (default: omitted)",
    )
    parser.add_argument(
        "--max-lines",
        type=int,
        default=MAX_OUTPUT_LINES,
        help=f"Max lines per tool output (default: {MAX_OUTPUT_LINES})",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=MAX_OUTPUT_CHARS,
        help=f"Max chars per tool output (default: {MAX_OUTPUT_CHARS})",
    )
    args = parser.parse_args(argv)

    if args.jsonl == "-":
        records = list(_iter_stdin())
    elif args.latest or not args.jsonl:
        root = _find_default_root()
        if not root:
            print("No Antigravity sessions root found", file=sys.stderr)
            return 2
        latest = _find_latest_transcript(root)
        if not latest:
            print(f"No transcript_full.jsonl files found under {root}", file=sys.stderr)
            return 1
        print(f"# Source: {latest}", file=sys.stderr)
        records = list(_iter_jsonl(latest))
    else:
        jsonl_path = Path(os.path.expanduser(args.jsonl))
        if jsonl_path.is_dir():
            latest = _find_latest_transcript(jsonl_path)
            if not latest:
                print(f"No transcript_full.jsonl files found under {jsonl_path}", file=sys.stderr)
                return 1
            jsonl_path = latest
        if not jsonl_path.exists():
            print(f"File not found: {jsonl_path}", file=sys.stderr)
            return 2
        records = list(_iter_jsonl(jsonl_path))

    output = process_session(
        records,
        include_tool_calls=args.include_tool_calls,
        include_tool_results=args.include_tool_results,
        max_lines=args.max_lines,
        max_chars=args.max_chars,
    )

    if not output:
        print("No conversation found", file=sys.stderr)
        return 1

    for item in output:
        print(item)
        print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
