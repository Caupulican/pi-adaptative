---
name: skill-creator
description: "Create, scaffold, validate, and package provider-neutral Pi skills with safe deterministic tooling. Use when the user asks to create a Pi skill, turn a workflow into a bundled or user skill, initialize a SKILL.md directory, validate skill structure, or add references/scripts/assets without provider-specific metadata."
---

# Pi Skill Creator

## How to use the skill

Use this skill for the physical creation and validation of Pi skill packages.
Use `skill-architect` for instruction design, routing quality, Freedom Dial, and
overlap decisions; this skill owns filesystem layout and deterministic gates.

**Freedom Dial: Low Freedom for packaging.** Paths, frontmatter, required
headers, provider neutrality, non-overwrite behavior, and validation have one
correct contract. Skill content may use the Freedom Dial selected by
`skill-architect`.

Create a new skill with:

```bash
node <this-skill-directory>/scripts/init-skill.mjs <skill-name> --path <skills-directory> --resources references,scripts
```

Validate it with:

```bash
node <this-skill-directory>/scripts/validate-skill.mjs <skill-directory>
```

Read [references/pi-skill-contract.md](references/pi-skill-contract.md) before
changing discovery, packaging, or validation rules.

## North Star

Produce one narrow, discoverable, provider-neutral Pi skill whose package is
safe to create, complete enough to route correctly, bounded in context cost,
and validated by executable checks without overwriting user work.

Think before writing, reuse or refine an existing owner when possible, keep the
change surgical, define a testable user outcome, and leave credentials,
destructive changes, publication, and authority expansion to explicit human
approval.

## Core Sections

### 1. Audit ownership first

Search bundled, user, project, plugin, and configured skill roots by name,
description, triggers, and semantic responsibility. Do not create a near-duplicate
skill to avoid editing the existing owner.

Choose one outcome:

- refine the existing skill;
- split a genuinely distinct job with explicit routing boundaries;
- merge competing skills and update callers;
- create a new skill only when no owner fits.

For Pi harness work, final bundled behavior belongs under
`packages/coding-agent/src/bundled-resources/skills/`. User-level files are
temporary migration or validation sources unless the user explicitly requested
a user-only skill.

### 2. Scaffold safely

Use `scripts/init-skill.mjs`; do not hand-create a parallel layout. The
initializer:

- accepts only lowercase hyphen-case names;
- creates exactly one direct child of the selected skills directory;
- stages then atomically renames the package;
- refuses an existing destination and never overwrites;
- creates only requested `scripts`, `references`, or `assets` directories;
- writes quoted YAML frontmatter and the required Markdown spine;
- never creates `agents/openai.yaml` or other provider-specific metadata.

Do not use a broad home/workspace path as the destination. Resolve the exact
skill root first and inspect worktree state when working in a repository.

### 3. Author one job

Use `skill-architect` to set routing and content. Keep the main `SKILL.md` under
500 lines and preferably under 350. Its frontmatter description is the routing
face: name the action, trigger contexts, and concrete user intents without
claiming unrelated domains.

Use these exact level-two headers in order:

1. `## How to use the skill`
2. `## North Star`
3. `## Core Sections`
4. `## Anti-Patterns`
5. `## Examples`
6. `## Self-Check`
7. `## Known Gaps`

Move heavy or rarely needed knowledge into `references/`, deterministic
automation into `scripts/`, and output ingredients into `assets/`. Link only
resources the skill actually needs and state when to read or run them.

### 4. Preserve provider and authority neutrality

Pi is multi-provider. Skill behavior belongs in Markdown and deterministic
resources, not `agents/openai.yaml`, provider model names, hidden reasoning, or
one provider's tool protocol. Refer to capabilities by semantic role and adapt
to the active tool surface.

A skill is instruction, not authority. It cannot grant credentials, network
scope, filesystem/process access, destructive actions, settings changes,
publishing, or delegation. Preserve the host's user/session/worker capability
intersection and repository instructions.

### 5. Add evidence before implementation

For a bundled skill, first add a focused discovery/content test that fails for
the missing skill or contract. For scripts, add valid input, malformed negative
control, path/traversal, existing-destination, and cross-platform cases in
proportion to risk.

Do not test only keyword presence when runtime discovery or executable behavior
is the invariant. Avoid executing external providers or paid APIs in skill tests.

### 6. Validate and forward-test

Run `scripts/validate-skill.mjs` on the completed directory, then the repository's
focused discovery and script tests. Inspect output, not only exit status.

Forward-test at least these prompts against the description:

- one request that must load the skill;
- one adjacent request that must not load it;
- one ambiguous request whose safest behavior is explicit;
- one request exercising each linked reference or script.

Run the repository-required broader checks after the focused tests. If the skill
is bundled, verify it loads from a blank profile and that the packaged asset copy
includes every linked resource.

### 7. Hand off precisely

Report the skill name/path, ownership decision, created resources, focused test,
validator result, overlap decision, rejected candidates, and known gaps. Mention
provider neutrality explicitly. Do not claim a skill is installed in an already
released binary until the package was built/released and tested there.

## Anti-Patterns

- Creating a skill before searching existing owners.
- Combining several jobs into a broad expert persona.
- Copying external prompts or exploit catalogues verbatim.
- Generating provider-specific metadata for a multi-provider Pi skill.
- Writing scripts that overwrite existing directories or accept traversal names.
- Keeping large catalogues in `SKILL.md` when a reference is more selective.
- Treating a valid frontmatter parse as proof of useful routing or behavior.
- Claiming bundled source is already installed in a released executable.

## Examples

**New narrow workflow:** no existing skill owns authorized web assessment.
Scaffold `authorized-web-security-audit`, write a focused discovery test, keep
the assessment contract in `references/`, validate, and forward-test an
authorized and an unauthorized prompt.

**Overlap found:** a requested "prompt writer" duplicates `skill-architect`.
Refine that owner instead of creating `prompt-writer`.

**Unsafe name:** `../security` or `Security Review` is rejected by the
initializer. Choose `security-review`; never normalize traversal into a path.

## Self-Check

- Existing skill roots were searched for name and semantic overlap.
- The skill has one job and a discriminating quoted description.
- The initializer created one direct child and overwrote nothing.
- No provider-specific metadata exists.
- Required headers are present in order and `SKILL.md` is under 500 lines.
- Every linked resource exists and has an explicit load/run trigger.
- Discovery, executable negative controls, validator, and forward-routing tests pass.
- Bundled versus installed/released status is reported accurately.

## Known Gaps

- Structural validation cannot prove domain correctness or routing quality.
- The initializer does not install, publish, or enable a skill in a running
  process; reload/restart and package/release steps remain separate.
- Existing third-party skill formats may need a reviewed Pi-native migration
  instead of direct scaffolding.
