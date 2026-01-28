# Kimi Provider for Pi (`pi-kimi-provider`)

Adds a `kimi` provider to Pi with a single model: `kimi-for-coding`.

This uses Kimi's Anthropic-compatible endpoint.

## Install

From npm:

```bash
pi install npm:pi-kimi-provider
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/kimi-provider/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Configuration

Set auth via env vars (preferred → fallback):

- `KIMI_API_KEY` (preferred)
- `ANTHROPIC_API_KEY` (fallback)

Optional base URL override:

- `KIMI_ANTHROPIC_BASE_URL` (preferred)
- `KIMI_BASE_URL` (fallback)
- `ANTHROPIC_BASE_URL` (fallback)

Default base URL:

- `https://api.kimi.com/coding/`

## Usage

Select the model in Pi's model picker as:

- `kimi/kimi-for-coding`
