# Runtime updates

The root agent uses `runtime_update` to load a self-modification, verify it, and continue its existing task. The tool does not grant permission to edit additional files, change security settings, or install unapproved dependencies. Workers cannot replace the root runtime.

## Extension and tool reload

After editing and testing an extension, request:

```json
{"action":"reload","extensionPath":"/absolute/path/to/extension.ts","verificationTool":"new_tool"}
```

Omit `extensionPath` to reload the configured resources. The complete tool batch is persisted before replacement. Validation failures restore the previous runtime. Once resource disposal commits, a later memory/runtime reconciliation failure retains the new generation for repair instead of restoring disposed resources. A newly loaded tool must run successfully before `{"action":"complete"}` can finish the update. A shell test can instead use `"verificationTool":"bash"`.

Verification means a fresh successful result from the named tool after the new generation loaded; an old result, a failed command, or import success alone cannot satisfy it. The host checks that evidence boundary, not the semantic completeness of the selected test. The agent must choose a meaningful regression and negative controls.

## Core restart

Interactive CLI sessions run under a supervisor that retains independent copies of the runtime. After editing and testing source code, or activating a standalone release through the installer, request:

```json
{"action":"restart","verificationTool":"bash"}
```

A persisted session is required. SDK, RPC, worker, and other hosts without this supervisor reject core restart instead of inventing a process-replacement path. Active managed work must become quiescent before replacement.

The supervisor captures the candidate and durably acknowledges it before the current host tears down. Only the old process's actual terminal event releases the session-writer fence. The candidate resumes the same session file; it does not repeat startup prompts, attachments, or the original user request. After the agent verifies the change, `complete` commits the candidate through the supervisor. Lost commit acknowledgements permit at most three same-identity transmissions over 15 seconds; candidate capture itself is never automatically replayed.

For source checkouts, use the native `pi-test.sh` launcher. Explicit relative, absolute, and file-URL loader paths are remapped inside the captured runtime, including inline `--import=...` forms. Bare loader package specifiers and external loader paths are rejected: retaining a loader resolved from the live working directory would invalidate rollback isolation. Loader injection through `NODE_OPTIONS` is also rejected.

For managed standalone installs, each candidate capture reads the installer's activation pointer (`current` on Unix, `current.version` on Windows). Updating that pointer selects the new release without changing previously retained artifacts. Unmanaged archives capture their original directory. Snapshot files are copies or copy-on-write reflinks, never hard links to mutable source files. An externally installed Node interpreter is copied with the generation.

Persistent collaboration peer commands use a separate stable launcher: the original source interpreter/entrypoint or the managed installer's activation launcher, never a retained snapshot or prunable release. Source loader paths and package/config environment are anchored to the original checkout. If the supervisor cannot establish a stable launcher, peer admission fails before a team starts. Moving/deleting the original checkout, uninstalling the CLI, or breaking its current activation can still prevent peer submission.

## Autonomous repair and stopping

A failed load or candidate process takes priority over the original task. Rejected loads retain the old runtime for repair; a candidate process that exits before verified commit automatically restores the known-good generation in the same session. Edit the original source or install location, not the retained runtime artifact. The agent tests its repair, retries the same update mode, verifies the new generation, and then resumes the original task.

The durable update record limits one update to three load/restart attempts and twelve repair/verification turns. Startup has a 60-second watchdog; an uncommitted candidate has a 30-minute verification watchdog. Snapshot retention admits at most three generations, each bounded to 100,000 entries, depth 64, and 1 GiB. File-version checks reject detected concurrent modification; unsupported external symlinks and filesystem objects reject capture. Failed cleanup does not prevent an available rollback, but retained artifacts still count against the admission cap.

`{"action":"status"}` reports the current update. `{"action":"stop"}` stops repair and leaves the original task explicitly unfinished. Cancellation, exhausted bounds, a terminal provider failure, or an agent ending without verification also stops the workflow; it does not silently declare success. Resuming a persisted unfinished session automatically prioritizes inspection and repair, never blind replay of an uncertain mutation.

## Context and limits

Extension reload preserves the in-memory conversation. Core restart resumes the persisted session and appends bounded recovery notices. This preserves task context and avoids replaying the original request, but cannot guarantee a provider cache hit: process-local transport state, changed tool schemas or prompts, and server cache eviction remain outside that guarantee.

Reload cannot undo external effects performed by extension lifecycle handlers. Custom resource-loader commit hooks must reject before disposing the previous generation; the default loader bounds and contains disposal errors. Post-commit hook failures remain visible and require repair of the retained new generation.

The supervisor protects an already running session; it is not an operating-system service. Parent-process loss, machine shutdown, damaged storage, an unusable original launch environment, or an unavailable provider can prevent automatic continuation. A known-good process that itself cannot start causes a bounded terminal failure, not an infinite restart ladder. Snapshot copying is not a filesystem-wide atomic transaction or a sandbox against an adversarial concurrent writer.

Regression coverage includes same-session recovery from a real syntax-broken child process, release-pointer changes for both installer formats, dropped/stale acknowledgements, failed persistence and cleanup, teardown failure, malformed handoffs, loader remapping, and independent artifacts after source edits. Native Windows process replacement and long-duration cross-platform soak behavior are not established by the Linux test run.
