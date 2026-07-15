# Windows

Pi supports native Windows on x64 and ARM64. The Node.js package runs under Windows Node.js; release archives contain a native `pi.exe`. WSL is optional, not required.

## Prerequisites

- Windows 10 or newer
- Node.js 22.19 or newer for the npm package
- [Git for Windows](https://git-scm.com/download/win), including Git Bash
- Windows Terminal, WezTerm, or the VS Code terminal for the best keyboard support

Pi keeps Bash as the command-tool contract on every platform so tool calls and project scripts have the same semantics. On Windows, Pi resolves Bash in this order:

1. `shellPath` in `%USERPROFILE%\.pi\agent\settings.json`
2. Git Bash under `Program Files`
3. `bash.exe` on `PATH` from MSYS2, Cygwin, or WSL

Git for Windows is the recommended native setup. Using its Bash subprocess does not make Pi a WSL application.

To configure another Bash:

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## Install

With npm:

```powershell
npm install -g --ignore-scripts @caupulican/pi-adaptative
pi
```

Or download `pi-windows-x64.zip` or `pi-windows-arm64.zip` from the matching GitHub release, extract it, and run `pi.exe`.

## Capability contract

A Windows release is expected to preserve the same Pi features as Linux and macOS. Platform prerequisites and operating-system concepts are called out explicitly instead of being silently downgraded.

| Capability | Windows contract | Repository acceptance evidence |
| --- | --- | --- |
| CLI, print, JSON, and RPC modes | Native | Full package build and test suite on `windows-latest` |
| Interactive TUI and configurable keybindings | Native | TUI tests on Windows; packaged `win32-console-mode.node`; Windows Terminal mappings below |
| `read`, `write`, `edit`, `grep`, `find`, and `bash` tools | Native; Bash prerequisite | Coding-agent tests on Windows; release `pi.exe` executes Bash through RPC |
| Provider APIs, OAuth, API-key auth, model routing, and retries | Native | AI, agent, and coding-agent tests on Windows; live credentials are not used in CI |
| Extensions, skills, prompts, themes, and pi packages | Native | Discovery, loading, reload, package-manager, and isolation tests on Windows |
| Sessions, branching, compaction, context storage, export, and sharing | Native | Agent and coding-agent session tests on Windows |
| Background delegation, goal continuation, reflection, and worker queues | Native | Delegation and liveness suites on Windows; no tmux dependency |
| Clipboard text, clipboard images, and image processing | Native | Windows native clipboard binding is packaged per architecture; conversion tests run headlessly |
| Managed `rg`, `fd`, Ollama, and Transformers runtimes | Native where the upstream runtime supports the architecture | Platform selection, install, process, and lifecycle tests on Windows |
| Toolkit scripts | Native | PowerShell, Bash, and `uv` runners use the same bounded process lifecycle |
| External editor and browser launch | Native | Windows process-launch tests; `$EDITOR`/`$VISUAL` and the default browser remain user choices |
| Self-update | npm and pnpm global installs | Windows native-dependency quarantine and update-path tests |
| Release binary | Native x64 and ARM64 | Each archive runs `--version`, `--help`, `--list-models`, RPC state, and an RPC Bash command on its matching GitHub-hosted Windows architecture |
| tmux agent manager | Available only when a real tmux is supplied by WSL, MSYS2, or Cygwin | Optional integration; core background delegation does not require tmux |
| Suspend with `Ctrl+Z` | Not an applicable Windows process concept | Pi reports the platform limitation instead of hanging or pretending to suspend |

The source-of-truth gates are [CI](https://github.com/Caupulican/pi-adaptative/actions/workflows/ci.yml) and [release binaries](https://github.com/Caupulican/pi-adaptative/actions/workflows/build-binaries.yml). Linux-only inspection is not accepted as Windows proof: the CI workflow runs the repository on a real Windows host, and the release workflow runs each Windows executable on its matching x64 or ARM64 host before publishing it.

Headless CI cannot assert a user's clipboard contents, complete an OAuth consent screen, or judge a terminal emulator's rendering. It does verify the code paths, native modules, process lifecycle, and release executables. Those external interactions remain terminal-, account-, or service-dependent rather than Windows capability downgrades.

## Windows Terminal keys

Windows Terminal consumes some modified key combinations unless they are forwarded. Open its JSON settings (`Ctrl+Shift+,`) and add these actions:

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    },
    {
      "command": { "action": "sendInput", "input": "\u001b[13;3u" },
      "keys": "alt+enter"
    }
  ]
}
```

- `Shift+Enter` inserts a newline.
- `Alt+Enter` queues a follow-up. This replaces Windows Terminal's default fullscreen binding.

See [Terminal setup](terminal-setup.md) for VS Code, WezTerm, and other terminals.

## Troubleshooting

### No Bash shell found

Install Git for Windows or set `shellPath` to an existing `bash.exe`. Confirm it from PowerShell:

```powershell
& "C:\Program Files\Git\bin\bash.exe" --version
```

### Modified Enter does not reach Pi

Apply the Windows Terminal mappings above, then fully close and reopen the terminal.

### Native module fails to load

Confirm that the package or archive matches the machine architecture (`x64` or `arm64`). Reinstall without lifecycle scripts:

```powershell
npm uninstall -g @caupulican/pi-adaptative
npm install -g --ignore-scripts @caupulican/pi-adaptative
```
