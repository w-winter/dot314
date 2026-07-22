# skill-templates

Adds Nunjucks-rendered `SKILL.template.md` files alongside Pi's `SKILL.md` skill format. A template renders at invocation time from the positional arguments, named options, and flags you pass, so one skill definition can adapt its instructions to the request, include or omit sections, and compose content from other skills — all while producing the same `<skill>` prompt envelope as Pi's built-in skill expansion.

## Why

Pi's built-in skills are static: a `SKILL.md` file expands to the same text on every invocation. A `SKILL.template.md` is a Nunjucks template rendered from the arguments you pass when you invoke it, so a single skill can tailor its instructions to the request, include or drop sections conditionally, and pull shared content in from other skills instead of maintaining a near-duplicate `SKILL.md` for each variation. Rendered output uses the same `<skill>` envelope Pi applies to `SKILL.md`.

## Invocation

```text
/skill:code-review security --strict --lang python --foo-bar=baz
```

A `/skill-template:<name>` alias is registered for each template skill for discoverability and autocomplete. Global templates are available immediately. Templates and settings controlled by a project are discovered after Pi trusts that project.

When matching `SKILL.template.md` and `SKILL.md` files share a skill name, explicit `/skill:<name>` invocation uses the template. Keep their `name` and `description` frontmatter aligned so Pi's autocomplete metadata describes the rendered skill.

## Template context

Given the invocation above, the template receives:

| Variable | Value | Notes |
|----------|-------|-------|
| `args` | `["security"]` | Parsed positional arguments |
| `all_args` | `"security --strict --lang python --foo-bar=baz"` | Trimmed raw trailing invocation text |
| `skill_name` | `"code-review"` | Root skill name |
| `named` | `{ strict: true, lang: "python", "foo-bar": "baz" }` | Named options with their original keys |
| `strict` | `true` | Normalized top-level flag |
| `lang` | `"python"` | Normalized top-level option |
| `foo_bar` | `"baz"` | Hyphens become underscores in top-level variables |

Argument syntax supports `--flag`, `--key value`, and `--key=value`. Bare tokens become positional arguments; `--` makes all following tokens positional. Reserved names (`args`, `all_args`, `skill_name`, `named`) are rejected.

`all_args` preserves quote characters, option spelling, equals-versus-space syntax, and the `--` sentinel after trimming outer whitespace. Grouping quotes are removed in parsed `args`, `named`, and normalized variables. The same raw tail is appended after the closing `</skill>` tag, allowing arguments to influence template rendering while remaining visible to the agent.

## Includes and composition

Standard Nunjucks `{% include %}` resolves relative to the file currently rendering. Frontmatter is stripped when a `SKILL.template.md` is loaded as a template.

The custom `{% skill "path" %}` tag resolves a directory or explicit `SKILL.md` path relative to the file containing the tag. It strips frontmatter and renders the included body in the same Nunjucks environment and invocation context. Included bodies receive the root `skill_name`, `args`, `named`, normalized variables, and `all_args`; they can use Nunjucks expressions, native includes, and further `{% skill %}` tags.

```md
---
description: Review code with shared repository standards
---
First, review the change.
{% skill "../shared-standards" %}
Then summarize the highest-risk issues.
```

Only the rendered body is inserted. Inclusion does not add a nested `<skill>` element or `References are relative to` line. Cycles spanning native includes and `{% skill %}` calls are rejected.

### Reference paths

The final prompt has one outer `<skill>` envelope and one `References are relative to ...` line for the root `SKILL.template.md` directory. Nested template lookup still resolves from the file currently rendering, but relative asset, script, and file references emitted by included bodies are not rewritten. Write those references for the root invocation directory, or add explicit prose around the inclusion that identifies the included section's reference base.

## Example

[`skills/rp-deep-build/SKILL.template.md`](../../skills/rp-deep-build/SKILL.template.md) is a full working template: it reads `--planner` and `--executor` flags with defaults, keeps the ticket text after a `--` sentinel, branches into configuration-error and routing sections with `{% if %}`, and composes its planning and review phases from other skills with `{% skill %}`.

## Errors and scope

A template with malformed frontmatter is skipped with a warning. Duplicate or reserved option keys, missing include targets, inclusion cycles, and rendering failures stop the invocation and surface an error. Template rendering applies to explicit user invocation; Pi's model-invoked skill-reading flow uses `SKILL.md`.

Aliases can remain visible after a template is removed or project trust is revoked during a session. Invoking one refreshes the catalog and reports it as stale rather than rendering the removed template; reload the session to refresh command visibility.

Skill directories added by other extensions are discoverable when those extensions also register a skill command from that directory.

For npm installation and package-specific docs, see [`packages/pi-skill-templates/README.md`](../../packages/pi-skill-templates/README.md)
