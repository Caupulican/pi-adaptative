# Task-Local Deterministic Automation

Task-local automation provides deterministic script execution contracts for complex, repetitive, or verifiable tasks when standard built-in tools are insufficient.

---

## 1. Decision Hierarchy

Autonomous operations follow a strict decision hierarchy:

1. **Native Existing Tools First**: If a built-in tool (`read`, `edit`, `write`, `find`, `grep`, `bash`, `task_steps`) directly and reliably solves the problem, use it.
   - The semantic model evaluates and decides native tool adequacy.
   - A generic shell (`bash`) or Python interpreter is an execution environment, *not* an existing implementation of a new deterministic procedure. If a deterministic multi-step procedure does not exist, author it rather than running ad-hoc multi-line commands.
2. **Validated Script Second**: If an admitted, validated task automation script already exists for the task, invoke it via `task_automation` action `run` or `run_toolkit_script`.
3. **Author Script Third**: If deterministic computation, data transformation, or invariant verification is required and existing tools are inadequate, author a script and contract via `task_automation` action `spec`, write the script file, then `validate`.
4. **Model Judgment Fourth**: Unstructured model inference is the final fallback for subjective reasoning, synthesis, or creative generation.

---

## 2. Automation Lifecycle

Task automations progress through an explicit state machine:

```
[ specification / building ] ──(validate action)──> [ validating ] ──(verifier pass)──> [ ready ]
         ▲                                                 │                                │
         │                                                 └──(verifier fail)──> [ failed ] │
         │                                                                                  │
         │                                            ┌─────────────────────────────────────┘
         │                                            ▼
         │                                      [ executing ] ──(run completes)──> [ ready / failed ]
         │                                            │
         └────────(re-author / disk mutation)─────────┘
```

1. **`spec`**: Declare or update the automation specification. Transitions to `specification` (if the script file does not exist on disk at authoring time) or `building` (if the script file already exists in the workspace). Each authoring increments `generation`. Rejects malformed contracts before persisting.
2. **`validate`**: Transitions to `validating` while executing positive verifier and negative control fixtures.
   - On positive verifier exit 0 with required literal assertions (`expectedOutput`, `contains`) AND all negative control failures matching expected non-zero exits/errors: transitions to `ready` and records exact SHA-256 script hash evidence.
   - On verifier failure, timeout, non-zero positive exit, or failed negative control: transitions to `failed`.
3. **`run`**: Transitions from `ready` to `executing` while executing under host authority. Enforces disk hash integrity before execution and literal output assertions on production output. Outcome (`succeeded` or `failed`) is recorded in `lastExecution`.
4. **`bind`**: Explicitly binds the automation to a task step (`task_steps`) with an exact expected argument list (`expectedArgs`). Clears prior execution evidence upon rebinding.
5. **`status`**: Query current state, verification evidence, and last execution results for an automation.
6. **Disk Mutation & Drift**: Detected during `run`, `validate`, or step completion check. Modifying the script file on disk invalidates validation evidence and blocks execution until re-validated.
7. **Persistence & Recovery**: Automation state is journaled in durable session snapshot entries retained across context compaction and session resume. Interrupted operations active during `validating` or `executing` restore to `failed` state with outcome `unknown`; execution is never replayed automatically.

---

## 3. Declarative Contracts & Literal Assertions

To eliminate regex Denial of Service and non-deterministic matching on the main event loop, operational contracts use strictly bounded literal assertions:

- **`outputs.contains`**: Mandatory non-empty literal substring that must appear in the execution stdout.
- **`outputs.format`**: Output formatting schema (`"text"`, `"json"`, or `"lines"`). JSON format requires stdout to be parseable JSON in addition to the substring constraint.
- **`verifier.expectedOutput`**: Mandatory non-empty literal substring expected during positive verification when exit code is 0. Exit-zero-only verification without output assertions is strictly prohibited.
- **`verifier.negativeControls`**: At least one negative control is mandatory. Each negative control supplies adversarial or invalid arguments and specifies expected non-zero exit codes (1-255) and optional `expectedError` substrings. A negative control with exit code 0 or null is rejected at authoring time.
- **Scope & Boundaries**:
  - Metadata inputs (`inputs`, `preconditions`, `effects`, `failure`) are declarative descriptive contracts for auditing and model context.
  - The SHA-256 evidence hash covers the script file bytes on disk only. It does not provide transitive dependency hashing, operating system containment, or sandbox isolation. Execution runs in the host process environment subject to host permissions and configured authorizers.

---

## 4. Task Step Invariants & Completion Fencing

Task step completion is operationally tied to automation execution:

- **Script Readiness is Not Task Success**: An automation reaching `ready` state is not sufficient to complete a bound task step. The step can only be marked `completed` once the script has successfully executed (`outcome === "succeeded"`).
- **Exact Argv Verification**: Last execution arguments must match `binding.expectedArgs` exactly, including argument count and order.
- **Disk Hash Integrity**: The script on disk at completion time must match the SHA-256 hash recorded in validation evidence.
- **Drop Prevention**: Active unresolved bound task steps cannot be dropped silently via `task_steps` update, set, or clear operations. They must be explicitly completed (with verified execution) or marked `cancelled`.
- **Session-Level Invariant Enforcement**: Step completion invariants are enforced uniformly at `AgentSession.saveTaskStepsStateSnapshot`, protecting all entry points (model tools, pipeline transitions, and programmatic API calls).

---

## 5. Direct Shell Execution Gating

To prevent bypassing validation and host controls, explicitly recognized execution forms for registered automation scripts are intercepted when invoked through standard shell tools (`bash` or `run_process`):

- **Explicitly Recognized Forms**:
  - POSIX shells: `bash`, `sh`, `zsh`, `dash`, `ksh` (e.g. `bash script.sh`).
  - Python interpreters: `python`, `python3`, `py` (e.g. `python script.py`).
  - PowerShell interpreters: `powershell`, `pwsh` with flags or `-File` (e.g. `powershell -File script.ps1`).
  - Package runners: `uv run` (e.g. `uv run script.py`).
  - Path executions: Direct relative or absolute paths (e.g. `./scripts/run.sh`, `scripts\\run.ps1`).
- **POSIX Source Grammar**: the `bash` tool's command text is tokenized with the POSIX shell grammar on every platform (`shell-command-parser.ts`), so an unquoted backslash is an escape: `powershell .\scripts\calc.ps1` names `.scriptscalc.ps1`, not the registered `scripts/calc.ps1`, and is neither gated nor an execution of it. Quote Windows paths (`powershell -File '.\scripts\calc.ps1'`) or use forward slashes (`powershell -File ./scripts/calc.ps1`); both are gated on Windows, and a quoted literal-backslash filename stays a distinct ordinary file on POSIX.
- **Nested Command Parsing**: Commands nested within shell `-c` invocations are recursively parsed using shell command AST tokenization without loose regex splitting.
- **Post-Hook Evaluation**: Gating evaluates `finalArgs` after extension hooks run. If an extension hook mutates a benign command (`echo`) into a registered script path, the post-hook check intercepts and gates execution relative to the execution working directory.
- **Scope Limits**: This gate intercepts explicitly recognized invocation forms using AST tokenization. It does not provide arbitrary shell equivalence, command obfuscation parsing, or operating system containment.

---

## 6. Dynamic Script Registry & Provenance Fencing

Admitted dynamic scripts are integrated into the toolkit registry for discovery and invocation:

- **Collision Prevention**: Dynamic scripts cannot collide with or silently override existing static toolkit scripts or aliases.
- **Immutable Provenance Symbol**: When combined scripts are generated, dynamic scripts are stamped with a frozen `TASK_AUTOMATION_PROVENANCE` object (`Object.freeze`) containing `sessionId`, `cwd`, `automationName`, `scriptPath`, `runner`, `scriptHash`, `generation`, and `verifiedAt`.
- **Spread Snapshot Resilience**: The provenance symbol is an own enumerable property that survives shallow object cloning (`{ ...script }`).
- **Drift & Scope Rejection**: `executeScript` verifies that:
  1. `sessionId` matches the current session ID.
  2. `cwd` matches the current workspace root.
  3. `automationName` matches the registered automation name.
  4. `scriptPath` matches the registered automation path.
  5. `runner` matches the registered runner.
  6. `generation` matches the current automation generation (rejecting stale selections if the automation was re-authored).
  7. `scriptHash` matches the current validation evidence hash.
  8. `verifiedAt` matches the current verification timestamp (rejecting stale selections if re-validated).
  9. Automation is in `ready` state.
- **No Raw Fallback**: If any provenance or drift check fails, execution fails closed (`exitCode: 1`) without falling back to raw static toolkit execution.
- **Single Host Authorizer Owner**: Dynamic script authorization is owned exclusively by `controller.run`. Outer toolkit tools (`run_toolkit_script`) route through `adapter.authorizeToolkitScript`, which defers dynamic registered scripts to `controller.run` and authorizes static scripts directly. Every dangerous production execution is authorized exactly once.

---

## 7. Background Execution & Role Policy

- **Tool Surface Availability**: `task_automation` is exposed on the default root tool surface for interactive and headless sessions.
- **Worker Exclusion**: Workers and delegated child sessions are forbidden from invoking `task_automation` via `WORKER_FORBIDDEN_TOOLS`.
- **Native Background Handoff**: `task_automation` exports a `backgroundRequested` hook for `run` and `validate` actions when `background: true` is specified. It delegates to the existing native `tool_task` subsystem for process management, bounded completion handoff, and parent notification.

---

## 8. Scripted Tool Calls

For three or more dependent or bulk calls of the native tools (search, read the matches, edit them), one `python` call with `tools` runs a script that calls them through `import pi_tools` and returns one bounded result. This is item 1 of the decision hierarchy done in one turn, not an automation script: nothing is registered, validated or reused.

- **Reachable tools**: `read`, `grep`, `find`, `ls`, `repo_read`, `edit`, `write`, limited to the ones the call names in `tools`. No `bash`, no delegation or other control-plane tools. On the root, `edit` and `write` are reachable only while they are active for the model.
- **Same gates**: each `pi_tools` call is admitted exactly like a direct call of that tool (schema, invocation binding, envelope and path authority, credential guard, extension hooks, edge, operation and System One checks). A refusal raises `pi_tools.ToolRefused`, a failure `ToolFailed`, the call limit `ToolLimit`, the run ending `ToolCancelled` (all `ToolError`). Relative paths resolve as in direct calls, not against the script's `cwd`.
- **Bounds**: `maxToolCalls` (default 50, at most 200), one admission at a time, at most 4 tool bodies at once and the run's file mutations one at a time, 4 MiB per request, 1 MiB of tool text per answer, 2 minutes per call, and the python tool's own timeout and output bound for the run.
- **Result**: only what the script prints, followed by a compact trace: counts per tool and outcome, then one line per call (tool, outcome, milliseconds, a short reason when it did not succeed), never a tool's output. The `tools` harness log records counts only.
- **Failure**: a script error returns its bounded traceback with the trace; each tool call settles on its own, so the calls that settled before an error or an abort stand and nothing else is applied. Aborting the python call cancels the calls in flight.
- **Limits**: foreground only (`background` with `tools` is refused) and local Python only. The channel is a per-run Unix socket or Windows named pipe guarded by a per-run secret; it exists only while the script runs.

---

## 9. End-to-End Workflow Example

Here is a complete end-to-end example demonstrating `spec` -> `validate` -> `bind` -> `run`:

### Step 1: Author Specification (`spec`)

Declare the script specification, its runner, and literal verification contracts:

```json
{
  "action": "spec",
  "name": "checksum-audit",
  "description": "Calculate and format SHA-256 checksums for build artifacts",
  "runner": "bash",
  "path": "scripts/checksum.sh",
  "contract": {
    "inputs": [
      { "name": "target_file", "type": "string", "description": "Path to file to hash" }
    ],
    "outputs": {
      "format": "text",
      "description": "Formatted hash output",
      "contains": "SHA256="
    },
    "preconditions": ["Target file exists and is readable"],
    "effects": ["Prints formatted SHA-256 checksum to stdout"],
    "failure": ["Exits non-zero if target file is missing or unreadable"],
    "verifier": {
      "args": ["package.json"],
      "expectedExitCode": 0,
      "expectedOutput": "SHA256=",
      "negativeControls": [
        {
          "description": "Reject missing file",
          "args": ["nonexistent_file.txt"],
          "expectedExitCode": 1,
          "expectedError": "file not found"
        }
      ]
    }
  }
}
```

### Step 2: Create Script File

Create the executable script at `scripts/checksum.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "error: expected exactly one target file" >&2
  exit 2
fi

TARGET="$1"
if [ ! -f "$TARGET" ] || [ ! -r "$TARGET" ]; then
  echo "error: file not found or unreadable" >&2
  exit 1
fi

DIGEST=$(sha256sum -- "$TARGET" | cut -d' ' -f1)
printf "SHA256=%s\n" "$DIGEST"
exit 0
```

Make the script executable: `chmod +x scripts/checksum.sh`.

### Step 3: Validate Against Fixtures (`validate`)

Run validation to execute positive verification and negative control fixtures:

```json
{
  "action": "validate",
  "name": "checksum-audit"
}
```

On success, the script moves to `ready` state and records an evidence record containing the exact SHA-256 script hash and fixture outputs.

### Step 4: Bind to Task Step (`bind`)

Bind the automation to an in-progress task step with the exact expected arguments:

```json
{
  "action": "bind",
  "name": "checksum-audit",
  "stepId": "step-2",
  "args": ["package.json"]
}
```

### Step 5: Run Automation (`run`)

Execute the automation with the bound arguments:

```json
{
  "action": "run",
  "name": "checksum-audit",
  "args": ["package.json"]
}
```

Once execution succeeds and outputs match the literal contract, the bound task step `step-2` can be safely marked `completed` in `task_steps`.

## 10. A routine remembers where it stood

A routine that runs again and again (on a clock, by hand, on an event or on a watch) keeps a short record of how far its task got, so each run picks up where the last one stopped instead of starting cold.

**What the record holds.** Where the task stands, what is next, the last few finished items, the owner's own note, and the snags runs keep hitting, each with how often it was seen, when, and the remedy that got past it. The whole record is at most 4 KiB; every line is cleaned, redacted of secrets and then bounded when written. Invisible characters go first, so a secret split by one is still caught.

**Who writes it.**

- The run itself: a routine's run is the only worker whose `submit_report` takes an optional `progress` (position, done, next, and one snag with what happened, an optional remedy and, for a snag the brief listed, its reference).
- The host, from facts it holds in code: a failed result counts a snag keyed by its reason code and failing step, never by its wording, so the same stumble counts as the same snag; an unknown result counts nothing until its outcome is known. A snag that clean runs stop hitting is resolved after two succeeded runs in a row; the last two resolved snags are kept with what worked. A snag that comes back after it was resolved starts a new count.
- The owner, through the routine tool: `note` sets the owner's own line that every later run reads, and `reset_progress` forgets the whole record so the next run starts fresh. Both need a turn the owner spoke in. A note the record cannot hold is refused in plain words, and the note itself is never cut.

**Where the position comes from without a report.** A routine saved by an earlier build cannot ask its runs for `progress`, and a run may send none. For the routine's latest claimed run that sent no report, the host sets the position from its own result, in code: `Last run succeeded: <first line of its summary>` or `Last run failed: <first line of its summary>`, the summary cleaned, redacted and kept to 200 characters; with no summary, `Last run failed at <date>`. A succeeded result replaces the stored position; a failed one fills the position only when none is stored, and its failure shows through the snags. A cancelled run leaves `Last run was stopped` only when it was dispatched and ran as a worker session; it counts no snag and no failure. An uncertain result sets nothing until its outcome is known, and that outcome then writes the line. A bot or team routine's results record no progress, so its status line shows none; its owner note still applies. A derived position that replaces an earlier one clears the worker's earlier next step. The finished items are never derived, and a derived line that changes the record from a third-party-triggered run marks it like a report.

**What the next run reads.** Each run's instructions end with a block titled "Where this task stood after the last run", at most 1,500 characters: the notes fenced as untrusted data, then fixed instructions (check that the recorded position still holds with one cheap check before relying on it; if a listed snag comes up, apply its remedy first and report a failed remedy as a new fact; the remedy instruction is left out when a third party's run wrote the record; the instruction to report progress through `submit_report` is given only to a run whose contract grants `progress`, read from the run's own frozen definition, not the routine's current one). The block is written when the run is claimed to run, before its dispatch, and kept with the run, so its instructions never change after dispatch, a restart sees the same text, and the same record always gives the same block. A first run gets no block. The away daemon builds the same instructions from the same stored run, so a run away reads the same block.

**What it cannot do.** The record is data. It never changes the routine's prompt, schedule, authority or tools, and it never moves the routine's revision. A run that read a third party's words (a watch excerpt, a GitHub event written by someone else) marks the record, and every later run is told that some notes came from such a run, until the owner resets it; a run that reads a marked record carries the same third-party origin as its words.

**Where the owner sees it.** The routine tool's `get` shows it in plain words, `/status` shows it on the routine's line for a worker-session routine (a bot or team routine shows none), and `/bot schedule list` shows it for bot and team routines. A paused routine's state reads `paused after repeated failures`. When a snag is seen three times while still unresolved, the owner is told once, with their next turn; while the routine is paused or off, that notice says so, and the note applies when the routine runs again. The owner's line names the routine, its state and the count; the failed run's words and the snag's text reach the model only, fenced as data.

**Replays and compatibility.** A result is recorded once per run: a replayed result changes nothing, and a run first recorded as unknown counts nothing until its known outcome arrives, which then counts once. A routine store holding a progress record, or a run admitted with one (kept after a reset until the run ages out of the store), is written as store version 4; a store without progress stays version 3. An earlier build refuses a version 4 store with its invalid-envelope error, and that refusal stops every bot, team and routine operation on the store, not only routines. The change is forward-only.
