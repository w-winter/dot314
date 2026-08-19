# Pi Codex apply_patch display

This Pi extension renders `@howaboua/pi-codex-conversion` `apply_patch` calls with an adaptive diff view. Wide terminals use a split view, narrow terminals use a unified view, and changed words receive additional highlighting.

Example:

<p align="center">
  <img width="450" alt="apply_patch rendering example" src="https://github.com/user-attachments/assets/f84c793a-b74d-41e6-8069-ad25bf5b8508" />
</p>

The extension supports direct and Code/Notebook Mode patch calls through `pi-codex-conversion`'s `apply-patch-display` integration. The original execution row becomes a compact status, and each edited file appears in its own display-only transcript box after the turn. Layout follows `diffViewMode` and `diffSplitMinWidth` in `~/.pi/agent/extensions/pi-codex-apply-patch-display/config.json`; copy [`config.example.json`](./config.example.json) to that path to customize the defaults.

Delete-only patches appear as deleted-file records because `apply-patch-display` provides patch input rather than pre-execution file contents.

## Requirements

Install and enable [`@howaboua/pi-codex-conversion`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion) 3.0.16 or newer in Pi.

This display extension also loads `pi-codex-conversion`'s public display API and its diff library as local npm dependencies. Install them once before loading the display extension:

```bash
npm --prefix ~/.pi/agent/extensions/pi-codex-apply-patch-display install --legacy-peer-deps
```
