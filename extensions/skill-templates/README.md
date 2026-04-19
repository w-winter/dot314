# pi-skill-templates

This extension adds `SKILL.template.md` files alongside Pi's existing `SKILL.md` skill format.  Templates are Nunjucks files that are rendered at invocation time from the user's positional arguments, named options, and flags, so a single skill definition can conditionally include sections, compose content from other skills, and avoid maintaining duplicative `SKILL.md` files for each variation.

Pi's core skill loader only knows about `SKILL.md`.  This extension discovers `SKILL.template.md` files from the same skill roots, intercepts explicit `/skill:<name>` input, renders the template, and delivers the result in the same `<skill ...>` envelope that core uses.  Normal `SKILL.md` behavior is unchanged; when both exist for the same skill name, the template version takes priority for explicit invocations.

## Invocation

```text
/skill:code-review security --strict --lang python --foo-bar=baz
```

A `/skill-template:<name>` alias is also registered for each template skill, for discoverability and autocomplete.

When both `SKILL.template.md` and `SKILL.md` exist for the same skill, `/skill:<name>` uses the template-backed version. Keep their `name` and `description` frontmatter aligned so Pi's autocomplete metadata stays correct.  The extension emits a one-time notice when it detects an active same-name shadow.

## Template context

Given `/skill:code-review security --strict --lang python --foo-bar=baz`, the template receives:

| Variable | Value | Notes |
|----------|-------|-------|
| `args` | `["security"]` | positional args array |
| `all_args` | `"security --strict ..."` | raw trailing text after the skill name |
| `skill_name` | `"code-review"` | resolved skill name |
| `named` | `{ strict: true, lang: "python", "foo-bar": "baz" }` | raw named options map |
| `strict` | `true` | top-level normalized var (`--flag` → `true`) |
| `lang` | `"python"` | top-level normalized var |
| `foo_bar` | `"baz"` | hyphens become underscores for template access |

Argument syntax: `--flag`, `--key value`, `--key=value`.  Bare tokens become positional args; a `--` sentinel can be used to force everything after it into positional args (useful if trailing text looks like an option).  Reserved names (`args`, `all_args`, `skill_name`, `named`) are rejected.

## Includes and composition

Standard Nunjucks `{% include %}` works for partials relative to the template file.  Frontmatter is stripped automatically when including another `SKILL.template.md`.

The custom `{% skill "path" %}` tag inlines another skill's `SKILL.md` body (frontmatter stripped, rendered with the same template context).  A directory target resolves to `<dir>/SKILL.md`.

```md
---
description: Review code with shared repo standards
---
First, review the change.
{% skill "../shared-standards" %}
Then summarize the highest-risk issues.
```

Circular includes (both native and `{% skill %}`) are detected and rejected.

## Errors

The extension fails closed.  Duplicate/reserved option keys, missing include targets, circular inclusion, malformed frontmatter, and Nunjucks render failures all stop the invocation and surface an error notification.

## Limitations

- Affects **explicit user invocation** only; template-backed skills are not autonomously model-invocable through Pi's core read-tool skill flow
- `/skill-template:<name>` aliases can go stale if template files are removed mid-session; reloading clears that
- Skill roots contributed by other extensions are only discoverable when they already surface a core skill via `getCommands()`

## Development

```bash
node --test test/*.test.ts
```
