# Model system-prompt appendix for Pi (`pi-model-sysprompt-appendix`)

Appends a per-model "appendix" to Pi's system prompt right before `# Project Context`.

Useful for model-specific calibration (e.g. adding model-targeted rules or identity steering).

## Install

From npm:

```bash
pi install npm:pi-model-sysprompt-appendix
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/model-sysprompt-appendix/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Configuration

Edit `~/.pi/agent/extensions/model-sysprompt-appendix/model-sysprompt-appendix.json`.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `includeModelLine` | `boolean` (optional) | If `true` and the current model has an `exact` match, adds an `Active model: provider/id` line before the appendix content. Default: `false`. |
| `default` | `string` (optional) | Appendix text for models *not* listed in `exact`. **Ignored** if an exact match exists for the current model. |
| `exact` | `object` (optional) | Map of `provider/model-id` keys to model-specific appendix text. Takes priority over `default`. |

### Example

```json
{
  "includeModelLine": true,
  "default": "Always use `trash` instead of `rm` for deletions.",
  "exact": {
    "anthropic/claude-opus-4-5": "You are Opus 4.5.",
    "anthropic/claude-sonnet-4-0": "You are Sonnet 4.0."
  }
}
```

#### How this works

With the config above:

- **Opus 4.5** (`anthropic/claude-opus-4-5`) gets:
  ```markdown
  # Model Context
  Active model: anthropic/claude-opus-4-5
  You are Opus 4.5.
  ```

- **Sonnet 4.0** (`anthropic/claude-sonnet-4-0`) gets:
  ```markdown
  # Model Context
  Active model: anthropic/claude-sonnet-4-0
  You are Sonnet 4.0.
  ```

- **Any other model** gets:
  ```markdown
  # Model Context
  Always use `trash` instead of `rm` for deletions.
  ```

**Important**: `default` is only used when there's no `exact` match. If you want a model to have both specific content AND the default content, include the default text in the exact match value itself.

## Usage

- Command: `/model-sysprompt-appendix reload`
- Command: `/model-sysprompt-appendix status`

Changes apply on the next agent turn (the appendix is injected on `before_agent_start`).
