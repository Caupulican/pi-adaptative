# Windows

Pi supports native Windows on x64 and ARM64. The Node.js package runs under Windows Node.js; release archives contain a native `pi.exe`. WSL is optional, not required.

## Prerequisites

- Windows 10 or newer
- Node.js 22.19 or newer for the npm package
- Windows PowerShell 5.1 or PowerShell 7
- Git for Windows for native Git commands
- Windows Terminal, WezTerm, or the VS Code terminal for the best keyboard support

The model always sees one stable `bash` tool contract. On Windows, a deterministic router classifies every command into one of three tiers instead of parsing the full Bash grammar in one place:

1. **PowerShell floor** (always available): one simple command — a bounded set of builtin translations or a quoted external argv — converted deterministically to PowerShell, exactly as before this tier existed.
2. **Bundled Python engine** (uv-provisioned Python 3.13, on by default): pipelines, redirection, chaining, quoting, expansion, globs, and the coreutils vocabulary below, plus every state-mutating command (`cd`, `export`, `unset`), which the engine always owns so there is a single mutator.
3. **Named fail-closed refusal**: constructs outside the supported grammar (see below) return an actionable error naming the construct instead of guessing or downgrading silently.

The agent never selects a shell or emits native PowerShell or Python. Pi resolves the PowerShell executable in this order:

1. `shellPath` in `%USERPROFILE%\.pi\agent\settings.json`
2. PowerShell 7 (`pwsh.exe`) on `PATH` or under `Program Files`
3. Windows PowerShell (`powershell.exe`) under `System32` or on `PATH`

The PowerShell tier runs with `-NoLogo -NoProfile -NonInteractive -Command` and a best-effort UTF-8 console-output prefix. Every agent, interactive, and RPC shell call has a 120-second wall-clock default, even while output continues.

### Supported forms

| Grammar | Forms | Notes |
| --- | --- | --- |
| Pipeline | `a \| b \| c` | Real OS pipes, binary-safe; exit code is the last element's (after `!`). |
| Sequencing | `a ; b`, newline-separated, `a && b`, `a \|\| b`, `! pipeline` | Left-to-right / short-circuit / negation, bash-standard. |
| Subshell | `( … )` | Isolated cwd/env copy — inner `cd`/`export` do not leak out. |
| Brace group | `{ …; }` | Shares state — inner `cd`/`export` persist. |
| Redirection | `>`, `>>`, `1>`, `1>>`, `<`, `2>`, `2>>`, `2>&1`, `&>`, `>&` | `/dev/null` maps to `os.devnull`. A builtin's stderr is merged into its own stdout (one sink) — an explicit `2>file` on a builtin does not capture its error text; external commands capture normally. |
| Quoting | `'…'`, `"…"`, `\x`, `$'…'` | Standard single/double/backslash/ANSI-C semantics. |
| Tilde | `~`, `~/x` | Word-start, unquoted, expands to `$HOME`. `~user` is unsupported (refusal). |
| Parameter expansion | `$VAR`, `${VAR}`, `${V:-w}`, `${V:=w}`, `${V:+w}`, `${V:?w}`, `${#VAR}` | POSIX `:`-prefixed (empty-or-unset) semantics only; other `${…}` operators refuse. |
| Command substitution | `$(…)`, `` `…` `` | Runs through the same executor; trailing newlines stripped; nesting bounded to depth 8. |
| Glob | `*`, `?`, `[…]` | Case-sensitive, `/`-normalized, ordinal (`LC_ALL=C`) sort; final path segment only; no match falls back to the literal word. |
| Assignment | `NAME=value` (standalone or prefixed to a command) | Standalone sets engine env for the session; prefixed applies only to that command. No shell-var/exported-env split — every assignment sets env. |

Builtins: `cd`, `pwd`, `echo [-n -e -E]`, `printf`, `export`, `unset`, `true`, `false`, `which`, `test`/`[`, `ls [-a -A -1 -r]`, `cat`, `head [-n N]`, `tail [-n N]`, `grep [-i -v -n -c -l -w -F -E]`, `find [-type f|d] [-name GLOB]`, `rm [-f -r -rf]`, `cp [-r|-R]`, `mv`, `mkdir [-p]`, `touch`, `wc [-l -w -c -m]`, `sort [-r -n -u -f]`, `uniq [-c -d -u -i]`, `cut -d/-f` or `-c`, `tr [-d -s -c]`, `basename`, `dirname`, `sed 's/RE/REPL/[g][i]'` (substitute only), `xargs [-0 -n -I]`. An unknown flag on a listed builtin, or any builtin/form not listed, returns a named `unsupported-flag`/`unsupported-builtin` refusal rather than a guess.

### Divergences from bash (intentional, documented)

- `grep`/`sed` regex is Python `re`, not POSIX BRE/ERE.
- `ls`/`find` output always uses a trailing `/` on directories, `/`-normalized paths, and ordinal sort — matching the PowerShell floor so output is identical regardless of which tier ran.
- `wc`/`uniq -c` column widths reproduce GNU's dynamic field width only for the single-count stdin case; multi-count/file-arg forms use fixed deterministic padding.
- No shell-variable vs. exported-environment distinction: every `NAME=value` sets engine env.
- Sorting is always ordinal (`LC_ALL=C`): globs, `ls`, `find`, and default `sort`.
- A builtin's stderr is merged into its own stdout; only external commands honor an explicit `2>`.
- Globs expand only the final path segment (`dir/*.py` works; `*/x.py` matches the directory part literally).
- `wc -m` counts UTF-8 characters (bash under `LC_ALL=C` counts bytes).

### Named unsupported constructs

Each of these fails closed with a named, actionable error instead of an approximation: `job-control` (trailing `&`, `fg`/`bg`/`jobs`/`wait`/`disown`), `process-substitution` (`<(…)`/`>(…)`), `arithmetic-expansion` (`$((…))`, `((…))`, `let`), `brace-expansion` (`{a,b,c}`), `nested-shell` (`bash`/`sh`/`cmd`/`powershell`/`pwsh`/`wsl`/… as a command word), `exec-builtin`, `heredoc`/`here-string` (`<<`, `<<-`, `<<<`), `function-definition`, `control-flow` (`if`/`for`/`while`/`until`/`case`/`select`), `extended-glob` (`@(…)`, `!(…)`, etc.), `unsupported-builtin` (`eval`, `source`/`.`, `alias`, `trap`, `set`, `shopt`, `read`, `declare`, `local`), `unsupported-flag`, `posix-script` (`*.sh`, `/bin/…`), `cwd-missing`, `tilde-user`, `malformed-syntax` (unbalanced quote/paren/brace, empty pipeline element, missing redirect target), `parameter-expansion` (a `${…}` form outside the supported op set).

### State and session semantics

`cd`, `export`, and `unset` always route to the Python engine, the sole mutator of session state (working directory and environment). That state is held once per agent session and read by both tiers: the next call — whether it routes to the PowerShell floor or back to the engine — sees the updated cwd/env. A subshell `( … )` runs against an isolated copy and never leaks its `cd`/`export` back out; a brace group `{ …; }` shares and persists state like the top level.

### The `windowsShell.pythonEngine` setting and degradation

`windowsShell.pythonEngine` (default `true`) is the kill switch. Set it to `false` to restore the PowerShell-only contract verbatim: only the simple-command floor is used, and every pipeline/redirection/expansion/chaining form that would have routed to the engine instead returns the same fail-closed error it did before the engine existed.

When the setting is left on but the bundled Python runtime cannot be resolved (uv missing, network failure provisioning Python 3.13, or similar), the engine tier is simply unavailable: simple commands still run on the PowerShell floor exactly as always, and any command that needs the engine returns a named error stating the Python runtime is unavailable, that the simple-command floor still works, and to fix `uv`/network to restore pipelines, redirection, expansion, and chaining. There is no silent approximation — a complex command is never downgraded to a plausible-but-wrong simple execution.

The native `python` tool uses the same contract on Windows and Unix-like systems. Pi provisions a pinned uv executable, resolves or installs Python 3.13 through uv, then spawns the interpreter directly with UTF-8 and bytecode-cache suppression. Python calls default to 30 seconds. See [Native Python](python.md).

To select an explicit PowerShell executable:

```json
{
  "shellPath": "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
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
| `read`, `write`, `edit`, `grep`, `find`, and stable `bash` contract tools | Native; Bash-like commands are routed deterministically across a PowerShell floor and a bundled Python shell engine (pipelines, redirection, chaining, expansion, coreutils), with named refusals outside that grammar | Router/platform-shell tests, engine conformance suite, Linux differential bash-oracle suite, and Windows cross-tier integration tests, plus native Windows CI; release `pi.exe` executes the platform shell through RPC |
| Provider APIs, OAuth, API-key auth, model routing, and retries | Native | AI, agent, and coding-agent tests on Windows; live credentials are not used in CI |
| Extensions, skills, prompts, themes, and pi packages | Native | Discovery, loading, reload, package-manager, and isolation tests on Windows |
| Sessions, branching, compaction, context storage, export, and sharing | Native | Agent and coding-agent session tests on Windows |
| Background delegation, goal continuation, reflection, and worker queues | Native | Delegation and liveness suites on Windows; no tmux dependency |
| Clipboard text, clipboard images, and image processing | Native | Windows native clipboard binding is packaged per architecture; conversion tests run headlessly |
| Managed `rg`, `fd`, Ollama, and Transformers runtimes | Native where the upstream runtime supports the architecture | Platform selection, install, process, and lifecycle tests on Windows |
| Toolkit scripts | Native | PowerShell, Bash, and `uv` runners use the same bounded process lifecycle |
| External editor and browser launch | Native | Windows process-launch tests; `$EDITOR`/`$VISUAL` and the default browser remain user choices |
| Self-update | npm and pnpm global installs | Windows native-dependency quarantine and update-path tests |
| Release binary | Native x64 and ARM64 | Each archive runs `--version`, `--help`, `--list-models`, RPC state, and an RPC platform-shell command on its matching GitHub-hosted Windows architecture |
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

### No PowerShell executable found

Restore Windows PowerShell, install PowerShell 7, or set `shellPath` to an existing `pwsh.exe`/`powershell.exe`. Confirm discovery from a terminal:

```powershell
Get-Command pwsh, powershell -ErrorAction SilentlyContinue
```

### Modified Enter does not reach Pi

Apply the Windows Terminal mappings above, then fully close and reopen the terminal.

### Native module fails to load

Confirm that the package or archive matches the machine architecture (`x64` or `arm64`). Reinstall without lifecycle scripts:

```powershell
npm uninstall -g @caupulican/pi-adaptative
npm install -g --ignore-scripts @caupulican/pi-adaptative
```
