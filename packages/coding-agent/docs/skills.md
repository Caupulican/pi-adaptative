> pi can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that the agent loads on-demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Pi implements the [Agent Skills standard](https://agentskills.io/specification), warning about most violations but remaining lenient. Pi allows skill names to differ from their parent directory even though the standard disallows it; that rule is suboptimal for shared skill directories used across multiple agent harnesses.

## Table of Contents

- [Locations](#locations)
- [How Skills Work](#how-skills-work)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

Pi loads skills from:

- Global:
  - `~/.pi/agent/skills/`
  - `~/.agents/skills/`
- Project:
  - `.pi/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories or `pi.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)

Discovery rules:
- In `~/.pi/agent/skills/` and `.pi/skills/`, direct root `.md` files are discovered as individual skills
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored

Disable all default discovery with `--no-skills` (explicit `--skill` paths still load).

Unload specific skills with settings filters. Put user-wide filters in `~/.pi/agent/settings.json` or project-specific filters in `.pi/settings.json`:

```json
{
  "disabledResources": {
    "skills": ["zuvi-trello-fix-release", "project-only-skill"]
  }
}
```

The existing `skills` array also accepts resource patterns: plain entries include local files/directories, `!pattern` excludes matching auto-discovered resources, `+path` force-includes an exact path, and `-path` force-excludes an exact path. `disabledResources.skills` is the explicit reversible unload form. It removes matching skills from vault search and skill commands after reload; an active skill is invalidated before another request can use it.

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.pi/settings.json`:

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, Pi reads a bounded frontmatter prefix from each skill. It retains routing metadata, not the body.
2. When the `skill` tool is active, the stable system prompt carries one brief rule: search the vault if, and only if, specialist focus would help. It contains no skill catalog, paths, bodies, or XML wrappers.
3. The agent searches metadata with `skill { action: "search", query: "..." }`, then loads an exact name. `/skill:name` performs the same load when the user selects a skill explicitly.
4. The host keeps one loaded skill. It appends that body as a hidden, request-local message after normal context processing; it never writes the body into session history or concatenates it into the system prompt.
5. The host moves the skill from `loaded_pending` to `active` on the first provider request. It records monotonic time on provider projections, completed model turns, tool execution; invalidates changed or profile-blocked resources; expires ten minutes of observed inactivity before the next host event. No polling timer runs.
6. Loading another skill replaces the current one. Explicit unload is optional; host expiry and invalidation do not depend on model cooperation.

This is progressive disclosure: the reminder and compact tool schema are stable, searches return at most a bounded name/description list, only one selected body enters a request.

Descriptions are the routing contract. Write narrow descriptions so metadata search can select the most task-specific skill. The `/context` dashboard includes the active request-local body in its estimate without refreshing the skill's activity clock.

Compaction never serializes an active skill body into history or a summary. Provider admission treats it as mandatory request-local context, compacts durable history around it, then re-injects it from the host vault on the replanned request. If the fixed envelope still cannot fit, Pi reports an explicit overflow instead of truncating or dropping the skill. Skill-vault state is in memory: `/new`, `/resume`, `/fork`, or a process restart starts a new unloaded vault. `/reload` retains an unchanged eligible skill and invalidates it if the resource changed or became unavailable.

Skills may carry optional resource profile blocks:

```markdown
<resource-profile name="reviewer">
{ "tools": { "allow": ["read", "rg"] } }
</resource-profile>
```

These blocks are JSON config, not instructions. Pi parses only matching profile blocks and strips them from every vault activation.

## Skill Commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

Arguments after the command remain the user request. The selected body is injected separately and request-locally.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Use relative paths from the skill directory:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Unlike the standard, Pi does not require this to match the parent directory because that standard requirement is suboptimal for shared skill directories. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from model search and cannot be model-loaded. Users may still use `/skill:name`. For full project/user unload, prefer `disabledResources.skills` in settings. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
Pi does not require the name to match the parent directory. The Agent Skills standard does, but that requirement is suboptimal for shared skill directories used by multiple tools.

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Pi validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Skills with missing description are not loaded.

Name collisions (same name from different locations) warn and keep the first skill found.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription
