---
description: Address issues surfaced by code review(s) and log work
argument-hint: [plan||log||todos||tasks = <path-to-plan-or-tasks-log.md>] [reviews = <path_to_review_feedback.md> <possible_additional_path_to_extra_review_feedback.md> <...>]
---

ARGUMENTS: $ARGUMENTS

The executed tasks of plan/log/todos/tasks mentioned by the user in ARGUMENTS were reviewed by one or more panels of code reviewers.  They gave the feedback logged in the one or more review feedback files mentioned by the user in ARGUMENTS.

## Protocol

1. Read every (one or more) review feedback file that the user mentions in ARGUMENTS.
2. Address all the issues mentioned in every review feedback file mentioned. Use all RepoPrompt context-building and planning tools (e.g. `context_builder instructions="…" [response_type="plan"]`) that you may need if the reviewers' suggestions are not precise/thorough/clear enough.
3. Update an Appendix section at the end of the user-mentioned plan/log/todos/tasks file that captures this additional work you've just done to address all those issues.  If such an Appendix doesn't exist, create it.