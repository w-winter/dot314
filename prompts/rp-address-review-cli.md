---
description: Address issues surfaced by code review(s) and log work (rp-cli)
argument-hint: [plan||log||todos||tasks = <path-to-plan-or-tasks-log.md>] [reviews = <path_to_review_feedback.md> <possible_additional_path_to_extra_review_feedback.md> <...>]
---

ARGUMENTS: $ARGUMENTS

The executed tasks of plan/log/todos/tasks mentioned by the user in ARGUMENTS were reviewed by one or more panels of code reviewers. They gave the feedback logged in the one or more review feedback files mentioned by the user in ARGUMENTS.

## Using rp-cli

Run RepoPrompt CLI commands like this:

```bash
rp-cli -e '<command>'
```

### Important: use `rp_exec` if your harness is Pi:

In the Pi coding agent harness, use `rp_exec` and treat snippets as the cmd string (drop the `rp-cli -e` prefix); only use `rp-cli -e` in a shell fallback.

## Protocol

1. Read every (one or more) review feedback file that the user mentions in ARGUMENTS
2. Address all issues mentioned in every review feedback file mentioned
   - Use RepoPrompt context-building and planning commands when the reviewers' suggestions are not precise/thorough/clear enough
     - `rp-cli -e 'builder "instructions" --response-type plan'` (rebuild context + get a plan)
     - `plan "<question>"` / `chat "<question>"` for targeted follow-ups
     - If you ran `builder` and got a `chat_id`, continue the same thread with: `chat "<followup>" --chat-id <chat_id>`
3. Update an Appendix section at the end of the user-mentioned plan/log/todos/tasks file that captures this additional work you've just done to address all those issues.  If such an Appendix doesn't exist, create it.
