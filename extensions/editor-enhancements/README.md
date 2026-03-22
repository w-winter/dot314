# editor-enhancements

A composite custom editor that combines several `setEditorComponent()`-based UX tweaks in one place so they remain compatible with each other.

This extension currently provides:
- `@`-triggered file picking for inserting `@path` refs at the cursor
- shell completions in `!` / `!!` mode
- `alt+v` raw clipboard paste that bypasses Pi's large-paste markers
- optional remapping of the editor's empty-editor double-escape gesture to an extension command such as `/anycopy`
- configurable command remapping (e.g. make `/tree` execute `/anycopy` instead)

## Usage

This extension does not add a primary top-level slash command of its own. Its behavior is integrated directly into the editor.

Notable interactions:
- Type `@` at token start to open the file picker
- Press `alt+v` to paste clipboard text raw into the editor
- Optionally configure `doubleEscapeCommand` in `config.json` to invoke an extension command on double-escape when the editor is empty and Pi is idle
- Optionally configure `commandRemap` in `config.json` to redirect slash commands at submit time (e.g. typing `/tree` executes `/anycopy` instead)

## Configuration

Create `~/.pi/agent/extensions/editor-enhancements/config.json` (see `config.json.example`):

- `doubleEscapeCommand`: optional extension command name to invoke on double-escape
  - default: `null`
  - accepts either `"anycopy"` or `"/anycopy"`
  - only commands registered via `pi.registerCommand()` are supported
  - Pi native built-ins like `/tree` are not supported here
- `commandRemap`: map of command names to replacements, applied at submit time
  - default: `{}`
  - keys and values are normalized (leading `/` stripped, whitespace trimmed)
  - works for all command types: built-in (`/tree`, `/model`), extension, skill, and template commands
  - arguments and subcommand syntax (everything after the command name) are preserved

```json
{
  "doubleEscapeCommand": "anycopy",
  "commandRemap": {
    "tree": "anycopy",
    "resume": "switch-session"
  }
}
```

Set `doubleEscapeCommand` to `null` to disable the remapping and keep Pi's native double-escape behavior. Set `commandRemap` to `{}` (or omit it) to disable command remapping.

## Notes

- The configured double-escape command is only triggered when the editor is empty and Pi is idle
- If the configured command is not a registered extension command, the extension warns and falls back to native behavior
- Command remapping intercepts at the editor submission layer via `onSubmit`, so it applies uniformly to all submit paths (Enter, double-escape gesture, etc.) and works with any command type — built-in, extension, skill, or template. If a remap target doesn't exist as a registered command, pi treats it as a regular prompt
- Because this extension owns `setEditorComponent()`, disable standalone editor-replacement extensions such as `shell-completions/`, `file-picker.ts`, and `raw-paste.ts` to avoid conflicts
