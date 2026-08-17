# grounded-compaction

This extension can play two roles:
* Replace Pi's compaction summarizer with configurable model presets, custom summarization prompt contracts, and deterministic files-touched tracking that covers Pi native tools, RepoPrompt, recognized shell operations, and Codex `apply_patch`
* Augment branch summarization during `/tree` with the same files-touched grounding and optional replacement of the summarization prompt contract with a custom one

> ⚠ **May conflict with other compaction extensions**: this extension hooks `session_before_compact` and returns a custom compaction result.  Any other extension that does the same is incompatible.  Having both active creates a race condition where the last handler to respond wins.  Enable only one.

## Why

Pi's native compaction [deterministically tracks](https://github.com/badlogic/pi-mono/blob/629341c18f3482d891b665a844975096b47b4779/packages/coding-agent/src/core/compaction/utils.ts#L74-L79) file activity from its built-in `read`, `write`, and `edit` tool calls.  Operations through shell commands or custom tools like RepoPrompt are invisible to it.  This extension uses a [shared collector](../../../packages/pi-files-touched/README.md) (`extensions/_shared/files-touched-core.ts`) that also covers RepoPrompt tools (`read_file`, `apply_edits`, `file_actions`, `git mv/rm`), recognized shell patterns through `bash` and `exec_command`, structured `apply_patch` changes, and normalizes all path spellings so the same file appears once regardless of how different tools referred to it.

Since compaction also [serializes messages to text](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md#message-serialization) before summarizing, which entails that there is no prefix-cache opportunity cost to routing compaction to a cheaper or faster model, you may want to be able to do that sometimes or as a default policy.  The "presets" grant that option.

## Compaction and branch summarization

For background on Pi's compaction lifecycle, see the [compaction docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md).  Branch summarization is the summary generated when navigating `/tree` — effectively compaction in any direction across the session tree, rather than just forward along a session's chronology.  This extension augments both.

## Files

- **Config**: `config.json` (see `config.json.example` for presets)
- **Compaction prompt**: `compaction-prompt.md` (falls back to default embedded in [`index.ts`](index.ts) if blank or missing)
- **Branch-summary prompt**: `branch-summary-prompt.md` (falls back to Pi's stock branch summarization prompt if blank or missing)
- Examples: `compaction-prompt.md.example`, `branch-summary-prompt.md.example`

## Config

```json
{
  "includeFilesTouched": {
    "inCompactionSummary": true,
    "inBranchSummary": true
  },
  "toolResultChars": null,
  "defaultPreset": "current",
  "presets": {}
}
```

### `includeFilesTouched`

Controls files-touched grounding per feature.  Accepts `true`, `false`, or an object with both fields required:

```json
{ "inCompactionSummary": true, "inBranchSummary": false }
```

Boolean applies to both; omitted defaults to both enabled.

For compaction, the manifest is passed into the summarizer prompt and a cumulative version is appended verbatim to the persisted summary.  For branch summaries, the manifest is injected into the prompt instructions for Pi's native summarizer to reproduce.  In both cases, the manifest also serves as a recall aid for the summarizer itself — file operations buried across many tool calls in a long context are easy to miss without an authoritative inventory.

### `toolResultChars`

Controls how much text from each tool result the summarizer sees. `null` or omission passes the full text through. A positive integer keeps that many characters from the start of each result and appends a note saying how many were dropped. Either way only text is included; images and other non-text tool output are not.

Pi's own compaction keeps 2000 characters of each tool result, which holds summarization cost down and stays workable on models of any context size. Setting `toolResultChars` to `2000` matches that; `null` opts out of it. Keeping more text gives the summarizer better recall of what tools actually returned, at the cost of a larger, more expensive request that is likelier to need `largeContextPreset` (below).

That cost is usually worth paying when the substance of a session lives in tool output rather than in the conversation around it — reading long files, working through test failures, inspecting query results or logs. Two thousand characters is often just the head of a file or the first frames of a stack trace, so a summary built from it can record which files were examined while losing what they contained. The files-touched manifest preserves the paths either way, but only the tool text carries what was in them.

A limit earns its keep in the opposite case: sessions dominated by bulky, low-signal output such as long directory listings, verbose build logs, or repeated large fetches. There the extra text mostly buys request size, and a cap keeps compaction affordable on a smaller default model.

This setting applies to compaction only; summaries created from `/tree` are unaffected.

### `defaultPreset`, `largeContextPreset`, and `presets`

These are compaction-only. `defaultPreset` controls which model runs compaction by default. The optional `largeContextPreset` names one other key in `presets`, used only when a summarization request is too large for the default preset's model; it must name a model Pi has registered with a strictly larger context window.

```json
{
  "defaultPreset": "fast",
  "largeContextPreset": "large",
  "presets": {
    "fast": { "model": "openai-codex/gpt-5.4-mini", "thinkingLevel": "low" },
    "large": { "model": "openai-codex/gpt-5.4", "thinkingLevel": "medium" },
    "deep": { "model": "anthropic/claude-opus-4-6", "thinkingLevel": "high" }
  }
}
```

Compaction measures each summarization request before sending it, counting the prompt contract, the previous summary, your focus text, the files-touched manifest, and the serialized conversation. When a request does not fit the model that would run it, the whole compaction is sent to `largeContextPreset` instead. When Pi splits an oversized turn into two summaries — one for earlier history, one for the beginning of that turn — both run on the same model.

This measures the summarization request, not the session. A long session usually produces a smaller request because compaction summarizes only the span being replaced. A configured `toolResultChars` limit can reduce it further, so a session larger than the summarizer's context window may still compact without rerouting.

`"current"` uses the session's active model and thinking level. An explicit `--preset <name>` or `-p <name>` always overrides `defaultPreset` and never reroutes to `largeContextPreset`. Preset lookup for directives is deterministic: exact match → case-insensitive → prefix → normalized substring.

## `/compact` usage

```text
/compact
/compact focus on parser regressions
/compact --preset cheap
/compact -p deep focus on parser regressions
```

Only a leading `--preset` / `-p` is special; everything after is freeform focus text passed to the summarizer.  `--preset current` / `-p current` explicitly uses the session model even when `defaultPreset` names something else.

## Branch-summary augmentation

During `/tree`, if the user chooses to summarize:

- If `branch-summary-prompt.md` has content, it replaces Pi's stock branch-summary instructions
- If files-touched grounding is enabled, the manifest is injected with instructions to reproduce it verbatim
- If neither is active, the extension does nothing and Pi's stock flow runs unmodified
- On any failure, the extension returns nothing and Pi's stock flow proceeds

The user's freeform focus text from the `/tree` prompt is preserved in either mode.

### Why branch-summary control is narrower than compaction

For compaction, this extension fully owns the LLM call: it can select a different model via presets, control thinking level independently, and manage token budgets.  A session running Opus with a high thinkingLevel can compact cheaply with Gemini Flash.

For branch summaries, Pi's `session_before_tree` hook only exposes prompt instruction overrides.  The extension cannot control model selection, thinking level, or token budgeting for branch summaries without mutating persistent session state.  Native branch summarization always uses the current session model with a fixed `maxTokens` of 2048 and no explicit reasoning level -- the thinking overhead is minimal, but the per-token cost of the base model still applies.  At this time of writing there is no way to select a cheaper model for branch summaries from an extension.

## How compaction summaries are structured

The extension mirrors Pi's stock compaction boundaries: `messagesToSummarize` for history, `turnPrefixMessages` for split-turn prefixes, and `previousSummary` for cumulative updates.  On repeated compactions, that means resuming from the previous compaction's `firstKeptEntryId`, not from the compaction entry itself, and the files-touched manifests follow that same boundary.  When files-touched is enabled, manifests are passed to the summarizer per-span and a cumulative whole-branch manifest is appended to the final persisted summary:

````md
---

## Files touched (cumulative)
R=read, W=write, E=edit, M=move/rename, D=delete

```text
RE src/foo.ts
W  src/bar.ts
```
````

`compaction.details` records the model and thinking level that actually ran:

```ts
{ model: "provider/modelId", thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" }
```

## Failure policy

**Compaction**: if the configured default preset or an explicit `-p` preset cannot be resolved or authenticated, compaction falls back to the session model.

Rerouting to `largeContextPreset` happens only when a request is too large for the model that would otherwise run it. Past that point there is nothing left to fall back to, so compaction is cancelled with a warning rather than handed back to Pi's stock summarizer if `largeContextPreset` is unset, cannot be resolved or authenticated, names a model whose context window is not larger, or still cannot fit the request. A summarization failure after rerouting also cancels.

An explicit `-p` preset cancels if its model cannot fit the request or fails while summarizing. A summarization failure on a compaction that did fit leaves Pi's stock compaction available. Aborts cancel quietly.

**Branch summary**: any failure returns `undefined` with a warning, letting Pi's stock flow proceed.

For npm installation and package-specific docs, see [`packages/pi-grounded-compaction/README.md`](../../packages/pi-grounded-compaction/README.md)
