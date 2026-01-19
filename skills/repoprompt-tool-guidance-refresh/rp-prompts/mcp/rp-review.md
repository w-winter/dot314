---
description: RepoPrompt diff review
---

# Send RepoPrompt Chat in Review Mode

Request: $ARGUMENTS

Goal: send a RepoPrompt `chat_send` with `mode="review"` to review diffs, in a fast and token-efficient way, while optionally adding extra context files (even if unchanged) and passing user notes verbatim.

RepoPrompt `mode="review"`: analyzes code changes using git diffs of the selected files; it only sees the current selection/context.

CRITICAL: Be swift and token-efficient
- Do NOT run `git diff` to read diff contents
- Do NOT paste any diff text into the chat message
- Do NOT “line-by-line” review diff output in your own scratchpad
- Rely on RepoPrompt review mode with `include_diffs=true` to supply diffs for the selected files automatically

## 1) Infer diff scope (no diff reading)
Prefer explicit user intent if present:
- If $ARGUMENTS includes a literal `git diff ...` snippet, use that as the diff scope identifier (do not execute it for content).
- Else if it clearly says “staged”, treat scope as staged.
- Else if it clearly says “unstaged / working tree”, treat scope as unstaged.
- Else if it clearly says “both staged and unstaged”, treat scope as both.
- Else if it includes a range like `main..HEAD` / `HEAD~3..HEAD`, treat scope as that range.
- Else default: staged if there are staged changes, otherwise unstaged.

## 2) Select review files (name-only only)
- If the user explicitly names one or more file paths in $ARGUMENTS, select exactly those files (as review scope).
- Otherwise, derive review scope paths using ONLY name-only commands (never full patch output):
  - staged: `git diff --staged --name-only`
  - unstaged: `git diff --name-only`
  - range: `git diff <range> --name-only`
  - both: union staged + unstaged name-only lists

## 3) Add optional context files (unchanged allowed)
- Also include any additional file paths mentioned in $ARGUMENTS that the user likely wants as guidance/context, even if unchanged.
- Context files should be added to selection but should NOT change the diff scope; they’re for the reviewer to read alongside the diffs.

## 4) Build RepoPrompt selection (must be resolvable)
- `selected_paths` = unique(review files ∪ context files), but include only paths that exist in the working tree.
- If a referenced path doesn’t exist, mention it in the message and continue (do not block).

## 5) Send the review chat (no diff pasted)
```
mcp__RepoPrompt__chat_send:
  new_chat: true
  chat_name: "Review: <name based on context>"
  mode: review
  include_diffs: true
  selected_paths: [<selected_paths>]
  message: |
    Review the diffs for the selected files, and if there is a selected file that does not have diffs, use it as context for interpreting the diffs.

    Additional user notes (if any): <additional notes provided by user, if provided in $ARGUMENTS>
```
