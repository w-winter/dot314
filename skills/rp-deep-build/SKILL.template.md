---
disable-model-invocation: true
name: rp-deep-build
description: Plan, approve, implement, validate, run a maintainability gate, then perform a convergence-gated core review with scope checkpoints
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
{% if skip_maintainability === true %}
{% set maintainability_enabled = false %}
{% else %}
{% set maintainability_enabled = true %}
{% endif %}
{% set ticket = args | join(" ") %}

# Full RepoPrompt Build Loop

Planner: `{{ planner_mode }}`
Executor: `{{ executor_mode }}`
{% if maintainability_enabled %}
Maintainability: `enabled`
{% else %}
Maintainability: `skipped`
{% endif %}
Ticket: {{ ticket }}

Invocation:

```text
/skill:rp-deep-build [--planner=deep|build] [--executor=auto|direct|orchestrate] [--skip-maintainability] -- <ticket>
```

`planner` defaults to `deep`. `executor` defaults to `auto`. The maintainability gate runs by default; `--skip-maintainability` is its only opt-out. Use the `--` sentinel so ticket text that begins with `--` remains part of the ticket. The parsed Planner, Executor, Maintainability, and Ticket values above are authoritative; the raw invocation appended after the skill envelope is not additional task content.

{% if planner_mode != "build" and planner_mode != "deep" %}
## Configuration error

Unsupported planner `{{ planner_mode }}`. Use `build` or `deep`. Do not create a goal, plan, edit files, or act on the trailing raw invocation.
{% elif executor_mode != "auto" and executor_mode != "direct" and executor_mode != "orchestrate" %}
## Configuration error

Unsupported executor `{{ executor_mode }}`. Use `auto`, `direct`, or `orchestrate`. Do not create a goal, plan, edit files, or act on the trailing raw invocation.
{% elif skip_maintainability and skip_maintainability !== true %}
## Configuration error

`--skip-maintainability` takes no value, but it received `{{ skip_maintainability }}`. Written without the `--` sentinel it also swallows the first ticket word. Pass it as a bare flag before `--`, or omit it to run the maintainability gate. Do not create a goal, plan, edit files, or act on the trailing raw invocation.
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
{% if maintainability_enabled %}
- running exactly one focused maintainability discovery pass through the `Maintainability-Review` Oracle preset, adjudicating every finding, resolving every verified in-scope blocker, and obtaining approval for any required scope or plan revision before implementing it
{% endif %}
- running complete core Review Oracle passes, adjudicating every finding against the approved scope, fixing only verified in-scope blockers, and continuing automatically for at most four passes while the patch demonstrably converges within its approved boundary
- stopping for explicit user direction instead of expanding scope or continuing review when a finding requires a plan revision, the Oracle returns `Major Rethink`, convergence fails, or blockers remain after the fourth pass
- mapping every ticket requirement, approved plan item, validation result, every maintainability finding and its adjudication when enabled, every core-review finding and its adjudication, and the convergence-gated review outcome to fresh evidence before calling `update_goal`

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

Present the authoritative plan, its path, the configured executor mode, whether the default maintainability gate will run, and the selected or recommended execution route through `interview`. Also present the expected implementation boundary: the modules or targets involved, any new mechanism or public contract, and the planned file set when the plan identifies one. This boundary is not an exact file lock, but adding a production subsystem, public contract, state machine, ownership or lifecycle protocol, or other implementation responsibility that the plan does not describe requires renewed approval.

- For `auto`, offer: approve the plan with the recommended route; approve with direct implementation; approve with orchestrated implementation; or request plan revisions.
- For `direct` or `orchestrate`, offer: approve the plan and configured route; or request plan revisions.

Do not implement until the user approves both the plan and route. If the user overrides an `auto` recommendation, record the approved route without reopening or narrowing the plan.

If revisions are requested, apply direct plan edits when feedback only changes the existing plan. Rerun the appropriate selected-planner phases when feedback requires repository discovery, architectural reconsideration, or a new Oracle plan pass. Serialize and audit the revised authoritative plan, recalculate the `auto` route recommendation when applicable, and present it for approval again. Repeat until approved.

## Phase 4: Implement every approved plan item

Track every original approved plan item and its completion evidence in the authoritative plan. Grouping or delegation may organize the work but must never replace the original plan as the scope contract. During implementation, stop before editing when the next change would cross the approved implementation boundary, then obtain approval for a revised plan and route.

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

Before review, inspect `git status` and the complete diff footprint. Map every changed file and affected production module to the approved plan. Test updates, documentation, and mechanically required callers may extend the planned file list when they preserve the approved design. Treat the footprint as a scope change when it adds a production subsystem, public contract, state machine, ownership or lifecycle protocol, or other implementation responsibility that the approved plan did not describe, or when changed production files cannot be mapped directly to an approved item and its necessary integration. Stop and ask the user whether to simplify, revise the plan and route, or abandon the patch; do not use review to legitimize scope drift.

## Phase 6: Run the maintainability gate

{% if maintainability_enabled %}
First, call `oracle_utils` with `op: "models"` and confirm that the review-only model preset named exactly `Maintainability-Review` is available. If it is absent, stop and report that this phase requires a review-only model preset named exactly `Maintainability-Review` whose review mode maps to the maintainability Chat preset; do not substitute the ordinary Review model or Chat preset.

Run exactly one fresh maintainability discovery pass against all uncommitted changes versus `HEAD`:

1. Call `context_builder` exactly once with `response_type: "clarify"` to curate selection only. Give it the exact path to the authoritative serialized plan `.md` and direct it to read and include the complete plan file in the selection. Its instructions must also identify the Ticket, require coverage of every changed or untracked file plus the adjacent ownership, invariant, test, and canonical-utility context needed to assess maintainability, and state that the next step is a direct `Maintainability-Review` Oracle review. Do not request or accept a review response from `context_builder`.
2. Verify the resulting selection against `git status` and the complete uncommitted diff. Add any omitted changed or untracked implementation, test, or documentation file before reviewing; the review scope must remain the complete patch versus `HEAD`.
3. Call `oracle_send` exactly once with `mode: "review"`, `model: "Maintainability-Review"`, and `new_chat: true`. Its message must name the Ticket, comparison scope, and exact authoritative plan path, and request its full maintainability review. That preset supplies the review contract as the Oracle’s system prompt, so do not restate or summarize that contract in the message.

Do not use `context_builder` with `response_type: "review"` for this phase: that path uses RepoPrompt’s built-in Review system prompt rather than the `Maintainability-Review` Chat preset. A focused source check or Oracle follow-up that clarifies an identified finding is allowed; a second open-ended maintainability review is not.

The review classifies each finding under one of the headings below. Adjudicate every reported item by its heading:

- Fix each verified finding classified as `In-scope implementation fix` when it is required by the approved plan or prevents a correctness or maintainability regression caused by the patch. Add or confirm tests that pin the intended behavior before restructuring. Record optional restructuring as a `Non-blocking opportunity` rather than treating it as mandatory work.
- For `Scope or plan revision required`, verify the finding against the Ticket, source, and approved plan. If it remains valid, revise the authoritative plan, recalculate the execution route when affected, and obtain explicit user approval of the revised plan and route through `interview` before implementing the change. Close a rejected or inapplicable finding only with concrete contrary evidence.
- Resolve `Needs more context` items only through focused investigation of the named missing fact; do not restart broad maintainability discovery.
- Record `Non-blocking opportunities` and `Pre-existing issues` separately. Do not expand the approved scope merely to implement them.

The goal-bound agent owns each accepted correction: fix bounded findings directly, or, when an orchestrated route’s child context is materially useful for a substantial finding, steer the responsible child or dispatch a bounded correction under the canonical orchestrator protocol. After all accepted fixes or approved plan revisions are implemented, rerun every applicable validation and record the evidence-based adjudication of every maintainability finding. Do not invoke the maintainability gate a second time; the final core review examines the resulting patch.
{% else %}
`--skip-maintainability` was supplied. Skip the specialized maintainability pass and proceed directly to the convergence-gated core review.
{% endif %}

## Phase 7: Run the convergence-gated core review

Run the complete canonical `rp-review` workflow against all uncommitted changes versus `HEAD`. Its `context_builder` instructions must give the exact path to the authoritative serialized plan `.md`, direct the builder to read and include that plan file in the selection, and name the Ticket, approved implementation boundary, and comparison scope.

Adjudicate findings against the diff, source, and approved plan using the categories returned by the review. Fix only verified `Blocking` findings that remain inside the approved boundary. Record `Non-blocking` and `Pre-existing` findings without implementing them. A `Scope or plan revision required` finding or `Major Rethink` verdict stops automatic work and requires the user to choose simplification, plan revision, or abandonment.

After each non-`Ship` pass, update a concise ledger in the authoritative plan with each finding’s stable identifier, category, severity, disposition, correction, and validation evidence. Rerun applicable validation and the Phase 5 footprint audit after corrections. For every later pass, use a fresh `context_builder` request that repeats the exact plan path and instruction to include the complete plan in its selection, and supplies the current footprint and ledger.

Continue automatically for at most four core-review passes while corrections stay inside the approved boundary, accepted blockers are corrected and validated, and the review is converging. Convergence fails after two consecutive passes in which neither blocker count nor highest severity improves, or when repeated findings show that the chosen mechanism itself is unstable. Each `rp-review` execution counts as one pass, including at most one focused gap-fill review; focused investigation or clarification of an existing finding does not count as another pass.

An exact standalone `Ship` ends the loop immediately. At a convergence stop or after pass four, present the ledger to the user. If no `Blocking` or `Scope or plan revision required` finding remains and the verdict is not `Major Rethink`, the user may accept the evidence-based result without exact `Ship`; otherwise offer simplification, an approved plan revision, one additional named correction-and-review cycle, or abandonment. A plan revision establishes a new boundary and review sequence; an additional cycle authorizes only its named corrections and one fresh review pass.

## Phase 8: Completion audit

Before calling `update_goal`, map all of the following to fresh evidence from files, diffs, commands, tests, screenshots, artifacts, child-session results, or logs:

- every Ticket requirement
- every original approved plan item and acceptance criterion
- the approved execution route and completion of all direct or delegated work
- every validation requirement and result
{% if maintainability_enabled %}
- the single maintainability discovery pass through `Maintainability-Review`, every finding and its evidence-backed adjudication, every accepted correction, any required plan reapproval, and the resulting validation
{% endif %}
- every core Review Oracle finding, its evidence-backed adjudication, every accepted correction, and the number of core-review passes performed
- the terminal review evidence: either the exact standalone `Ship` verdict or the user's explicit acceptance of an evidence-backed adjudication that no `Blocking` or `Scope or plan revision required` finding remains
- every user approval for a scope or plan revision or additional named correction-and-review cycle

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
