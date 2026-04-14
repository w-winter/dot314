#!/usr/bin/env python3
"""
pi-session-diagnostic.py

Diagnostic view of Pi agent sessions - shows tool calls, edits, errors.
For investigating what actually happened, not just the conversation flow.

Output format:
  USER: message
  ASSISTANT: assistant text
    [tool_name] key_args
  TOOL [name]: ✓/✗ truncated_output

Usage:
  python3 pi-session-diagnostic.py /path/to/session.jsonl
  python3 pi-session-diagnostic.py --latest
  cat session.jsonl | python3 pi-session-diagnostic.py -
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


MAX_OUTPUT_LINES = 8
MAX_OUTPUT_CHARS = 500


def _iter_jsonl(path: Path) -> Iterable[Dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _iter_stdin() -> Iterable[Dict[str, Any]]:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def _extract_text(content: Any) -> str:
    """Extract text from content, ignoring thinking blocks"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text", "")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        return "\n".join(parts)
    return ""


def _truncate(text: str, max_lines: int = MAX_OUTPUT_LINES, max_chars: int = MAX_OUTPUT_CHARS) -> str:
    """Truncate output to reasonable size for diagnostics"""
    if not text:
        return ""
    
    lines = text.split("\n")
    if len(lines) > max_lines:
        text = "\n".join(lines[:max_lines]) + f"\n  ... ({len(lines) - max_lines} more lines)"
    
    if len(text) > max_chars:
        text = text[:max_chars] + f"... ({len(text) - max_chars} more chars)"
    
    return text


def _format_tool_call(name: str, args: Dict[str, Any]) -> str:
    """Format tool call with key arguments only"""
    key_parts = []
    
    # Common argument patterns across tools
    if "path" in args:
        key_parts.append(args["path"])
    elif "file_path" in args:
        key_parts.append(args["file_path"])
    
    if "command" in args:
        cmd = args["command"]
        # Truncate long commands
        if len(cmd) > 80:
            cmd = cmd[:77] + "..."
        key_parts.append(f"`{cmd}`")
    elif "cmd" in args:
        cmd = args["cmd"]
        if len(cmd) > 80:
            cmd = cmd[:77] + "..."
        key_parts.append(f"`{cmd}`")
    
    # Edit-specific: show search/replace
    if "oldText" in args and "newText" in args:
        old = args["oldText"][:40] + "..." if len(args["oldText"]) > 40 else args["oldText"]
        new = args["newText"][:40] + "..." if len(args["newText"]) > 40 else args["newText"]
        old = old.replace("\n", "\\n")
        new = new.replace("\n", "\\n")
        key_parts.append(f'"{old}" → "{new}"')
    elif "search" in args and "replace" in args:
        old = args["search"][:40] + "..." if len(args["search"]) > 40 else args["search"]
        new = args["replace"][:40] + "..." if len(args["replace"]) > 40 else args["replace"]
        old = old.replace("\n", "\\n")
        new = new.replace("\n", "\\n")
        key_parts.append(f'"{old}" → "{new}"')
    
    # Pattern/query for search tools
    if "pattern" in args:
        key_parts.append(f'pattern="{args["pattern"]}"')
    if "query" in args:
        key_parts.append(f'"{args["query"]}"')
    
    # Content for write (truncated)
    if "content" in args and name.lower() in ("write", "file_actions", "create"):
        content = args["content"]
        if len(content) > 60:
            content = content[:57] + "..."
        content = content.replace("\n", "\\n")
        key_parts.append(f'content="{content}"')
    
    if key_parts:
        return f"[{name}] {' '.join(key_parts)}"
    else:
        # Fallback: show first few args
        arg_str = json.dumps(args, ensure_ascii=False)
        if len(arg_str) > 60:
            arg_str = arg_str[:57] + "..."
        return f"[{name}] {arg_str}"


def _format_tool_result(
    name: str,
    is_error: bool,
    content: str,
    *,
    max_lines: int = MAX_OUTPUT_LINES,
    max_chars: int = MAX_OUTPUT_CHARS,
) -> str:
    """Format tool result with status and truncated output"""
    status = "✗" if is_error else "✓"

    if not content or content == "(no content)":
        return f"TOOL [{name}]: {status}"

    truncated = _truncate(content, max_lines=max_lines, max_chars=max_chars)
    # Indent continuation lines
    lines = truncated.split("\n")
    if len(lines) > 1:
        indented = lines[0] + "\n" + "\n".join("  " + l for l in lines[1:])
        return f"TOOL [{name}]: {status} {indented}"
    else:
        return f"TOOL [{name}]: {status} {truncated}"


def process_session(
    records: Iterable[Dict[str, Any]],
    *,
    include_tool_results: bool,
    max_lines: int,
    max_chars: int,
) -> List[str]:
    """Process session records into diagnostic output"""
    output = []
    pending_tools: Dict[str, Tuple[str, str]] = {}  # id -> (name, formatted_call)
    
    for rec in records:
        rtype = rec.get("type")
        
        if rtype != "message":
            continue
        
        msg = rec.get("message", {})
        if not isinstance(msg, dict):
            continue
        
        role = msg.get("role")
        
        if role == "user":
            text = _extract_text(msg.get("content"))
            if text:
                output.append(f"USER: {text}")
        
        elif role == "assistant":
            content = msg.get("content", [])
            text_parts = []
            tool_parts = []
            
            if isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    
                    itype = item.get("type")
                    
                    if itype == "text":
                        t = item.get("text", "")
                        if isinstance(t, str) and t.strip():
                            text_parts.append(t.strip())
                    
                    elif itype == "toolCall":
                        tool_name = item.get("name", "tool")
                        tool_id = item.get("id", "")
                        args = item.get("arguments", {})
                        if not isinstance(args, dict):
                            try:
                                args = json.loads(args) if isinstance(args, str) else {}
                            except:
                                args = {}
                        
                        formatted = _format_tool_call(tool_name, args)
                        tool_parts.append(f"  {formatted}")
                        
                        if tool_id:
                            pending_tools[tool_id] = (tool_name, formatted)
            
            # Build assistant output
            if text_parts or tool_parts:
                lines = []
                if text_parts:
                    # Prefix first line with "ASSISTANT:", indent rest
                    text = "\n".join(text_parts)
                    text_lines = text.split("\n")
                    lines.append(f"ASSISTANT: {text_lines[0]}")
                    lines.extend(f"   {l}" for l in text_lines[1:])
                
                if tool_parts:
                    if not text_parts:
                        lines.append("ASSISTANT:")
                    lines.extend(tool_parts)
                
                output.append("\n".join(lines))
        
        elif role == "toolResult":
            if not include_tool_results:
                continue

            tool_name = msg.get("toolName") or msg.get("tool_name") or "tool"
            tool_id = msg.get("toolCallId") or msg.get("tool_call_id") or ""
            is_error = bool(msg.get("isError") or msg.get("is_error"))
            content = _extract_text(msg.get("content"))

            # Use pending tool info if available
            if tool_id in pending_tools:
                tool_name, _ = pending_tools.pop(tool_id)

            formatted = _format_tool_result(tool_name, is_error, content, max_lines=max_lines, max_chars=max_chars)
            output.append(formatted)
    
    return output


def _find_default_root() -> Optional[Path]:
    candidates = [
        Path(os.path.expanduser("~/.pi/agent/sessions")),
        Path(os.path.expanduser("~/.pi/sessions")),
    ]
    for c in candidates:
        if c.exists() and c.is_dir():
            return c
    return None


def _find_latest_jsonl(root: Path) -> Optional[Path]:
    newest: Optional[Path] = None
    newest_mtime: float = -1
    for p in root.rglob("*.jsonl"):
        try:
            st = p.stat()
        except OSError:
            continue
        if st.st_mtime > newest_mtime:
            newest_mtime = st.st_mtime
            newest = p
    return newest


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(
        description="Diagnostic view of Pi sessions - shows tool calls, edits, errors"
    )
    p.add_argument(
        "jsonl",
        nargs="?",
        default=None,
        help="Path to session .jsonl file, or '-' for stdin"
    )
    p.add_argument(
        "--latest",
        action="store_true",
        help="Process the newest session under default root"
    )
    p.add_argument(
        "--include-tool-results",
        action="store_true",
        help="Include tool result/output blocks (default: omitted)"
    )
    p.add_argument(
        "--max-lines",
        type=int,
        default=MAX_OUTPUT_LINES,
        help=f"Max lines per tool output (default: {MAX_OUTPUT_LINES})"
    )
    p.add_argument(
        "--max-chars",
        type=int,
        default=MAX_OUTPUT_CHARS,
        help=f"Max chars per tool output (default: {MAX_OUTPUT_CHARS})"
    )
    args = p.parse_args(argv)
    
    # Determine input source
    if args.jsonl == "-":
        records = list(_iter_stdin())
    elif args.latest or not args.jsonl:
        root = _find_default_root()
        if not root:
            print("No Pi sessions root found", file=sys.stderr)
            return 2
        latest = _find_latest_jsonl(root)
        if not latest:
            print(f"No .jsonl files found under {root}", file=sys.stderr)
            return 1
        print(f"# Source: {latest}", file=sys.stderr)
        records = list(_iter_jsonl(latest))
    else:
        jsonl_path = Path(os.path.expanduser(args.jsonl))
        if jsonl_path.is_dir():
            latest = _find_latest_jsonl(jsonl_path)
            if not latest:
                print(f"No .jsonl files found under {jsonl_path}", file=sys.stderr)
                return 1
            jsonl_path = latest
        if not jsonl_path.exists():
            print(f"File not found: {jsonl_path}", file=sys.stderr)
            return 2
        records = list(_iter_jsonl(jsonl_path))
    
    output = process_session(
        records,
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
