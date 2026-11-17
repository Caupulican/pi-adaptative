# Pi Adaptative

Pi Adaptative is a terminal coding agent for work that takes more than one sitting. Give it a goal, split the work among agents, and come back to see what changed, what was verified, and what still needs your call.

You can start with a question about one file. When that question turns into a project, the same conversation can coordinate workers, keep track of decisions, and bring you back when CI has news.

[Install Pi](#install-pi) · [Try a first task](#try-a-first-task) · [Browse the docs](packages/coding-agent/docs/index.md)

## Install Pi

The standalone installers support Linux and Windows on x64 and arm64. They verify the download and keep the previous version available for rollback. Node.js and npm are only needed for development.

**Linux**

```sh
curl -fsSL https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.ps1 | iex
```

Prefer to inspect the installer or download an archive yourself? The release includes both scripts, platform archives, and `SHA256SUMS`. [Latest release](https://github.com/Caupulican/pi-adaptative/releases/latest)

## Try a first task

Open a terminal in a repository you know and run `pi`. Inside Pi, use `/login` to connect a supported subscription, or set your provider's API key before launching. Use `/model` to choose a model. [Provider setup](packages/coding-agent/docs/providers.md)

Start with a question whose answer you can check against your code:

> Trace one request from its entry point to storage. Show me where a failed write reaches the caller, with file references. Leave the code unchanged.

Then put the team to work:

> Have two workers review that path. One should look for lost writes, the other for duplicate writes on retry. Bring me their evidence and a proposed fix before editing.

Open `/plan` to inspect a plan Pi has created. When you return to the repository later, `pi -c` continues your most recent session. [Plans](packages/coding-agent/docs/plans.md) · [Sessions](packages/coding-agent/docs/sessions.md)

## What makes Pi adaptative?

**Keep a specialist you can come back to.** A bot has a name, model, and conversation of its own. Create a reviewer, give it a brief, and follow up with the same bot after your next change. Bring several bots into a group chat, or appoint a leader to coordinate workers toward a goal. [Bots, teams, and leaders](packages/coding-agent/docs/bots-and-groups.md)

```text
/bot new reviewer
/bot msg reviewer Review my current diff for changes that could break existing callers.
```

**Give parallel work a finish line.** A plan records which steps depend on each other, which files each worker may change, and how their results come together. For a change spanning a CLI and its docs, Pi can assign separate worktrees, collect both changes, and give another worker the verification step. The plan survives closing and reopening the session. [How plans work](packages/coding-agent/docs/plans.md)

**Teach Pi how you work.** Pi can retain project decisions and standing preferences, such as how your team names migrations. When you and Pi work out a repeatable procedure, type `/skillify` to turn that session into a reusable skill. You review the draft and decide whether to activate it. [Memory](packages/coding-agent/docs/memory.md) · [Self-adaptation](packages/coding-agent/docs/self-adaptation.md)

**Tell Pi what deserves an interruption.** Ask “Tell me the next time CI fails,” or let an idle review surface a loose end. Reviews have configurable spending and wake-up limits. Use `/proactivity status` to see what ran or why Pi stayed quiet, and `/proactivity off` to disable idle reviews. [Proactive reviews and routines](packages/coding-agent/docs/proactivity.md)

## Everyday commands

| When you want to… | Use |
| --- | --- |
| Start work in the current repository | `pi` |
| Pick an earlier conversation | `pi -r` |
| See which models are available | `pi --list-models` |
| See your bots inside Pi | `/bot list` |
| Update the standalone installation now | `pi update --self` |

Managed installs also pick up new stable releases automatically. Your running session keeps its current binary until the next start. [Quickstart](packages/coding-agent/docs/quickstart.md) · [CLI reference](packages/coding-agent/docs/usage.md)

## Build on Pi

Extend Pi with a project-specific tool, bring your own model provider, or embed the agent in another application. [Extensions](packages/coding-agent/docs/extensions.md) · [Custom providers](packages/coding-agent/docs/custom-provider.md) · [SDK](packages/coding-agent/docs/sdk.md)

The TypeScript workspace contains the [coding agent](packages/coding-agent), [provider layer](packages/ai), and [terminal UI](packages/tui). For a source checkout, use the Node.js version in `.nvmrc` and run:

```sh
npm ci --ignore-scripts
npm run build
```

See the [architecture map](docs/architecture.md), [contributor guide](CONTRIBUTING.md), and [repository instructions](AGENTS.md) before making changes.

Pi Adaptative began with the open-source Pi codebase by Mario Zechner and contributors. This project independently maintains the adaptive harness and standalone releases. [MIT License](LICENSE)
