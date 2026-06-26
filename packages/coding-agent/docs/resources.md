# Resource Profiles & Library

Pi can load a lot: extensions, skills, prompt templates, themes, agents. Across different projects and situations you rarely want all of them at once. **Resource profiles** are named on/off contracts that decide what is active, and the **Resources hub** is where you register a shared catalog of resources and curate which ones each project or situation uses.

The system separates three ideas that are easy to conflate:

- **Available** — what Pi can discover (from your catalog, plus user and project directories). "What exists."
- **Enabled** — what is active right now, expressed as a profile. "What's on."
- **Installed** — a physical copy under `~/.pi/agent/…` for portability to a machine without the catalog. "A local copy."

The default workflow is *manage by enabling, not by copying*: keep one catalog as the source of truth and switch profiles per situation. Installing is a secondary path for offline/portable use.

## Table of Contents

- [The Resources hub](#the-resources-hub)
- [Resource profiles](#resource-profiles)
- [Profile files](#profile-files)
- [Sources: a shared catalog](#sources-a-shared-catalog)
- [Manage Library](#manage-library)
- [Profiles as situations](#profiles-as-situations)
- [Per-agent profiles](#per-agent-profiles)
- [Install at user level](#install-at-user-level)
- [Backup and restore](#backup-and-restore)
- [Precedence](#precedence)

## The Resources hub

In interactive mode, open `/settings` and choose **Resources** to reach the **Resources Hub**:

| Item | What it does |
|------|--------------|
| **Profile / Situation** | Select the active profile. |
| **Manage Library** | Browse everything available and toggle what the active profile allows. |
| **Manage Profiles / Situations** | Create, persist, or delete profile definitions. |
| **Sources** | Register, trust, and remove external catalog directories. |

When no source or profile exists yet, the hub surfaces a first-run nudge — **"Add your catalog directory →"** — pointing you at the setup step below.

## Resource profiles

A profile is an allow/block contract over six kinds: `extensions`, `skills`, `prompts`, `themes`, `agents`, and `tools`. Each kind takes glob-style patterns:

- **`allow`** — when non-empty, only matching resources of that kind stay available.
- **`block`** — removed after `allow` is applied.

Empty `allow` means "allow all of this kind." `block: ["*"]` means "none."

A profile may also bind a **model** and a **thinking level** that apply when the profile is active. Thinking is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Explicit CLI flags still win over a profile's model/thinking, which in turn win over the settings default.

Profiles are stored in settings under `resourceProfiles`, and the active one(s) in `activeResourceProfile`:

```json
{
  "resourceProfiles": {
    "review": {
      "tools": { "allow": ["read", "grep", "find", "ls", "bash"] },
      "extensions": { "block": ["*"] }
    }
  },
  "activeResourceProfile": "review"
}
```

`activeResourceProfile` accepts a single name or an array; multiple active profiles are merged. Switch the active profile any time with `/profiles`.

> The older `disabledResources` block lists still work as a simple reversible "turn these off" filter. Profiles are the richer, named, reusable form.

## Profile files

Besides inline settings, a profile can live as a standalone JSON file in `~/.pi/agent/profiles/` (or `<catalog>/profiles/` when shared through a source). The file wraps the resource contract with optional metadata:

```json
{
  "name": "recon",
  "description": "Fast read-only scout: cheap model, read tools only.",
  "model": "anthropic/claude-haiku-4-5",
  "thinking": "low",
  "resources": {
    "tools": { "allow": ["read", "grep", "find", "ls"] },
    "extensions": { "block": ["*"] }
  }
}
```

File-based profiles appear by name alongside settings-based ones, so they can be version-controlled in a catalog and shared across machines.

## Sources: a shared catalog

A **source** is an external directory that Pi live-scans for resources. Point it at a folder structured like this and every kind is discovered automatically:

```
my-catalog/
├── skills/
├── extensions/
├── prompts/
├── themes/
├── profiles/
└── agents/
```

To register one:

1. `/settings → Resources → Sources → Add` and point at the directory.
2. Confirm the **trust** prompt.

> **Security:** a source can contain executable extension code and skills that instruct the model. Pi only scans roots you have explicitly **trusted**; untrusted or missing roots are skipped. Review a catalog before trusting it.

Registered roots are stored as `externalResourceRoots`; the trusted subset as `trustedResourceRoots`. Only roots that are both trusted and present are scanned. Because the scan is live, editing a file in the catalog is reflected on the next reload — no copy step.

This makes a git repository of shared resources a natural catalog: clone it once, register it as a source, and it *is* your backup.

## Manage Library

**Manage Library** is the browser for going from "a folder of fifty things" to "this project uses these eight." It lists everything available per kind, with its source labelled (catalog vs. user vs. project), and lets you toggle each item on or off for the active profile.

- **Fuzzy search** by name or description, so you never scroll a long list.
- Both framings are supported: *allow only these* and *everything except these* — so you don't have to untick forty-seven items to keep three.
- Toggles **apply live**. Turning an extension on or off loads or unloads it in place; its tools and commands appear or disappear without restarting the session. Lighter kinds (skills, prompts, themes) refresh the same way.
- An item that a profile enables but that has since disappeared from the catalog is marked **`[missing]`** rather than silently dropped.

By default, changes save to the active profile at the **directory-overlay** scope — a per-repository choice that writes no files into the project itself. You can also save to project or global scope.

## Profiles as situations

A profile *is* a situation. "Reviewing a PR," "scouting an unfamiliar repo," "heads-down implementation" are each just a profile with a curated set of resources and (optionally) a model. Switching the whole situation is one action:

```bash
/profiles review      # swap to the review situation
```

## Per-agent profiles

When you delegate to a subagent (via the `subagent` extension), the agent can declare which profile it runs under in its frontmatter, so a scout runs read-only on a cheap model while a worker gets the full toolset:

```markdown
---
name: scout
description: Fast codebase recon.
profile: recon
---
```

Agents are discovered from your catalog's `agents/` directory the same way other kinds are, so the whole set travels with the catalog.

## Install at user level

Live scanning covers the day-to-day. For portability — a machine without the catalog checkout, or offline use — copy a trusted directory's resources into your user config:

```bash
/install-resources <dir>            # copy, skipping files that already exist
/install-resources <dir> --force    # overwrite existing files
```

This copies `skills`, `extensions`, `prompts`, `themes`, `profiles`, and `agents` from `<dir>` into `~/.pi/agent/…`. The source must be trusted first (Pi prompts if it isn't, since extension code is executable). Installed agents land in `~/.pi/agent/agents`, where subagent discovery reads them.

## Backup and restore

Back up your personal configuration — profile definitions and resource settings — to a single JSON file:

```bash
/config-backup             # writes a default-named backup
/config-backup my.json     # writes to a path
/config-restore my.json    # merges it back, after confirmation
```

The backup bundles your profiles and the resource settings (`resourceProfiles`, `activeResourceProfile`, `externalResourceRoots`, `trustedResourceRoots`). It does **not** copy the catalog itself — that is what your git repository is for.

> **Security:** restore is deliberately cautious. Restored external roots come back **untrusted**, so a new machine re-prompts before any code loads, and restore confirms before overwriting existing local config.

## Precedence

When the same resource name exists in more than one place, the order is:

```
Project (.pi/)  >  User (~/.pi/agent/)  >  External roots (in registration order)  >  Bundled
```

Same-named items shadow lower-precedence ones, and Manage Library shows each item's source so you can see which copy is winning.
