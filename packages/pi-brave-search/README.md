# Brave Search for Pi (`pi-brave-search`)

Token-efficient Brave web search as a Pi extension, with optional content extraction/clipping.

Also includes Brave AI Grounding support (answer-with-citations workflows) when `BRAVE_API_KEY_AI_GROUNDING` is set.

## Install

From npm:

```bash
pi install npm:pi-brave-search
```

From the dot314 git bundle (filtered install):

Add to `~/.pi/agent/settings.json` (or replace an existing unfiltered `git:github.com/w-winter/dot314` entry):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/brave-search/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Setup

- Set `BRAVE_API_KEY` (Brave Search API)
- Optional: set `BRAVE_API_KEY_AI_GROUNDING` (Brave AI Grounding)

## Usage

- Manual command: `/ws <query> ... [--content]` (no model turn)
- LLM tools:
  - `brave_search({ query, count, country, freshness, fetchContent, format })`
  - `brave_grounding({ question, enableResearch, enableCitations, enableEntities, maxAnswerChars })`

Notes:
- With `--content` / `fetchContent=true`, full extracted markdown is saved under `~/.pi/agent/extensions/brave-search/.clips/` and the output includes a `Saved:` path
- If `query` is a direct URL (including `raw.githubusercontent.com/...`) and `fetchContent=true`, the tool fetches and clips that URL directly (no search step)
