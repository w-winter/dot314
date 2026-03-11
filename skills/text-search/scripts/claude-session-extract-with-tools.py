#!/usr/bin/env python3
"""
claude-session-diagnostic.py

Diagnostic view of Claude Code sessions - shows tool calls, edits, errors.
For investigating what actually happened, not just the conversation flow.

Output format:
  USER: message
  A: assistant text
    [tool_name] key_args
  TOOL [name]: ✓/✗ truncated_output

Usage:
  python3 claude-session-diagnostic.py /path/to/session.jsonl
  python3 claude-session-diagnostic.py --latest
  cat session.jsonl | python3 claude-session-diagnostic.py -
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


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


def _truncate(text: str, max_lines: int = MAX_OUTPUT_LINES, max_chars: int = MAX_OUTPUT_CHARS) -> str:
    if not text:
        return ""
    
    lines = text.split("\n")
    if len(lines) > max_lines:
        text = "\n".join(lines[:max_lines]) + f"\n  ... ({len(lines) - max_lines} more lines)"
    
    if len(text) > max_chars:
        text = text[:max_chars] + f"... ({len(text) - max_chars} more chars)"
    
    return text


def _extract_text_from_content(content: Any) -> str:
    """Extract text from Claude Code content structures"""
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


def _clean_xml_content(content: str) -> str:
    """Extract meaningful content from XML-wrapped command output"""
    if not content:
        return content
    
    # Extract stdout content
    stdout_match = re.search(r'<local-command-stdout>([^<]*)</local-command-stdout>', content)
    if stdout_match:
        return stdout_match.group(1).strip()
    
    # Remove XML tags but preserve content
    content = re.sub(r'<command-name>([^<]+)</command-name>', r'[\1]', content)
    content = re.sub(r'<command-message>[^<]*</command-message>', '', content)
    content = re.sub(r'<command-args>[^<]*</command-args>', '', content)
    content = re.sub(r'<[^>]+>', '', content)
    
    return content.strip()


def _format_tool_call(name: str, tool_input: Dict[str, Any]) -> str:
    """Format tool call with key arguments"""
    key_parts = []
    
    # File operations
    if "file_path" in tool_input:
        key_parts.append(tool_input["file_path"])
    elif "path" in tool_input:
        key_parts.append(tool_input["path"])
    
    # Commands
    if "command" in tool_input:
        cmd = str(tool_input["command"])
        if len(cmd) > 80:
            cmd = cmd[:77] + "..."
        key_parts.append(f"`{cmd}`")
    
    # Edit patterns
    for old_key, new_key in [("old_str", "new_str"), ("search", "replace"), ("oldText", "newText")]:
        if old_key in tool_input and new_key in tool_input:
            old = str(tool_input[old_key])[:40]
            new = str(tool_input[new_key])[:40]
            if len(tool_input[old_key]) > 40:
                old += "..."
            if len(tool_input[new_key]) > 40:
                new += "..."
            old = old.replace("\n", "\\n")
            new = new.replace("\n", "\\n")
            key_parts.append(f'"{old}" → "{new}"')
            break
    
    # Pattern/query
    if "pattern" in tool_input:
        key_parts.append(f'pattern="{tool_input["pattern"]}"')
    if "regex" in tool_input:
        key_parts.append(f'regex="{tool_input["regex"]}"')
    
    if key_parts:
        return f"[{name}] {' '.join(key_parts)}"
    else:
        arg_str = json.dumps(tool_input, ensure_ascii=False)
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
    """Process Claude Code session records into diagnostic output"""
    output = []
    pending_tools: Dict[str, str] = {}  # tool_use_id -> name
    
    for rec in records:
        rec_type = rec.get("type")
        
        # Skip metadata records
        if rec.get("isMeta") or rec_type == "file-history-snapshot":
            continue
        
        # Compact summaries are useful context
        if rec.get("isCompactSummary"):
            message = rec.get("message", {})
            content = message.get("content", "")
            if content and isinstance(content, str):
                output.append(f"[COMPACT SUMMARY]\n{_truncate(content, max_lines=12, max_chars=800)}")
            continue
        
        if rec_type not in ("user", "assistant"):
            continue
        
        message = rec.get("message", {})
        if not isinstance(message, dict):
            continue
        
        role = message.get("role")
        content = message.get("content", [])
        
        if role == "user":
            # Check for command/output patterns
            if isinstance(content, str):
                if '<command-name>' in content:
                    cmd_match = re.search(r'<command-name>([^<]+)</command-name>', content)
                    if cmd_match:
                        output.append(f"USER: [cmd] {cmd_match.group(1)}")
                elif '<local-command-stdout>' in content:
                    if include_tool_results:
                        cleaned = _clean_xml_content(content)
                        if cleaned:
                            output.append(
                                f"TOOL [cmd]: ✓ {_truncate(cleaned, max_lines=max_lines, max_chars=max_chars)}"
                            )
                else:
                    # Skip certain system messages
                    if (content and 
                        not content.startswith('Caveat:') and
                        not content.startswith('This session is being continued') and
                        not content.startswith('With your Claude Max subscription') and
                        not content.startswith('[Request interrupted')):
                        output.append(f"USER: {content}")
            
            elif isinstance(content, list):
                text_parts = []
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        text = item.get("text", "")
                        if text:
                            # Check for XML command patterns
                            if '<command-name>' in text:
                                cmd_match = re.search(r'<command-name>([^<]+)</command-name>', text)
                                if cmd_match:
                                    text_parts.append(f"[cmd] {cmd_match.group(1)}")
                            elif '<local-command-stdout>' in text:
                                if include_tool_results:
                                    cleaned = _clean_xml_content(text)
                                    if cleaned:
                                        output.append(
                                            f"TOOL [cmd]: ✓ {_truncate(cleaned, max_lines=max_lines, max_chars=max_chars)}"
                                        )
                            else:
                                text_parts.append(text)
                    
                    elif isinstance(item, dict) and item.get("type") == "tool_result":
                        tool_use_id = item.get("tool_use_id", "")
                        is_error = item.get("is_error", False)
                        result_content = item.get("content", "")
                        name = pending_tools.pop(tool_use_id, "tool")

                        if not include_tool_results:
                            continue

                        if isinstance(result_content, list):
                            result_content = _extract_text_from_content(result_content)

                        formatted = _format_tool_result(
                            name,
                            is_error,
                            str(result_content),
                            max_lines=max_lines,
                            max_chars=max_chars,
                        )
                        output.append(formatted)
                
                if text_parts:
                    full_text = "\n".join(text_parts)
                    # Skip system injections
                    if not (full_text.startswith('Caveat:') or 
                            full_text.startswith('This session is being continued')):
                        output.append(f"USER: {full_text}")
        
        elif role == "assistant":
            text_parts = []
            tool_parts = []
            
            if isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    
                    itype = item.get("type")
                    
                    if itype == "text":
                        text = item.get("text", "")
                        if text and isinstance(text, str):
                            text_parts.append(text.strip())
                    
                    elif itype == "tool_use":
                        name = item.get("name", "tool")
                        tool_input = item.get("input", {})
                        tool_use_id = item.get("id", "")
                        
                        if tool_use_id:
                            pending_tools[tool_use_id] = name
                        
                        formatted = _format_tool_call(name, tool_input if isinstance(tool_input, dict) else {})
                        tool_parts.append(f"  {formatted}")
                    
                    # Skip thinking blocks entirely
            
            elif isinstance(content, str):
                text_parts.append(content)
            
            if text_parts or tool_parts:
                lines = []
                if text_parts:
                    text = "\n".join(text_parts)
                    text_lines = text.split("\n")
                    lines.append(f"A: {text_lines[0]}")
                    lines.extend(f"   {l}" for l in text_lines[1:] if l.strip())
                if tool_parts:
                    if not text_parts:
                        lines.append("A:")
                    lines.extend(tool_parts)
                output.append("\n".join(lines))
    
    return output


def _find_default_root() -> Optional[Path]:
    candidates = [
        Path(os.path.expanduser("~/.claude/projects")),
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
        description="Diagnostic view of Claude Code sessions - shows tool calls, edits, errors"
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
        help=f"Max lines per tool output when included (default: {MAX_OUTPUT_LINES})"
    )
    p.add_argument(
        "--max-chars",
        type=int,
        default=MAX_OUTPUT_CHARS,
        help=f"Max chars per tool output when included (default: {MAX_OUTPUT_CHARS})"
    )
    args = p.parse_args(argv)
    
    # Determine input source
    if args.jsonl == "-":
        records = list(_iter_stdin())
    elif args.latest or not args.jsonl:
        root = _find_default_root()
        if not root:
            print("No Claude Code sessions root found", file=sys.stderr)
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
