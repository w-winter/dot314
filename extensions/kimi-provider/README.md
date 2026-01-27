# Kimi provider extension for pi

This extension registers a single custom provider:

- `kimi/kimi-for-coding`

It uses **Kimi's Anthropic-compatible** coding-agents endpoint.

## Why not the OpenAI-compatible endpoint?

In practice, the OpenAI-compatible endpoint (`https://api.kimi.com/coding/v1`) currently responds with:

> `403 Kimi For Coding is currently only available for Coding Agents ...`

when called from pi (via the OpenAI JS SDK). The Anthropic-compatible endpoint works, so this extension only supports that path to avoid duplicated models and a broken backend.

## Setup (Anthropic-compatible / Claude Code style)

```sh
export ANTHROPIC_BASE_URL=https://api.kimi.com/coding/
export ANTHROPIC_API_KEY=sk-kimi-...

pi
```

Optional convenience env var (if you prefer not to reuse Anthropic-named vars):

```sh
export KIMI_API_KEY=sk-kimi-...
```

## Files

- `index.ts`: extension entrypoint
