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

## 8. End-to-End Workflow Example

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
