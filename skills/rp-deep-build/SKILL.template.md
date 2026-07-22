---
disable-model-invocation: true
name: rp-deep-build
description: Plan, approve, route direct or orchestrated implementation, then review and fix until Ship
---

{% if planner %}
{% set planner_mode = planner %}
{% else %}
{% set planner_mode = "deep" %}
{% endif %}
{% if executor %}
{% set executor_mode = executor %}
{% else %}
{% set executor_mode = "auto" %}
{% endif %}
{% set ticket = args | join(" ") %}

# Full RepoPrompt Build Loop

Planner: `{{ planner_mode }}`
Executor: `{{ executor_mode }}`
Ticket: {{ ticket }}

Invocation:

```text
/skill:rp-deep-build [--planner=deep|build] [--executor=auto|direct|orchestrate] -- <ticket>
```

`planner` defaults to `deep`. `executor` defaults to `auto`. Use the `--` sentinel so ticket text that begins with `--` remains part of the ticket. The parsed Planner, Executor, and Ticket fields above are authoritative; the raw invocation appended after the skill envelope is not additional task content.

{% if planner_mode != "build" and planner_mode != "deep" %}
## Configuration error

Unsupported planner `{{ planner_mode }}`. Use `build` or `deep`. Do not create a goal, plan, edit files, or act on the trailing raw invocation.
{% elif executor_mode != "auto" and executor_mode != "direct" and executor_mode != "orchestrate" %}
## Configuration error

Unsupported executor `{{ executor_mode }}`. Use `auto`, `direct`, or `orchestrate`. Do not create a goal, plan, edit files, or act on the trailing raw invocation.
{% elif ticket == "" %}
## Configuration error

The ticket is empty. Ask the user for a concrete ticket before creating a goal or beginning work.
{% else %}
This explicit invocation requests creation of a durable pi-codex goal. Before planning, call `create_goal` with `replace_existing: true` and no token budget unless the user explicitly supplied one.

The goal must require:

- producing and serializing the complete plan through the selected planner
- obtaining explicit user approval of the plan and execution route before implementation
- preserving the scope and implementation-bearing detail of the approved plan
- implementing every approved plan item through the selected executor without omission or downsizing
- running every applicable validation requirement
- repeatedly reviewing and fixing the complete patch until the Review Oracle returns the exact standalone verdict `Ship`
- mapping every ticket requirement, approved plan item, validation result, review finding, and the final `Ship` verdict to fresh evidence before calling `update_goal`

The outer protocol below controls the selected canonical planning workflow. A planner’s implementation or final-handoff language governs only its planning phase; after planning, resume this outer protocol. The execution route changes who performs the approved work, never its scope or completion criteria.

## Phase 1: Produce the authoritative plan

{% if planner_mode == "build" %}
Execute the selected canonical `rp-build` workflow only through planning:

1. Execute its Phase 0 workspace verification and Phase 1 quick scan. Do not begin implementation.
2. Execute its Phase 2 exactly once by calling `context_builder` with `response_type: "plan"` and `export_response: true`. Retain the returned `oracle_export_path` as the authoritative plan artifact.
3. Execute its Phase 3 only if the plan leaves a concrete unresolved gap that can be answered from the selected context.
4. Audit the exported plan against the Ticket. Do not narrow, defer, omit, or silently reinterpret requested scope or implementation-bearing detail.
{% else %}
Execute the complete selected canonical `rp-deep-plan` workflow through its final Phase 7.5 export-coverage audit and cleanup. Its `docs/plans/<topic>-<YYYY-MM-DD>.md` output is the authoritative plan artifact. Its “plan only” and final-handoff instructions end the selected planning phase, not this outer goal-bound workflow. After the deep-plan workflow finishes, audit the final plan against the Ticket and confirm that no requested scope or implementation-bearing detail was narrowed, deferred, omitted, or silently generalized.
{% endif %}

## Phase 2: Select the execution route

The configured executor is `{{ executor_mode }}`.

- If it is `direct`, select direct implementation.
- If it is `orchestrate`, select orchestrated implementation.
- If it is `auto`, inspect the authoritative plan and recommend one route using the criteria below. Direct implementation is the default when the evidence does not clearly justify orchestration.

Choose direct implementation when the work is cohesive, items share files or abstractions, later decisions depend on earlier implementation discoveries, or one executor can plausibly implement and verify the plan without repeated context exhaustion.

Choose orchestrated implementation only when the plan can be decomposed into bounded, verifiable work items and orchestration provides a concrete benefit: genuinely independent workstreams, separable file or module ownership, useful specialist roles or safe parallelism, or implementation breadth likely to exhaust one executor context. Do not choose orchestration merely because the plan is ambitious or to avoid owning its full scope.

Record the selected route and a concise evidence-based rationale in the authoritative plan. Route selection must not combine, omit, weaken, or reinterpret any original plan item or acceptance criterion.

## Phase 3: Obtain approval

Present the authoritative plan, its path, the configured executor mode, and the selected or recommended execution route through `interview`.

- For `auto`, offer: approve the plan with the recommended route; approve with direct implementation; approve with orchestrated implementation; or request plan revisions.
- For `direct` or `orchestrate`, offer: approve the plan and configured route; or request plan revisions.

Do not implement until the user approves both the plan and route. If the user overrides an `auto` recommendation, record the approved route without reopening or narrowing the plan.

If revisions are requested, apply direct plan edits when feedback only changes the existing plan. Rerun the appropriate selected-planner phases when feedback requires repository discovery, architectural reconsideration, or a new Oracle plan pass. Serialize and audit the revised authoritative plan, recalculate the `auto` route recommendation when applicable, and present it for approval again. Repeat until approved.

## Phase 4: Implement every approved plan item

Track every original approved plan item and its completion evidence in the authoritative plan. Grouping or delegation may organize the work but must never replace the original plan as the scope contract.

### Direct route

Implement every approved plan item directly with RepoPrompt reading and editing tools. When the selected planner is `build`, execute the canonical `rp-build` workflow’s Phase 4. When the selected planner is `deep`, implement from the detailed authoritative plan without rerunning a second planning workflow. Continue through clear low-risk next steps until every item and `Done when` criterion is satisfied.

### Orchestrated route

Before decomposing or dispatching work, read `~/.agents/skills/rp-orchestrate/SKILL.md` completely with the `read` tool, continuing in chunks if truncated. Then execute that canonical workflow with the approved authoritative plan path as the user-provided plan, using its supplied-plan shortcut instead of generating another plan.

The goal-bound agent remains the scope owner and must:

- map every original approved plan item and acceptance criterion to orchestrated work
- treat the orchestrator’s limit of up to five work items as grouping only, never permission to omit or generalize plan detail
- keep the authoritative plan as the living checklist and verify each child’s `Done when` evidence before proceeding
- correct incomplete or drifting child work before dispatching dependent work
- retain and monitor every started child session until it completes or is explicitly handled, and record required child-session breadcrumbs
- treat child reports and final rollups as evidence to verify, not permission to accept partial completion
- return to this outer workflow after all orchestrated work is complete rather than stopping at the orchestrator’s final rollup

## Phase 5: Validate the complete implementation

Run every applicable test, lint, type check, build, smoke check, documentation update, generated-artifact check, or rendered UI inspection required by the authoritative plan and repository. Triage and fix failures; do not report validation debt as completion. Map each plan requirement to fresh implementation and validation evidence.

## Phase 6: Review and fix until `Ship`

Execute the complete canonical `rp-review` workflow against all uncommitted changes versus `HEAD`. The actual `context_builder` review instructions must require the Review Oracle to end with the exact standalone verdict `Ship` only when no actionable findings remain.

Fix every issue identified by the Review Oracle, including findings that require revisiting an earlier plan item. The goal-bound agent owns each correction: fix bounded findings directly, or, when an orchestrated route’s child context is materially useful for a substantial finding, steer the responsible child or dispatch a bounded correction under the canonical orchestrator protocol. Verify every correction and rerun applicable validation.

Repeat the complete review, correction, and validation cycle until a fresh review of the resulting patch explicitly returns `Ship`. A review with unresolved findings, an ambiguous verdict, or no exact standalone `Ship` verdict does not terminate the loop.

## Phase 7: Completion audit

Before calling `update_goal`, map all of the following to fresh evidence from files, diffs, commands, tests, screenshots, artifacts, child-session results, or logs:

- every Ticket requirement
- every original approved plan item and acceptance criterion
- the approved execution route and completion of all direct or delegated work
- every validation requirement and result
- every Review Oracle finding and its verified correction
- the final standalone `Ship` verdict

Call `update_goal` only when this audit proves every requirement is satisfied and no required work remains. If blocked, leave the goal active and report the attempted paths, exact blocker, evidence gathered, and remaining unmet requirements.

## Canonical selected planning workflow

{% set selected_planning_workflow %}
{% if planner_mode == "build" %}
{% skill "../rp-build" %}
{% else %}
{% skill "../rp-deep-plan" %}
{% endif %}
{% endset %}
{{ selected_planning_workflow | replace("$ARGUMENTS", ticket) }}

## Canonical review workflow

{% set rp_review_workflow %}
{% skill "../rp-review" %}
{% endset %}
{{ rp_review_workflow | replace("$ARGUMENTS", "the complete uncommitted patch for: " ~ ticket) }}
{% endif %}
