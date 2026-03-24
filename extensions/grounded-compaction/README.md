# grounded-compaction

This extension can play two roles:
* Replace Pi's compaction summarizer with configurable model presets, custom summarization prompt contracts, and deterministic files-touched tracking that covers Pi native tools, RepoPrompt, and bash-derived file operations
* Augment branch summarization during `/tree` with the same files-touched grounding and optional replacement of the summarization prompt contract with a custom one

## Why

Pi's native compaction [deterministically tracks](https://github.com/badlogic/pi-mono/blob/629341c18f3482d891b665a844975096b47b4779/packages/coding-agent/src/core/compaction/utils.ts#L74-L79) file activity from its built-in `read`, `write`, and `edit` tool calls.  Operations through bash or custom tools like RepoPrompt are invisible to it.  This extension uses a [shared collector](../../../packages/pi-files-touched/README.md) (`extensions/_shared/files-touched-core.ts`) that also covers RepoPrompt tools (`read_file`, `apply_edits`, `file_actions`, `git mv/rm`), bash patterns (`sed -i`, `mv`, `rm`, shell redirections, etc.), and normalizes all path spellings so the same file appears once regardless of how different tools referred to it.

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

### `defaultPreset` and `presets`

These are compaction-only.  `defaultPreset` controls which model runs `/compact` by default; an explicit `--preset <name>` or `-p <name>` always overrides it.

```json
{
  "defaultPreset": "fast",
  "presets": {
    "fast": { "model": "openai-codex/gpt-5.4-mini", "thinkingLevel": "low" },
    "deep": { "model": "anthropic/claude-opus-4-6", "thinkingLevel": "high" }
  }
}
```

`"current"` uses the session's active model and thinking level.  Preset lookup is deterministic: exact match → case-insensitive → prefix → normalized substring.  Failed lookups fall back to the current session model with a warning.

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

The extension mirrors Pi's stock compaction boundaries: `messagesToSummarize` for history, `turnPrefixMessages` for split-turn prefixes, and `previousSummary` for cumulative updates.  When files-touched is enabled, manifests are passed to the summarizer per-span and a cumulative whole-branch manifest is appended to the final persisted summary:

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

**Compaction**: failed presets fall back to the session model.  If the session model also fails after an explicit preset directive, compaction is cancelled to avoid leaking raw directive text.  Aborts return cancellation quietly.

**Branch summary**: any failure returns `undefined` with a warning, letting Pi's stock flow proceed.

For npm installation and package-specific docs, see [`packages/pi-grounded-compaction/README.md`](../../packages/pi-grounded-compaction/README.md)
