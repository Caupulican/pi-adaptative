# Native Python tool

Pi includes `python` as a built-in tool and activates it by default. The tool runs bounded Python code or a script directly, without shell interpolation.

## Runtime provisioning

`python` is resolved through `uv`:

1. Pi uses an existing `uv` on `PATH` when available.
2. On Windows, macOS, and desktop Linux, Pi can install its pinned, SHA-256-verified `uv` release under `~/.pi/agent/bin`.
3. On Android/Termux, Pi uses `pkg install -y uv` because upstream desktop Linux archives are incompatible with Android's Bionic libc.
4. Pi asks `uv` to reuse an existing Python 3.10 or newer. If none is available and Pi is online, `uv python install 3.13` provisions it under `~/.pi/agent/runtimes/python`.
5. The resolved interpreter path is cached, and normal tool calls spawn it directly instead of creating a fresh environment.

Provisioning runs best-effort after npm installation and `pi update`, is available through `pi doctor`, and retries on first tool use. Installation is bounded to five minutes and never uses `sudo` or an unpinned `curl | sh` installer. Offline mode skips downloads and reports an actionable diagnostic.

## Tool input

Provide exactly one of:

- `code`: Python source sent on stdin
- `scriptPath`: an existing script; relative paths resolve from `cwd`

Optional fields:

- `args`: direct Python argv, with no shell expansion
- `cwd`: working directory, defaulting to Pi's current directory
- `timeoutSeconds`: wall-clock timeout; default 30 seconds, maximum 300
- `maxOutputBytes`: returned bytes per stream; maximum 200,000

Pi invokes Python with `-B` and UTF-8/unbuffered environment settings. This avoids `__pycache__` footprints and makes output behavior consistent across Windows and Unix-like systems.

## Output and performance

Stdout and stderr are streamed through fixed-budget accumulators. Returned output is bounded by lines and bytes; complete truncated streams spill under the process work directory in `~/.pi/agent/work/outputs/...`, never into the repository. Timeout and cancellation terminate the process tree, including commands that continue producing output.

Use `python` for bounded data shaping, structured transformations, and cross-platform logic when it is clearer than shell pipelines. Keep searches purpose-driven and scoped to explicit roots. Do not recursively scan a home directory or filesystem without explicit user intent and a justified timeout.

For small exact source edits, prefer `read`, `edit`, and `write`. When a Python transformation is necessary, preserve encoding and newline style, write atomically, and inspect the resulting diff.

## Safety

`python` requires the same `run_shell` capability as `bash` and executes under the file-mutation barrier. Destructive filesystem APIs and nested subprocess execution are classified as approval-required. Credentials, package publication, push/tag/release, and destructive operations still require explicit human approval.
