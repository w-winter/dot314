# grounded-compaction for Pi (`pi-grounded-compaction`)

Requires Pi 1.5.0 or later and pi-ai 1.1.0 or later. Compaction presets can use models registered by other Pi extensions, including `pi-claude`.

This extension can play three roles:
* Replace Pi's compaction summarizer with configurable model presets, custom summarization prompt contracts, and deterministic files-touched tracking that covers Pi native tools, RepoPrompt, recognized shell operations, and Codex `apply_patch`
* Augment branch summarization during `/tree` with the same files-touched grounding and optional replacement of the summarization prompt contract with a custom one
* Provide the plaintext summaries used by [`codex-compaction-coordinator`](https://github.com/w-winter/dot314/tree/main/extensions/codex-compaction-coordinator) when switching from a Codex model to another provider

The compaction and `/tree` features work without the coordinator. Coordinator integration is optional.

Files-touched tracking covers supported tools run inside pi-codex-conversion Code and Notebook `exec` calls, calls completed through `wait`, and literal `rp-cli`/`rpce-cli` shell commands. Live nested tracking requires pi-codex-conversion 3.0.30 or newer. When file evidence is missing, the manifest lists only the confirmed operations. See [Files Touched coverage](https://github.com/w-winter/dot314/tree/main/packages/pi-files-touched#what-it-tracks) for supported commands and limits.

> ⚠ **May conflict with other compaction extensions**: this extension hooks `session_before_compact` and returns a custom compaction result.  Any other extension that does the same is incompatible.  Having both active creates a race condition where the last handler to respond wins.  Enable only one.

## Install

From npm:

```bash
pi install npm:pi-grounded-compaction
```

From the dot314 git bundle (filtered install):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/grounded-compaction/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Why

Pi's native compaction [deterministically tracks](https://github.com/badlogic/pi-mono/blob/629341c18f3482d891b665a844975096b47b4779/packages/coding-agent/src/core/compaction/utils.ts#L74-L79) file activity from its built-in `read`, `write`, and `edit` tool calls.  Operations through shell commands or custom tools like RepoPrompt are invisible to it.  This extension uses a [shared collector](https://github.com/w-winter/dot314/tree/main/packages/pi-files-touched) (`extensions/_shared/files-touched-core.ts`) that also covers RepoPrompt tools (`read_file`, `apply_edits`, `file_actions`, `git mv/rm`), recognized shell patterns through `bash` and `exec_command`, structured `apply_patch` changes, and normalizes all path spellings so the same file appears once regardless of how different tools referred to it.

Since compaction also [serializes messages to text](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md#message-serialization) before summarizing, which entails that there is no prefix-cache opportunity cost to routing compaction to a cheaper or faster model, you may want to be able to do that sometimes or as a default policy.  The "presets" grant that option.

## Compaction and branch summarization

For background on Pi's compaction lifecycle, see the [compaction docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md).  Branch summarization is the summary generated when navigating `/tree` — effectively compaction in any direction across the session tree, rather than just forward along a session's chronology.  This extension augments both.

## Files

- **Config**: `config.json` (see `config.json.example` for presets)
- **Compaction prompt**: `compaction-prompt.md` (falls back to default embedded in `prompts.ts` if blank or missing)
- **Branch-summary prompt**: `branch-summary-prompt.md` (falls back to Pi's stock branch summarization prompt if blank or missing)
- Examples: `compaction-prompt.md.example`, `branch-summary-prompt.md.example`

`compaction-prompt.md.example` demonstrates optional RepoPrompt and `session_ask` integrations. Remove or adapt those clauses when those tools are unavailable; the embedded default does not depend on either tool.

## Config

```json
{
  "includeFilesTouched": {
    "inCompactionSummary": "writer",
    "inBranchSummary": "writer"
  },
  "toolResultChars": null,
  "defaultPreset": "current",
  "presets": {}
}
```

### Retaining user messages

[Codex](https://github.com/openai/codex) keeps recent user messages next to its compaction summary: up to 20,000 tokens beside a plaintext summary and 64,000 beside OpenAI's encrypted one. Set `verbatimUserMessageTokens` to a positive whole number to append earlier user messages to this extension's summaries in the same way. The number is an estimated token budget for the appended section, and it shrinks when the model that continues the session lacks room. The default, `null`, turns retention off.

Candidates are your messages from before the conversation Pi keeps after compaction (set by `keepRecentTokens`), chosen newest first. One that doesn't fit is skipped, so smaller older ones can still be included. They appear in conversation order with their session entry IDs and UTC times. Messages omitted through Pi's context edits are skipped, replaced ones use their replacement, and images are not retained.

Messages of at least `verbatimUserMessageFlagChars` characters (default `8000`) can be shortened. The summarizer chooses line ranges, which the extension copies exactly, or writes a short description. The extension shortens a `/skill:` expansion itself, keeping the `<skill>` line that names the skill file and whatever you typed after the skill. Skills rendered by [skill-templates](https://github.com/w-winter/dot314/tree/main/packages/pi-skill-templates) stay whole, because their text depends on the arguments you passed. Later compactions reuse a shortening, including after resume or fork, until the message's text changes.

Each shortened message's full text is saved, readable only by you, to `<sessionDir>/<sessionId>.verbatim/<contentHash>.txt`, and the summary gives that path. Copy these files with the session when moving it to another machine.

### `includeFilesTouched`

The files-touched manifest is a block listing each file the session read, wrote, edited, moved, or deleted, built from recorded tool calls. This setting decides which models see it. The *writer* is the model that writes a summary: the compaction summarizer, or Pi's own branch summarizer during `/tree`. The *reader* is the model that later continues the session with that summary in its context.

- `"writer"` (default): the writer gets the manifest as reference and is told to name the files that matter in the summary itself. The saved summary contains no manifest.
- `"writerAndReader"`: the writer gets the manifest, and the reader gets it too, after the summary.
- `"off"`: no manifest is built.

A single string sets both features. An object sets each feature separately, and both fields are required:

```json
{ "inCompactionSummary": "writer", "inBranchSummary": "off" }
```

Any other value, including `true` or `false`, makes the config invalid.

For compaction, the manifest covers the whole session branch, so the writer also sees files from history that earlier compactions summarized. In `"writerAndReader"` mode it is appended to the saved summary under `## Files touched (cumulative)`. Portable summaries for codex-compaction-coordinator use the history up to the checkpoint being summarized. For branch summaries, the manifest covers the entries being summarized, and Pi's summarizer is told either to reproduce it verbatim (`"writerAndReader"`) or to use it only as reference (`"writer"`). Pi also appends its own read and modified file lists to a branch summary when the summarized entries touched files, whatever this setting says.

In both enabled modes the manifest is a recall aid for the writer. File operations spread across many tool calls in a long context are easy to miss without an authoritative list.

### `toolResultChars`

Controls how much text from each tool result the summarizer sees. `null` or omission passes the full text through. A positive integer keeps that many characters from the start of each result and appends a note saying how many were dropped. Either way only text is included; images and other non-text tool output are not.

Pi's own compaction keeps 2000 characters of each tool result, which holds summarization cost down and stays workable on models of any context size. Setting `toolResultChars` to `2000` matches that; `null` opts out of it. Keeping more text gives the summarizer better recall of what tools actually returned, at the cost of a larger, more expensive request that is likelier to need `largeContextPreset` (below).

That cost is usually worth paying when the substance of a session lives in tool output rather than in the conversation around it: reading long files, working through test failures, inspecting query results or logs. Two thousand characters is often just the head of a file or the first frames of a stack trace, so a summary built from it can record which files were examined while losing what they contained. When the files-touched manifest is enabled, the summarizer sees every recorded path either way, but only the tool text shows what the files contained.

A limit earns its keep in the opposite case: sessions dominated by bulky, low-signal output such as long directory listings, verbose build logs, or repeated large fetches. There the extra text mostly buys request size, and a cap keeps compaction affordable on a smaller default model.

This setting applies to ordinary compaction and portable summaries created through codex-compaction-coordinator. For portable summaries, it is applied before chunking. Completed portable summaries are reused after a setting change; an unfinished checkpoint restarts if the change alters its input text.

### `defaultPreset`, `largeContextPreset`, and `presets`

These are compaction-only. `defaultPreset` controls which model runs compaction by default. The optional `largeContextPreset` names one other key in `presets`, used only when a summarization request is too large for the default preset's model; it must name a model Pi has registered with a strictly larger context window.

For consistent behavior across model providers, preset `thinkingLevel` values range from `off` through `xhigh`.

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
- If files-touched grounding is enabled, the manifest is added to the instructions, and depending on `includeFilesTouched` Pi's summarizer is told to reproduce it verbatim (`"writerAndReader"`) or to use it only as reference (`"writer"`)
- If neither is active, the extension does nothing and Pi's stock flow runs unmodified
- On any failure, the extension returns nothing and Pi's stock flow proceeds

The user's freeform focus text from the `/tree` prompt is preserved in either mode.

### Why branch-summary control is narrower than compaction

For compaction, this extension fully owns the LLM call: it can select a different model via presets, control thinking level independently, and manage token budgets.  A session running Opus with a high thinkingLevel can compact cheaply with Gemini Flash.

For branch summaries, this extension sets the instructions that Pi's own branch summarizer receives, and Pi makes the summarization call. Branch summaries therefore run on the current session model with Pi's own output limit and reasoning settings, and the presets in `config.json` do not apply to them. Pi's `session_before_tree` hook can also accept a complete summary written by an extension, which would allow a cheaper model; this extension uses the instruction overrides instead.

## How compaction summaries are structured

The extension mirrors Pi's stock compaction boundaries: `messagesToSummarize` for history, `turnPrefixMessages` for split-turn prefixes, and `previousSummary` for cumulative updates.  On repeated compactions, that means resuming from the previous compaction's `firstKeptEntryId`, not from the compaction entry itself.  When the previous compaction is an encrypted checkpoint from a Codex model and codex-compaction-coordinator is loaded, the summarizer receives the coordinator's portable summary of that checkpoint in place of the checkpoint's placeholder text.  When files-touched is enabled, every summarization request gets the same whole-branch manifest, and the summarizer is told whether the extension will append it. A manifest the model copies to the end of its own output is removed. In `"writerAndReader"` mode, the cumulative manifest is appended to the final persisted summary:

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

Compaction is also cancelled, with a diagnostic, for any of these:

- The summary stops at the model's output limit. Summary requests ask for the model's maximum output.
- Retention fails: the summarizer returns an invalid shortening, saved retention data is unreadable, or a recovery file can't be written.
- The finished summary would leave the model that continues the session too little room for its prompt, tools, kept messages and `reserveTokens`.
- The session, branch, model, prompt or tools change while the summary is being written.
- The previous compaction is an encrypted Codex checkpoint whose portable summary codex-compaction-coordinator hasn't finished. The message explains how to build it.

An explicit `-p` preset cancels if its model cannot fit the request or fails while summarizing. Other summarization failures on a compaction that did fit leave Pi's stock compaction available. Aborts cancel quietly.

**Branch summary**: any failure returns `undefined` with a warning, letting Pi's stock flow proceed.

**Invalid `config.json`**: compaction warns and Pi runs its stock compaction (an explicit `-p` preset cancels compaction instead), and branch summaries use Pi's stock flow. When codex-compaction-coordinator requests a portable summary, the error appears only as its generic "Codex checkpoint portability failed" notice, so check grounded-compaction's `config.json` first when that notice appears.
