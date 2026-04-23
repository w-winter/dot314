#!/bin/sh
set -eu

EMBED=false
if [ "${1:-}" = "--embed" ]; then
  EMBED=true
  shift
fi
if [ "$#" -ne 0 ]; then
  echo "usage: $(basename "$0") [--embed]" >&2
  exit 2
fi

QMD="${HOME}/.local/bin/qmd22"
SESSION_VIEW="${HOME}/.pi/agent/skills/text-search/scripts/session-view"
COLLECTION_NAME="sessions"
SRC="${HOME}/agent-sessions-all"
DST="${HOME}/.cache/qmd-sessions-rendered"

mkdir -p "$DST"

export SESSION_VIEW SRC DST
uv run python - <<'PY'
from pathlib import Path
import os
import subprocess
import tempfile

session_view = Path(os.environ['SESSION_VIEW'])
agent_sessions_root = Path(os.environ['SRC'])
dst = Path(os.environ['DST'])

MAX_PART_CHARS = 120_000
MAX_OUTPUT_FILE_CHARS = MAX_PART_CHARS + 4_000

if not session_view.exists():
    raise SystemExit(f'missing session-view at {session_view}')
if not agent_sessions_root.exists():
    raise SystemExit(f'missing source corpus at {agent_sessions_root}')


def detect_format(relative_path: str) -> str:
    if relative_path.startswith('pi/'):
        return 'pi'
    if relative_path.startswith('claude/'):
        return 'claude'
    if relative_path.startswith('codex/'):
        return 'codex'
    return ''


def should_skip(relative_path: str) -> bool:
    return '/subagents/agent-acompact-' in f'/{relative_path}'


def part_path(output_path: Path, index: int) -> Path:
    return output_path.parent / f'{output_path.stem}.part-{index:03d}.md'


def existing_output_paths(output_path: Path) -> list[Path]:
    single = [output_path] if output_path.exists() else []
    parts = sorted(output_path.parent.glob(f'{output_path.stem}.part-*.md'))
    return single + parts


def needs_rerender(source_path: Path, output_path: Path) -> bool:
    paths = existing_output_paths(output_path)
    if not paths:
        return True
    if any(path.stat().st_mtime < source_path.stat().st_mtime for path in paths):
        return True

    single_exists = output_path.exists()
    parts = [path for path in paths if path != output_path]

    if single_exists and parts:
        return True
    if single_exists and output_path.stat().st_size > MAX_OUTPUT_FILE_CHARS:
        return True
    if any(path.stat().st_size > MAX_OUTPUT_FILE_CHARS for path in parts):
        return True

    return False


def split_oversized_block(block: str) -> list[str]:
    if len(block) <= MAX_PART_CHARS:
        return [block]

    lines = block.splitlines()
    pieces: list[str] = []
    current: list[str] = []
    current_len = 0

    for line in lines:
        if len(line) > MAX_PART_CHARS:
            if current:
                pieces.append('\n'.join(current))
                current = []
                current_len = 0
            start = 0
            while start < len(line):
                pieces.append(line[start:start + MAX_PART_CHARS])
                start += MAX_PART_CHARS
            continue

        addition = len(line) + (1 if current else 0)
        if current and current_len + addition > MAX_PART_CHARS:
            pieces.append('\n'.join(current))
            current = [line]
            current_len = len(line)
            continue
        current.append(line)
        current_len += addition

    if current:
        pieces.append('\n'.join(current))

    return pieces


def split_rendered_text(text: str) -> list[str]:
    if len(text) <= MAX_PART_CHARS:
        return [text]

    blocks: list[str] = []
    for block in text.split('\n\n'):
        block = block.strip('\n')
        if not block:
            continue
        blocks.extend(split_oversized_block(block))

    parts: list[str] = []
    current: list[str] = []
    current_len = 0

    for block in blocks:
        addition = len(block) + (2 if current else 0)
        if current and current_len + addition > MAX_PART_CHARS:
            parts.append('\n\n'.join(current) + '\n')
            current = [block]
            current_len = len(block)
            continue
        current.append(block)
        current_len += addition

    if current:
        parts.append('\n\n'.join(current) + '\n')

    return parts


def write_output(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', delete=False, dir=path.parent, suffix='.tmp') as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    temp_path.replace(path)


expected_outputs: set[Path] = set()
rendered = 0
skipped = 0
unchanged = 0
failed = 0

all_sessions = []
for entry in sorted(agent_sessions_root.iterdir()):
    if entry.name.startswith('.') or not entry.is_dir():
        continue
    resolved = entry.resolve()
    for path in resolved.rglob('*.jsonl'):
        rel = Path(entry.name) / path.relative_to(resolved)
        all_sessions.append((path, rel))
all_sessions.sort(key=lambda item: str(item[1]))

for source_path, rel in all_sessions:
    relative_path = rel.as_posix()

    if should_skip(relative_path):
        skipped += 1
        continue

    output_path = dst / f'{relative_path}.md'

    if not needs_rerender(source_path, output_path):
        expected_outputs.update(existing_output_paths(output_path))
        unchanged += 1
        continue

    session_format = detect_format(relative_path)
    command = [str(session_view), str(source_path)]
    if session_format:
        command.append(session_format)

    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as error:
        stderr = (error.stderr or '').strip()
        if stderr.startswith('No conversation found'):
            skipped += 1
            continue
        failed += 1
        print(f'WARN failed to render {relative_path}: {error}', flush=True)
        if stderr:
            print(stderr, flush=True)
        continue

    parts = split_rendered_text(result.stdout)

    output_paths = [output_path] if len(parts) == 1 else [part_path(output_path, index) for index in range(1, len(parts) + 1)]
    expected_outputs.update(output_paths)

    for index, (path, part_text) in enumerate(zip(output_paths, parts), start=1):
        header = (
            '---\n'
            f'original_session: {source_path}\n'
            f'relative_session: {relative_path}\n'
            f'session_format: {session_format or "auto"}\n'
            'rendered_by: session-view\n'
            'include_tool_results: false\n'
            f'render_part_index: {index}\n'
            f'render_part_count: {len(parts)}\n'
            '---\n\n'
        )
        write_output(path, header + part_text)

    rendered += 1

for rendered_path in sorted(dst.rglob('*.md')):
    if rendered_path not in expected_outputs:
        rendered_path.unlink()

for directory in sorted((path for path in dst.rglob('*') if path.is_dir()), reverse=True):
    if not any(directory.iterdir()):
        directory.rmdir()

print(f'Rendered {rendered} session(s)')
print(f'Unchanged {unchanged} session(s)')
print(f'Skipped {skipped} session(s) with no renderable conversation or excluded compact subagents')
if failed:
    print(f'WARN {failed} session(s) failed to render', flush=True)
PY

COLLECTION_INFO=$("$QMD" collection show "$COLLECTION_NAME" 2>/dev/null || true)
if [ -z "$COLLECTION_INFO" ]; then
  "$QMD" collection add "$DST" --name "$COLLECTION_NAME"
elif printf '%s\n' "$COLLECTION_INFO" | grep -F "Path:     $DST" >/dev/null && \
     printf '%s\n' "$COLLECTION_INFO" | grep -F "Pattern:  **/*.md" >/dev/null; then
  "$QMD" update
else
  echo "sessions collection is not yet migrated to rendered markdown" >&2
  echo "run these one-time commands first:" >&2
  echo "  qmd collection remove sessions" >&2
  echo "  qmd collection add '$DST' --name sessions" >&2
  exit 2
fi

if [ "$EMBED" = true ]; then
  "$QMD" embed
else
  "$QMD" status
fi
