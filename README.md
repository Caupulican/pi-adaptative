# Pi Adaptative

Pi Adaptative is an independent coding-agent harness for work that needs durable
orchestration, explicit recovery, and evidence that survives long sessions.

It began from the Pi codebase, but it is no longer a lightweight Pi distribution.
The project deliberately spends more code, state, and runtime overhead on durable
sessions, compaction, background workers, tool-call recovery, process lifecycle
management, and evidence-gated changes. That is the tradeoff: this is intended for
reliable, inspectable agent work rather than the smallest possible terminal wrapper.

## Install the standalone release

Releases are published from this repository:

<https://github.com/Caupulican/pi-adaptative/releases>

The supported installers are limited to Linux and Windows on x64 or arm64. They
download the matching standalone archive and verify it against the release's
`SHA256SUMS` before activation. End users do not need npm or Node.js.

### Linux

```sh
curl -fsSL https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.sh | sh
```

The installer places the managed `pi` launcher in the user-local installation
location. Run `pi --version` after installation. Review the installer before
piping it to a shell if your environment requires that policy.

### Windows PowerShell

```powershell
irm https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.ps1 | iex
```

The PowerShell installer selects the native x64 or arm64 archive, verifies its
checksum, and installs the matching `pi.exe`. Windows users can also download the
corresponding archive and `SHA256SUMS` directly from the
[latest release](https://github.com/Caupulican/pi-adaptative/releases/latest).

The release archives are the supported distribution format. There is no public
package-registry distribution, third-party web installer, or package-manager
self-update path. `pi update --self` directs legacy installations to the standalone
installer instead of mutating them in place. npm and Node.js remain development and
extension tooling for contributors; they are not end-user installation requirements.

## What the harness provides

- Durable session and process ownership across long-running work.
- Compaction that preserves bounded, verifiable context instead of treating a
  transcript as an unbounded action counter.
- Background workers with explicit ownership, completion handoffs, bounded output,
  and controlled cleanup when sessions overlap in one directory.
- Tool-call validation and recovery that teaches corrective usage, scopes failures
  to the operation that failed, and keeps unrelated work admissible.
- Persistent shell execution with explicit cancellation, timeout, and process-tree
  cleanup semantics.
- Evidence-gated development workflows with focused red tests, coverage gates,
  adversarial checks, and release artifact verification.
- A terminal coding-agent interface with provider adapters, extensions, themes,
  skills, and SDK support.

These controls improve observability and recovery; they do not make model output,
shell commands, provider APIs, or repository changes inherently safe. Review model
permissions, tool surfaces, credentials, and proposed edits before granting an
agent access to important systems. Use isolated worktrees or disposable
environments for untrusted tasks.

## Use the agent

After installation, start in the repository you want to work on:

```sh
pi
```

Useful checks:

```sh
pi --version
pi --help
pi --list-models
```

Provider setup, settings, sessions, extensions, and the full CLI reference live in
the [coding-agent documentation](packages/coding-agent/docs/index.md). Provider
configuration is documented in [providers.md](packages/coding-agent/docs/providers.md),
and the project-specific runtime contract is in [AGENTS.md](AGENTS.md).

## Repository map

| Path | Responsibility |
| --- | --- |
| [`packages/coding-agent`](packages/coding-agent) | Standalone CLI, TUI integration, sessions, tools, extensions, and harness policy |
| [`packages/agent`](packages/agent) | Agent state machine, tool execution, orchestration, and durable runtime primitives |
| [`packages/ai`](packages/ai) | Provider-neutral model, streaming, tool-call, usage, and cost interfaces |
| [`packages/tui`](packages/tui) | Terminal rendering and interactive input components |
| [`scripts`](scripts) | Build, release, installer, verification, and repository gates |
| [`.github/workflows`](.github/workflows) | Release artifact and verification automation |

The package directories are a source workspace and architectural map. They are not
separate npm products or a second installation path.

## Development

Contributor work requires Node.js and npm because the repository uses TypeScript,
workspace builds, and development checks. This is separate from end-user runtime
installation.

```bash
npm ci --ignore-scripts
npm run check
npm run build
```

Run the smallest targeted test for the code you changed. The repository contract in
[AGENTS.md](AGENTS.md) defines the required Detect → Verify → Score → Gate workflow,
coverage thresholds, red-test expectations, concurrency checks, and release rules.
Do not treat a successful command as evidence when a probe was skipped, truncated,
or failed.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before opening a
change. Contributions should identify an observable invariant, add or update a
focused regression test, explain rejected candidates and remaining risks, and keep
ownership in the authoritative subsystem. Do not commit generated artifacts or
change release behavior without corresponding verification evidence.

## Attribution and license

Pi Adaptative began from the open-source Pi codebase by Mario Zechner and
contributors. The adaptive harness, reliability work, packaging, and release
process in this repository are maintained independently. See the repository history
and package notices for source-level attribution.

This project is released under the [MIT License](LICENSE).
