# Pi Adaptative Documentation

Pi Adaptative is a reliability-first coding-agent harness with bounded tool recovery, durable orchestration, long-session safeguards, and an extensible CLI/SDK. Extensions, skills, prompt templates, themes, and packages provide additional capabilities without weakening the core guarantees.

## Quick start

Install the standalone Linux release:

```bash
curl -fsSL https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.sh | sh
```

Re-run the installer to update. For ownership-checked removal instructions, see [Quickstart](quickstart.md#uninstall); user settings and sessions under `~/.pi/agent/` are preserved. On Windows, use the native PowerShell installer:

```powershell
irm https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.ps1 | iex
```

The CLI is distributed only as standalone Linux and Windows releases. Node.js and npm are source-development and extension/package tooling, not installation or publication channels for the CLI.

Then run it in a project directory:

```bash
pi
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting pi.

For the full first-run flow, see [Quickstart](quickstart.md).

## Start here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session.
- [Using Pi](usage.md) - interactive mode, slash commands, context files, and CLI reference.
- [Providers](providers.md) - subscription and API-key setup for built-in providers.
- [Settings](settings.md) - global and project settings.
- [Keybindings](keybindings.md) - default shortcuts and custom keybindings.
- [Sessions](sessions.md) - session management, branching, and tree navigation.
- [Compaction](compaction.md) - context compaction and branch summarization.
- [FastContext scout](scout.md) - read-only repository scout setup and 10 GB local profile.
- [Tool repair](tool-repair.md) - repaired tool-call arguments, health diagnostics, kill switches, and replay workflow.
- [Task steps](task-steps.md) - native session checklist, slash commands, persistence, and delegation migration.
- [Work lifecycle](work-lifecycle.md) - canonical five-phase Survey-to-delivery contract, adaptive solo/team routing, verification, and checkpoint boundaries.
- [Native Python](python.md) - uv-managed bounded Python execution, provisioning, output limits, and cross-platform file guidance.
- [Managed data tools](managed-data-tools.md) - pinned rg, jq, and Rust jscpd provisioning without project files.

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Persistent provider collaboration](pi-collaboration.md) - interactive native-provider teams with terminal/question handoffs.
- [Runtime updates](runtime-updates.md) - autonomous hot reload, verified restart and bounded recovery.
- [WebFetch](webfetch.md) - bounded public-web retrieval and HTML conversion.
- [Subscription image generation](image-generation.md) - ChatGPT image generation and edits with durable local artifacts.
- [Task worker presets](worker-profiles.md) - optional immutable session presets for root-managed leaf workers with host-owned execution grants.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Resource profiles & library](resources.md) - curate extensions, skills, and agents per project or situation; share a catalog; install and back up.
- [Self-adaptation](self-adaptation.md) - draft live skills/extensions and run evidence-backed Pi harness improvement loops.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Pi packages](packages.md) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](models.md) - add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) - implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](sdk.md) - embed pi in Node.js applications.
- [RPC mode](rpc.md) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) - print mode with structured events.
- [TUI components](tui.md) - build custom terminal UI for extensions.

## Reference

- [Session format](session-format.md) - JSONL session file format, entry types, and SessionManager API.

## Platform setup

- [Windows](windows.md)
- [Transient work directory](work-directory.md) - multi-tenant runtime output, leases, and retention.
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Development

- [Development](development.md) - local setup, project structure, and debugging.
- [Tool boundary performance roadmap](tool-boundary-performance-roadmap-2026-08-02.md) - evidence ledger for preflight, payload ownership, Python coordination, and remaining latency/memory work.
