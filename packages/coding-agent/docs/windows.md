# Windows

Pi supports native Windows on x64 and ARM64. The standalone release archives contain a native `pi.exe`. WSL is optional, not required.

## Prerequisites

- Windows 10 or newer
- PowerShell 7 (`pwsh.exe`)
- Git for Windows for native Git commands
- Windows Terminal, WezTerm, or the VS Code terminal for the best keyboard support

The model always sees one stable `bash` tool contract, and on Windows it can write ordinary Linux bash. Every call runs through one executor:

1. **Bundled shell engine** (uv-provisioned Python 3.13, on by default): parses the supported Bash grammar below (pipelines, redirection, chaining, loops, conditionals, `case`, functions, `[[ ]]`, brace expansion, parameter operators, arithmetic, quoting, globs) and owns the session state (`cd`, `export`, `unset`). Coreutils, findutils, grep, sed, awk, diff and the rest of the GNU vocabulary run as the **real GNU binaries from Git for Windows** (`usr\bin`, discovered from the `git` on PATH once per session) with their full native flag surface, so `ls -lt`, `find -maxdepth 2 -iname`, `grep -RIn --include`, `stat -c`, `sed -n '1,80p'`, `awk`, `xargs -0`, `seq`, `sha256sum` and `uname` behave as on Linux. The engine's own Python builtins answer only on a host without Git for Windows. Every other program (`git`, `rg`, `node`, `python`, `dotnet`, `.cmd`/`.bat`/`.ps1` scripts) is spawned directly, never through a nested model-authored shell; a `.ps1` target runs through the selected PowerShell 7 host.
2. **PowerShell floor** (`windowsShell.pythonEngine: false`, or the moment the engine's runtime cannot start): one simple command per call, a bounded set of builtin translations or a quoted external argv, converted deterministically to PowerShell.
3. **Named fail-closed refusal**: constructs outside the supported grammar (see below) return an actionable error naming the construct instead of guessing or downgrading silently.

Shell persistence preserves process state; it does not require every raw command byte to remain in model context. Recognized single test-runner commands use a bounded command-aware projection after execution: passing/progress chatter is counted, failure blocks and summaries remain visible, exit status is unchanged, and exact raw bytes are saved to the reported managed path. Mixed commands and unknown nonzero formats stay raw, and Pi also falls back to raw output if it cannot create the exact-output handoff.

The agent never selects a shell or emits native PowerShell or Python. Pi accepts only PowerShell 7 and resolves its executable in this order:

1. A `shellPath` ending in `pwsh.exe` in `%USERPROFILE%\.pi\agent\settings.json`
2. PowerShell 7 (`pwsh.exe`) on `PATH` or under `Program Files`

The PowerShell tier runs with `-NoLogo -NoProfile -NonInteractive -Command`. Pi applies process-only headless settings before startup: PowerShell telemetry, update notifications, diagnostic IPC, ANSI color, and progress rendering are disabled. It warms the long-lived command path once, then reuses that process. Pi gives managed PowerShell output a UTF-8 writer without overwriting `[Console]::InputEncoding`, `[Console]::OutputEncoding`, or `$OutputEncoding`, so native programs retain their code-page choice. The Windows output decoder preserves valid Unicode UTF-8 and recovers Windows-1252 bytes, including mixed streams and UTF-8 sequences split across chunks. Pi's private command framing remains line-safe Base64 with ASCII control markers. Every agent, interactive, and RPC shell call has a 120-second wall-clock default, even while output continues.

### Supported forms

| Grammar | Forms | Notes |
| --- | --- | --- |
| Pipeline | `a \| b \| c` | Real OS pipes, binary-safe; exit code is the last element's (after `!`). |
| Sequencing | `a ; b`, newline-separated, `a && b`, `a \|\| b`, `! pipeline` | Left-to-right / short-circuit / negation, bash-standard. |
| Subshell | `( … )` | Isolated cwd/env copy — inner `cd`/`export` do not leak out. |
| Brace group | `{ …; }` | Shares state — inner `cd`/`export` persist. |
| Functions | `name() { …; }`, `function name { …; }`, `return [N]`, `local NAME[=value]`, `shift [N]`, `$1`…`$9`, `${10}`, `$@`, `$*`, `$#`, `"$@"` | Functions live for the call; they share cwd/env with the caller and `local` names are restored on return. `"$@"` keeps one field per argument. |
| Case | `case word in pattern\|pattern) …;; esac` with `;;`, `;&` (fall through), `;;&` (keep testing) | Patterns are globs; the subject and patterns expand without splitting. |
| Conditional | `[[ expr ]]` with `-e -f -d -s -r -w -x -L -z -n -v`, `== = != < >`, `=~` (Python `re`), `-eq -ne -lt -le -gt -ge`, `-nt -ot -ef`, `!`, `( )`, `&&`, `\|\|` | An unquoted right-hand side of `==` is a glob pattern, a quoted one is literal. A malformed expression exits 2 with a named message. |
| Brace expansion | `{a,b}`, `{1..5}`, `{01..10}`, `{a..e}`, nested and with prefixes/suffixes | Runs on the unquoted word text before any other expansion; `'{a,b}'`, `"{a,b}"`, `${x}` and `{}` stay literal. |
| Shell options | `set -e`, `-u`, `-x`, `-o pipefail` (and `+` to clear), `set -- args` | `-e` ends the run on a failing pipeline except in tested positions (`if`/`while` conditions, `!`, all but the last of `&&`/`\|\|`); `-u` fails the command on an unset variable; `-x` traces `+ argv`; `pipefail` returns the last non-zero stage. Any other `set` option refuses by name. |
| For loop | `for name in words; do …; done`, `for name; do …; done`, `for ((init; condition; update)); do …; done` | Word lists expand once before iteration; the final value remains in the session environment. The omitted-list form iterates shell positional arguments, which Pi does not supply. Arithmetic clauses support integer variables, updates, assignments, comparisons, logical/bitwise operators, and signed 64-bit wrapping. |
| Loop control | `break [N]`, `continue [N]` | Works across nested word-list and arithmetic loops. An omitted count means one; invalid counts report status 1 without crashing the coordinator. |
| Arithmetic | `$((expr))`, `((expr))`, `let expr…` | Integer arithmetic over variables, with `$VAR`, `${#VAR}`, and `$(…)` expanded inside the expression first; assignments and `++`/`--` write back to the session environment. `((expr))` and `let` exit 0 for a non-zero value. Division by zero or a malformed expression fails only the command containing it (status 1, `bash: <expr>: <reason>`); the rest of the command list keeps running. |
| Redirection | `>`, `>>`, `1>`, `1>>`, `<`, `2>`, `2>>`, `2>&1`, `&>`, `>&` | `/dev/null` maps to `os.devnull`. Unredirected stderr shares Pi's session output; explicit stderr redirection is honored for builtins, state commands, and external programs. |
| Quoting | `'…'`, `"…"`, `\x`, `$'…'` | Standard single/double/backslash/ANSI-C semantics. |
| Tilde | `~`, `~/x` | Word-start, unquoted, expands to `$HOME`. `~user` is unsupported (refusal). |
| Parameter expansion | `$VAR`, `$?`, `$$`, `$0`, `${VAR}`, `${V:-w}`, `${V:=w}`, `${V:+w}`, `${V:?w}`, `${#VAR}`, `${V#p}`, `${V##p}`, `${V%p}`, `${V%%p}`, `${V/p/r}`, `${V//p/r}`, `${V/#p/r}`, `${V/%p/r}`, `${V:offset}`, `${V:offset:length}`, `${V^^}`, `${V,,}`, `${V^}`, `${V,}` | `$?` is the latest foreground pipeline status. Patterns are globs with bash's greedy matching; offsets are arithmetic (negative counts from the end). Arrays (`${a[i]}`) and indirection (`${!name}`) refuse by name. |
| Command substitution | `$(…)`, `` `…` `` | Runs through the same executor; trailing newlines stripped; nesting bounded to depth 8. |
| Glob | `*`, `?`, `[…]` | Case-sensitive, `/`-normalized, ordinal (`LC_ALL=C`) sort; final path segment only; no match falls back to the literal word. |
| Assignment | `NAME=value` (standalone or prefixed to a command) | Standalone sets engine env for the session; prefixed applies only to that command. No shell-var/exported-env split — every assignment sets env. |

Engine builtins that always run in the engine: `cd`, `pwd`, `echo [-n -e -E]`, `printf`, `export`, `unset`, `exit [N]`, `true`, `false`, `which`, `test`/`[` (with `-a`/`-o`), `command [-v]`, `return`, `local`, `shift`, `set`, `break`, `continue`, `let`. GNU-preferred names (`ls dir find grep egrep fgrep sed awk gawk wc head tail sort uniq cut tr cat stat xargs tee diff cmp file date env basename dirname realpath readlink touch mkdir rm cp mv du df`) run the real binary from `windowsShell.gnuToolsDir` when it exists there, and any other bare name that PATH lacks but that directory holds (`seq`, `sha256sum`, `tac`, `uname`, `tar`, `bash`, …) is filled in from it after PATH. Only on a host without those binaries do the engine's own bounded reimplementations answer: `ls [-a -A -1 -l -r]`, `cat`, `head [-n N|-N]`, `tail [-n N|-N]`, `grep [-i -v -n -c -l -w -F -E -I -r -R]`, `find [-mindepth/-maxdepth N] [-type f|d] [-name|-iname|-path GLOB] [-not|-o|( )] [-print|-print0|-printf FMT|-delete|-exec CMD… ;|+]`, `rm [-f -r -rf]`, `cp [-r|-R]`, `mv`, `mkdir [-p]`, `touch`, `wc [-l -w -c -m]`, `sort [-r -n -u -f]`, `uniq [-c -d -u -i]`, `cut -d/-f` or `-c`, `tr [-d -s -c]`, `basename`, `dirname`, `sed [-n -e -E] 'addr[,addr]p|d|s///'`, `xargs [-0 -n -I]`; an unknown flag on one of them returns a named `unsupported-flag` refusal rather than a guess.

### Divergences from bash (intentional, documented)

- `grep`/`sed` regex is Python `re`, not POSIX BRE/ERE.
- The engine's own `ls`/`find` (hosts without Git for Windows) print a trailing `/` on directories, `/`-normalized paths, and ordinal sort; the real GNU tools print exactly what they print on Linux.
- `wc`/`uniq -c` column widths reproduce GNU's dynamic field width only for the single-count stdin case; multi-count/file-arg forms use fixed deterministic padding.
- No shell-variable vs. exported-environment distinction: every `NAME=value` sets engine env.
- Sorting is always ordinal (`LC_ALL=C`): globs, `ls`, `find`, and default `sort`.
- Arithmetic loop variables use deterministic signed 64-bit wrapping; invalid shifts, division by zero, negative exponents, and malformed expressions return status 1 with a bounded diagnostic.
- Globs expand only the final path segment (`dir/*.py` works; `*/x.py` matches the directory part literally).
- `wc -m` counts UTF-8 characters (bash under `LC_ALL=C` counts bytes).

### Named unsupported constructs

Each of these fails closed with a named, actionable error instead of an approximation: `job-control` (trailing `&`, `fg`/`bg`/`jobs`/`wait`/`disown`), `process-substitution` (`<(…)`/`>(…)`), `array` (`name=(…)`, `${name[i]}`, `declare -a`, `mapfile`), `exec-builtin`, `control-flow` (`select`, `coproc`), `extended-glob` (`@(…)`, `!(…)`, etc.), `unsupported-builtin` (`eval`, `source`/`.`, `alias`, `trap`, `shopt`, `read`, `readonly`), `unsupported-flag` (an engine builtin's unknown flag, or a `set` option outside `-e -u -x -o pipefail`), `cwd-missing`, `tilde-user`, `malformed-syntax` (unbalanced quote/paren/brace, empty pipeline element, missing redirect target, a leading `&` written as PowerShell's call operator, malformed `for`/`case`/`[[`), `parameter-expansion` (indirection `${!name}` and other `${…}` forms outside the supported set). `brace-expansion`, `function-definition`, `heredoc`, `here-string`, `nested-shell`, `posix-script` and `arithmetic-expansion` remain in the refusal catalog for stability but are no longer raised: all of those constructs are implemented.

### State and session semantics

`cd`, `export`, and `unset` run in the engine, the sole mutator of session state (working directory and environment). That state is held once per agent session, and the floor reads it too when it has to step in: a call that lands on PowerShell during a runtime outage still sees the engine's cwd/env. A subshell `( … )` runs against an isolated copy and never leaks its `cd`/`export` back out; a brace group `{ …; }` shares and persists state like the top level.

`exit [N]` is a controlled engine builtin: it stops the current shell boundary while still emitting Pi's terminal control frame. An `exit` inside a subshell remains local to that subshell.

An agent session warms its coordinator during startup, so the model's first command does not pay the Python start; the interpreter and engine imports then stay warm in that one coordinator process per agent session. A coordinator and its cwd/environment state are keyed by that session's private identity and are never shared process-wide with another interactive, RPC, or embedded session. Commands within one session are serialized, and Node remains the only owner of cwd/environment state: it sends the current state with each request and applies a result only after matching output and control terminal signals arrive. An abort, hard timeout, coordinator crash, malformed frame, or stale request ID kills only that session's coordinator tree; the next command lazily starts a clean process from the last acknowledged Node-owned state. Command stdin remains EOF and cannot consume coordinator protocol input.

### The `windowsShell.pythonEngine` setting and degradation

`windowsShell.pythonEngine` (default `true`) is the kill switch. Set it to `false` to restore the PowerShell-only contract verbatim: only the simple-command floor is used, and every pipeline/redirection/expansion/chaining form that would have routed to the engine instead returns the same fail-closed error it did before the engine existed.

`windowsShell.gnuToolsDir` (default `"auto"`) tells the engine where the real GNU tools live. `"auto"` finds Git for Windows' `usr\bin` from the `git` on PATH (or under Program Files) once per session; `"off"` keeps every coreutils name on the engine's own builtins; an explicit directory must hold `ls.exe` and `find.exe`, otherwise the shell tool reports the setting instead of silently using the builtins. The directory is never prepended to the session PATH: only the GNU-preferred names and otherwise-missing bare names resolve there, so `git`, `python`, `rg` and `node` resolve exactly as before.

An extension that supplies its own `operations` for `user_bash` (or any embedder passing a custom backend) owns execution: on Windows that backend receives the simple-command floor contract and the local engine never runs, because the engine executes on this machine, which is exactly what a custom backend replaces.

When the setting is left on but the bundled Python runtime cannot be resolved (uv missing, network failure provisioning Python 3.13, or similar), the engine is unavailable: a simple command the floor can express runs on PowerShell with the engine's cwd/env, and any command that needs the engine returns a named error stating the Python runtime is unavailable together with the floor's own refusal, and to fix `uv`/network to restore the full grammar. There is no silent approximation — a complex command is never downgraded to a plausible-but-wrong simple execution.

The native `python` tool uses the same contract on Windows and Unix-like systems. Pi provisions a pinned uv executable, resolves or installs Python 3.13 through uv, then spawns the interpreter directly with UTF-8 and bytecode-cache suppression. Python calls default to 30 seconds. See [Native Python](python.md).

To select an explicit PowerShell executable:

```json
{
  "shellPath": "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
}
```

### Evaluating and evolving the shell contract from real sessions

The harness measures its own bash contract against the commands models actually wrote, on this machine or on another one, without ever storing a private command:

```
node scripts/windows-shell-corpus.mjs evaluate                       # this machine's ~/.pi/agent/sessions
node scripts/windows-shell-corpus.mjs evaluate --sessions <extracted .pi/agent/sessions from another machine> --platform win32
node scripts/windows-shell-corpus.mjs harvest --write                # append the new shapes to the corpus fixture
node scripts/windows-shell-corpus.mjs replay                         # the corpus wall, on demand
```

`harvest` turns every `bash` tool call in the transcripts into a shape: the grammar (operators, quoting, flags, keywords, expansions, path depth and spelling, regex and printf metacharacters) is kept byte for byte, every identifier, path component, hostname and literal becomes a synthetic token, a leak guard drops any shape that still carries a raw identifier, and each shape records the verdict the engine's grammar gives the real command so named refusals stay named. `replay` runs the fixture through the router, the grammar and, for every shape whose command names the harness owns, the real executor with the real GNU tools, and prints every defect. `evaluate` is both. `--write` appends the new shapes to `test/fixtures/windows-shell-corpus/commands.json` with stable ids, which is how a live failure becomes a regression shield before its fix lands; the wall (`test/windows-shell-corpus.test.ts`) replays that fixture in CI on Linux and Windows. The tool is `pi-shell-engine/corpus.py`, shipped with the runtime, so an installed pi can run it against its own sessions.

## Install

The native PowerShell installer downloads and verifies the matching archive:

```powershell
irm https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.ps1 | iex
```

Alternatively, download the matching archive from [Caupulican/pi-adaptative releases](https://github.com/Caupulican/pi-adaptative/releases/latest), verify it against `SHA256SUMS`, extract it, and run `pi.exe`:

- `pi-windows-x64.zip` for standard 64-bit Windows
- `pi-windows-arm64.zip` for Windows on ARM

The archive is standalone and does not require Node.js or npm. Re-run the PowerShell installer to update safely; it verifies the archive and keeps the previous version available for rollback. Manual archive extraction is an advanced fallback only. To uninstall, remove the managed install directory; your settings, credentials, sessions, and installed pi packages under `%USERPROFILE%\.pi\agent\` are preserved.

The installer also ensures optional [Herdr collaboration](herdr-installation.md) through the activated Pi executable and reports availability or a non-fatal warning. It does not start Herdr or install unrelated tools.

## Incident collection

The Windows release archive includes `collect-pi-incident.ps1` beside `pi.exe`. Run it from native PowerShell on the machine and Windows account where the failure happened:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\collect-pi-incident.ps1
```

This explicit `powershell.exe` invocation is an isolated Windows incident-collection integration, not the agent shell. The agent shell itself requires `pwsh.exe`.

From a source checkout, use `-File .\scripts\collect-pi-incident.ps1`. The collector selects the latest human session by default and creates `pi-incident-<timestamp>.zip` beside the collector script. To select exact evidence or another destination:

```powershell
.\collect-pi-incident.ps1 `
  -Session "$env:USERPROFILE\.pi\agent\sessions\project\affected-session.jsonl" `
  -CommandLog "C:\Temp\pi-console.log" `
  -OutputDir "C:\Temp"
```

The archive contains the selected session, its session-owned orchestration records, matching recovery/failure rows, bounded TUI evidence, environment and installed-runtime fingerprints, and relevant Windows events from the session window plus 15 minutes on each side. Global recovery and failure logs are filtered by session identity or timestamp instead of being copied wholesale. If the session has no usable timestamps, `-EventHours` supplies a collection-time fallback window (24 hours by default). It does not scan or copy `auth.json`, `settings.json`, dotenv files, or vault files. Session and diagnostic output may still contain prompts, source text, paths, and commands; review the ZIP before sharing it.

## Capability contract

A Windows release is expected to preserve the same Pi features as the Linux release. Platform prerequisites and operating-system concepts are called out explicitly instead of being silently downgraded.

| Capability | Windows contract | Repository acceptance evidence |
| --- | --- | --- |
| CLI, print, JSON, and RPC modes | Native | Full package build and test suite on `windows-latest` |
| Interactive TUI and configurable keybindings | Native | TUI tests on Windows; packaged `win32-console-mode.node`; Windows Terminal mappings below |
| `read`, `write`, `edit`, `grep`, `find`, and stable `bash` contract tools | Native; every Bash-like command runs on the bundled shell engine with Git for Windows' real GNU tools, the PowerShell floor serves only the off switch and a runtime outage, and constructs outside the grammar refuse by name | Router/platform-shell tests, engine conformance suite, Linux differential bash-oracle suite, and Windows cross-tier integration tests, plus native Windows CI; release `pi.exe` executes the platform shell through RPC |
| Provider APIs, OAuth, API-key auth, model routing, and retries | Native | AI, agent, and coding-agent tests on Windows; live credentials are not used in CI |
| Extensions, skills, prompts, themes, and pi packages | Native | Discovery, loading, reload, package-manager, and isolation tests on Windows |
| Sessions, branching, compaction, context storage, export, and sharing | Native | Agent and coding-agent session tests on Windows |
| Background delegation, goal continuation, reflection, and worker queues | Native | Delegation and liveness suites on Windows; no tmux dependency |
| Clipboard text, clipboard images, and image processing | Native | Windows native clipboard binding is packaged per architecture; conversion tests run headlessly |
| Managed `rg`, `jq`, `fd`, Ollama, and Transformers runtimes | Native where the upstream runtime supports the architecture | Platform selection, install, process, and lifecycle tests on Windows |
| Toolkit scripts | Native | PowerShell, Bash, and `uv` runners use the same bounded process lifecycle |
| External editor and browser launch | Native | Windows process-launch tests; `$EDITOR`/`$VISUAL` and the default browser remain user choices |
| Self-update | Managed standalone archive | Download and verify the matching Windows archive from the repository release |
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

### PowerShell 7 (`pwsh`) not found

Install PowerShell 7 or set `shellPath` to an existing `pwsh.exe`. Confirm discovery from a terminal:

```powershell
Get-Command pwsh -ErrorAction Stop
```

### Modified Enter does not reach Pi

Apply the Windows Terminal mappings above, then fully close and reopen the terminal.

### Native module fails to load

Confirm that the archive matches the machine architecture (`x64` or `arm64`), then download the matching release archive again.
