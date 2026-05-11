# assistant-provenance for Pi (`pi-assistant-provenance`)

Gives models awareness of mid-session model switches.

<p align="center">
  <img width="450" alt="assistant-provenance demo" src="https://raw.githubusercontent.com/w-winter/dot314/main/assets/assistant-provenance-demo.gif" />
</p>

## Install

From npm:

```bash
pi install npm:pi-assistant-provenance
```

From the dot314 git bundle (filtered install):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/assistant-provenance/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Why

When you switch models mid-session, the new model sees a conversation full of assistant replies it didn't write.  From the model's perspective, all assistant messages look identical, as provider and model metadata is stripped during LLM conversion.  This extension gives each model the context it needs to understand which replies came from a different model and where the handoffs occurred, which can be especially helpful when inviting different model families to critique, correct, or take cues from each other's outputs.

## What it does

On each provider request, the extension scans the conversation for "significant" (see [Configuration](#configuration) below) assistant model transitions and inserts a compact note before each user message that follows a handoff:

```text
[Model handoff: previous assistant reply was authored by openai/gpt-5.5. Current assistant model anthropic/claude-opus-4-6 was selected before the following user message.]
```

The notes are **provider context only** — they reach the model but aren't persisted to session JSONL files and aren't included in HTML exports.  They aren't rendered in the TUI either, since Pi already displays model changes there.  Note also that the extension doesn't do any of the following:

- **No note per model-picker cycle.**  If the user cycles through several models before sending a message, only the model actually selected at send time matters.  Intermediate selections produce no notes.
- **No note on every message.**  Notes appear only at the specific conversation boundaries where a meaningful handoff occurred, not on subsequent turns where the model hasn't changed.
- **No ongoing prefix-cache churn.**  Notes are inserted at deterministic positions with deterministic content derived from assistant message metadata.  The `timestamp` field doesn't reach the provider, so repeated context builds produce a stable provider-facing prefix.

Handoff notes are recreated from the conversation history on every context build, so later turns retain awareness of earlier model switches without any durable session artifacts.  Error and aborted assistant messages are ignored when determining handoff boundaries.  Tool-result continuation contexts are left untouched.

## Configuration

Optionally, you may create `config.json` within the extension folder to suppress noisy transitions within certain model families.  For example:

```json
{
  "silentModelGroups": [
    ["*/claude-*"],
    ["*/gpt-5*"],
    ["*/gemini-*"],
    ["*/kimi-*"],
    ["*/glm-*"],
    ["*/deepseek-*"]
  ]
}
```

A transition is suppressed when both the prior and current models match at least one pattern in the same group (e.g., with `["*/claude-*"]`, no model-facing note would be sent upon switching between `anthropic/claude-opus-4-7` and `anthropic/claude-opus-4-6`).  Patterns containing `/` match the full `provider/modelId` key; patterns without `/` match only the model ID.  Matching is case-insensitive.  Only `*` is special, matching any sequence of characters.

Missing `config.json` uses the default empty configuration, and invalid `config.json` fails extension startup with a clear error so configuration mistakes are visible.
