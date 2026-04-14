#!/usr/bin/env python3
"""
codex-session-diagnostic.py

Diagnostic view of Codex sessions - shows tool calls, edits, errors.
For investigating what actually happened, not just the conversation flow.

Output format:
  USER: message
  ASSISTANT: assistant text
    [tool_name] key_args
  TOOL [name]: ✓/✗ truncated_output

Usage:
  python3 codex-session-diagnostic.py /path/to/session.jsonl
  python3 codex-session-diagnostic.py --latest
  cat session.jsonl | python3 codex-session-diagnostic.py -
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
ENVIRONMENT_CONTEXT_END = "</environment_context>"
LEADING_TRANSCRIPT_PREAMBLE_PREFIXES = (
    "# AGENTS.md instructions",
    "<INSTRUCTIONS>",
    "<user_instructions>",
    "<environment_context>",
)


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


def _safe_json_loads(s: str) -> Any:
    try:
        return json.loads(s)
    except:
        return None


def _flatten_text(v: Any) -> str:
    """Extract readable text from various shapes"""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, list):
        parts = [_flatten_text(item) for item in v]
        return "\n".join(p for p in parts if p)
    if isinstance(v, dict):
        for key in ("text", "content", "message", "body", "display_text"):
            if key in v:
                return _flatten_text(v[key])
        parts = [_flatten_text(vv) for vv in v.values()]
        return "\n".join(p for p in parts if p)
    return str(v)


def _format_tool_call(name: str, args: Any) -> str:
    """Format tool call with key arguments"""
    if isinstance(args, str):
        parsed = _safe_json_loads(args)
        if parsed:
            args = parsed
    
    if not isinstance(args, dict):
        arg_str = str(args)
        if len(arg_str) > 60:
            arg_str = arg_str[:57] + "..."
        return f"[{name}] {arg_str}"
    
    key_parts = []
    
    # Common patterns
    if "path" in args:
        key_parts.append(args["path"])
    elif "file_path" in args:
        key_parts.append(args["file_path"])
    
    if "command" in args:
        cmd = str(args["command"])
        if len(cmd) > 80:
            cmd = cmd[:77] + "..."
        key_parts.append(f"`{cmd}`")
    
    # Edit patterns
    for old_key, new_key in [("old_str", "new_str"), ("search", "replace"), ("oldText", "newText")]:
        if old_key in args and new_key in args:
            old = str(args[old_key])[:40]
            new = str(args[new_key])[:40]
            if len(args[old_key]) > 40:
                old += "..."
            if len(args[new_key]) > 40:
                new += "..."
            old = old.replace("\n", "\\n")
            new = new.replace("\n", "\\n")
            key_parts.append(f'"{old}" → "{new}"')
            break
    
    if "pattern" in args:
        key_parts.append(f'pattern="{args["pattern"]}"')
    
    if key_parts:
        return f"[{name}] {' '.join(key_parts)}"
    else:
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
    lines = truncated.split("\n")
    if len(lines) > 1:
        indented = lines[0] + "\n" + "\n".join("  " + l for l in lines[1:])
        return f"TOOL [{name}]: {status} {indented}"
    else:
        return f"TOOL [{name}]: {status} {truncated}"


def _extract_role_and_text(obj: Dict) -> Tuple[str, str]:
    """Extract role and text from various Codex message shapes"""
    role = None
    text = ""
    
    for key in ("role", "actor", "author", "from"):
        if key in obj:
            role = obj[key]
            break
    
    for key in ("content", "text", "message", "body"):
        if key in obj:
            text = _flatten_text(obj[key])
            break
    
    if not text and "choices" in obj and isinstance(obj["choices"], list):
        ch_texts = []
        for c in obj["choices"]:
            ch_texts.append(_flatten_text(c.get("message") or c.get("text") or c.get("content")))
        text = "\n".join(t for t in ch_texts if t)
    
    # Check nested message
    if not text:
        for k in ("message", "msg", "payload"):
            if k in obj and isinstance(obj[k], dict):
                nested = obj[k]
                if not role and "role" in nested:
                    role = nested["role"]
                text = _flatten_text(nested.get("content") or nested.get("text") or nested.get("body"))
                break
    
    # Normalize role
    if isinstance(role, dict):
        role = role.get("role") or role.get("name")
    if role is None:
        role = obj.get("type") or obj.get("record_type") or "unknown"
    role = str(role).lower()
    
    if role in ("human", "user", "end-user"):
        role = "user"
    elif role in ("assistant", "ai", "bot"):
        role = "assistant"
    
    return role, text or ""


def process_session(
    records: Iterable[Dict[str, Any]],
    *,
    include_tool_results: bool,
    max_lines: int,
    max_chars: int,
) -> List[str]:
    """Process Codex session records into diagnostic output"""
    output = []
    transcript_started = False
    dropping_leading_preamble = False

    def normalize_leading_text(text: str) -> str:
        nonlocal transcript_started, dropping_leading_preamble

        if not text:
            return ""

        if transcript_started:
            return text

        if dropping_leading_preamble:
            end_index = text.find(ENVIRONMENT_CONTEXT_END)
            if end_index < 0:
                return ""

            dropping_leading_preamble = False
            stripped = text[end_index + len(ENVIRONMENT_CONTEXT_END):].lstrip()
            if stripped:
                transcript_started = True
            return stripped

        stripped_leading = text.lstrip()
        if ENVIRONMENT_CONTEXT_END in stripped_leading:
            end_index = stripped_leading.find(ENVIRONMENT_CONTEXT_END)
            stripped = stripped_leading[end_index + len(ENVIRONMENT_CONTEXT_END):].lstrip()
            if stripped:
                transcript_started = True
            return stripped

        if stripped_leading.startswith(LEADING_TRANSCRIPT_PREAMBLE_PREFIXES):
            dropping_leading_preamble = True
            return ""

        transcript_started = True
        return text

    def append_output(item: str) -> None:
        nonlocal transcript_started
        if not item:
            return
        output.append(item)
        transcript_started = True

    for obj in records:
        typ = str(obj.get("type") or obj.get("record_type") or "").lower()

        if typ == "response_item" and isinstance(obj.get("payload"), dict):
            payload = obj["payload"]
            payload_type = str(payload.get("type") or payload.get("record_type") or "").lower()
            normalized = dict(payload)
            if payload_type and "type" not in normalized:
                normalized["type"] = payload_type
            obj = normalized
            typ = str(obj.get("type") or obj.get("record_type") or "").lower()
        
        # Skip session metadata
        if typ in ("session_meta", "session", "state"):
            continue
        
        # Reasoning traces - include summary only
        if typ == "reasoning":
            summary_list = obj.get("summary") or []
            if isinstance(summary_list, dict):
                summary_list = [summary_list]
            for s in summary_list:
                if isinstance(s, dict):
                    text = s.get("text", "")
                    if text:
                        if dropping_leading_preamble and not transcript_started:
                            continue
                        append_output(f"ASSISTANT: [reasoning] {_truncate(text, max_lines=4, max_chars=200)}")
            continue
        
        # Function calls
        if typ in ("function_call", "function-call", "functioncall"):
            name = obj.get("name") or obj.get("function") or obj.get("func") or "unknown"
            args = obj.get("arguments") or obj.get("args") or obj.get("parameters") or {}
            formatted = _format_tool_call(name, args)
            if dropping_leading_preamble and not transcript_started:
                continue
            append_output(f"ASSISTANT:\n  {formatted}")
            continue
        
        # Function call output
        if typ in ("function_call_output", "function-output", "functionoutput"):
            if not include_tool_results:
                continue

            name = obj.get("name") or obj.get("function") or "tool"
            content = _flatten_text(obj.get("output") or obj.get("content") or obj.get("result"))
            is_error = bool(obj.get("error") or obj.get("is_error") or obj.get("isError"))
            formatted = _format_tool_result(name, is_error, content, max_lines=max_lines, max_chars=max_chars)
            if dropping_leading_preamble and not transcript_started:
                continue
            append_output(formatted)
            continue
        
        # Response items (Codex uses payload wrapper)
        if typ == "response_item":
            payload = obj.get("payload", {})
            if not isinstance(payload, dict):
                continue
            
            msg_type = payload.get("type")
            role = payload.get("role", "")
            content = payload.get("content", [])
            
            if role == "user" or msg_type == "user":
                text = normalize_leading_text(_flatten_text(content))
                if text:
                    append_output(f"USER: {text}")
            
            elif role == "assistant" or msg_type == "assistant":
                text_parts = []
                tool_parts = []
                
                if isinstance(content, list):
                    for item in content:
                        if not isinstance(item, dict):
                            continue
                        itype = item.get("type", "")
                        
                        if itype in ("text", "output_text"):
                            t = item.get("text", "")
                            if t and isinstance(t, str):
                                text_parts.append(t.strip())
                        
                        elif itype == "tool_use" or itype == "function_call":
                            name = item.get("name") or item.get("function") or "tool"
                            args = item.get("input") or item.get("arguments") or {}
                            formatted = _format_tool_call(name, args)
                            tool_parts.append(f"  {formatted}")
                
                elif isinstance(content, str):
                    text_parts.append(content)
                
                if text_parts or tool_parts:
                    lines = []
                    if text_parts:
                        text = "\n".join(text_parts)
                        text_lines = text.split("\n")
                        lines.append(f"ASSISTANT: {text_lines[0]}")
                        lines.extend(f"   {l}" for l in text_lines[1:] if l.strip())
                    if tool_parts:
                        if not text_parts:
                            lines.append("ASSISTANT:")
                        lines.extend(tool_parts)
                    rendered = normalize_leading_text("\n".join(lines)) if not transcript_started else "\n".join(lines)
                    if rendered:
                        append_output(rendered)
            continue
        
        # Generic message handling
        role, text = _extract_role_and_text(obj)
        if role == "user" and text:
            # Skip system blocks
            rendered = normalize_leading_text(text)
            if rendered:
                append_output(f"USER: {rendered}")
        elif role == "assistant" and text:
            if dropping_leading_preamble and not transcript_started:
                continue
            append_output(f"ASSISTANT: {text}")
    
    return output


def _find_default_root() -> Optional[Path]:
    candidates = [
        Path(os.path.expanduser("~/.codex/sessions")),
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
        description="Diagnostic view of Codex sessions - shows tool calls, edits, errors"
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
            print("No Codex sessions root found", file=sys.stderr)
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
