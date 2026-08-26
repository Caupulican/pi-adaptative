# Quickstart

This page gets you from install to a useful first pi session.

## Install

Pi Adaptative is distributed as standalone Linux and Windows releases. On Linux:

```bash
curl -fsSL https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.sh | sh
```

The installer downloads and verifies the release binary and places a managed `pi` launcher on your `PATH`. Re-run the command to update to the latest release. On Windows, run the native PowerShell installer:

```powershell
irm https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.ps1 | iex
```

The standalone CLI does not require Node.js or npm. Those tools are needed only when building from source or developing extension/package code.

### Uninstall

Remove the default managed launcher on Linux only after verifying that it points into the standalone install tree. This leaves settings, credentials, sessions, and installed pi packages in `~/.pi/agent/`:

```sh
launcher="$HOME/.local/bin/pi"
managed_pi="${XDG_DATA_HOME:-$HOME/.local/share}/pi-adaptative/current/pi"
if [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$managed_pi" ]; then
	rm -f -- "$launcher"
else
	printf '%s\n' "Refusing to remove an unmanaged pi launcher: $launcher" >&2
	exit 1
fi
```

If you used `PI_INSTALL_DIR` or `PI_BIN_DIR`, substitute those locations. After inspecting it, remove the managed `pi-adaptative` install directory to reclaim the downloaded binaries. The installer never stores user data there.

Then start pi in the project directory you want it to work on:

```bash
cd /path/to/project
pi
```

## Authenticate

Pi can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start pi and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching pi:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

You can also run `/login` and select an API-key provider to store the key in `~/.pi/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once pi starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, pi gives the model four tools:

- `read` - read files
- `write` - preflight and create new files without overwriting existing paths
- `edit` - preflight and patch existing files with stale-target checks
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. Pi runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give pi project instructions

Global instructions live in `~/.pi/agent/AGENTS.md` and are always injected. Add a repo `AGENTS.md` for project conventions; Pi lists that path and the agent reads it on demand:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Pi discovers:

- `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` in `~/.pi/agent/` for global instructions (always injected)
- global and bundled skills
- project `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` paths, project `.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md` system-prompt overrides, and project-scoped extensions, skills, and prompt templates only after project instructions are enabled

Project instructions are off by default. Use `/settings` → **Project instructions** and choose **on-demand** to admit those project instruction resources. Choose **global-only** to exclude them while preserving trusted global/bundled resources and inert project themes. Explicit built-in SDK file paths do not bypass this choice; see [SDK: Project Instructions](sdk.md#project-instructions). The canonical operator boundary is in [Project Instructions](settings.md#project-instructions). Restart Pi, or run `/reload`, after changing the setting or global instruction files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
pi @README.md "Summarize this"
pi @src/app.ts @src/app.test.ts "Review these together"
```

Images can be pasted with Ctrl+V (Alt+V on Windows) or dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
pi -c                  # Continue most recent session
pi -r                  # Browse previous sessions
pi --name "my task"    # Set session display name at startup
pi --session <path|id> # Open a specific session
```

Inside pi, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
pi -p "Summarize this codebase"
cat README.md | pi -p "Summarize this text"
pi -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Pi](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Pi Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
