# Persistent task directories

Ask the model to register your projects and choose which tasks should stay pinned to each project.
For example: “Work on the application in `D:/projects/application` and the library in
`D:/projects/library`. Pin each task to its project.” These are illustrative paths, not required names.

`task_directory` is a model tool, not a shell or slash command. It stores directory bindings in the
current session branch. The active `task_steps` item determines which task is executing; changing
directories never creates a second checklist or changes the process-global working directory.

## Controls

| Action | Parameters | Effect |
| --- | --- | --- |
| `register` | `workspaceId`, absolute `path` | Register an existing native project directory. |
| `select` | `workspaceId` | Select the workspace inherited by unpinned tasks. |
| `bind` | `taskId`, `pinned`, optional `workspaceId`, relative `path` | Pin a task to a workspace, or make it follow selection. |
| `forget` | `taskId` | Remove that task's saved binding, including an archived task. |
| `reattach` | `workspaceId`, absolute `path` | Explicitly attach a moved, replaced, or foreign-host workspace. |
| `status` | optional `cursor` | Inspect effective context and a page of saved workspaces and bindings. |

Use the task id returned by `task_steps`. For a pinned binding, an omitted workspace defaults to the
selected workspace. For an unpinned binding, omit `workspaceId`; the relative path follows the selected
workspace. An omitted relative path means the workspace root. Native Windows paths require a complete
drive or UNC share: use `D:/projects/application`, not the drive-relative `D:application`.

Status includes totals and, when needed, `nextCursor`. Pass that value as `cursor` in another status
call. Pages retain complete paths rather than truncated executable-looking fragments. A changed task,
session, or saved directory snapshot invalidates the cursor; request status without a cursor to restart.
Status and mutation receipts use the same bounded projection. The registry holds up to 32 workspaces
and 128 explicit task bindings; forget archived bindings when no longer needed.

## Execution and recovery

Each operation captures its task directory before admission. Later selection changes do not move
running work, pinned tasks, or workers already dispatched. Workers retain the directory in their durable
execution contract; reusing a worker does not silently adopt a later foreground selection.

Native file, Python, shell, process, and workflow tools consume the admitted directory. A shell-local
`cd` can affect that command but does not rewrite the task binding: the next task shell invocation
starts in the assigned directory while preserving its exported environment state. Selection does not
change the original permission grant. Executing-backend path authority propagates through tool invocation
bindings, so capability envelope enforcement, autonomy gates, and credential exposure guards evaluate
against the admitted backend's filesystem facts and path dialect rather than ambient host filesystem probes.
Custom SDK backends retain their own explicit binding and path adapter; this native directory tool does
not retarget a remote filesystem implicitly.

Bindings survive session resume, branch restoration, and compaction. Saved context is also projected
back to model requests, so the model need not reconstruct it from old tool output. These are session
bindings, not global defaults for unrelated new sessions. Programmatic setup before the first persisted
assistant or lifecycle record follows the session journal's deferred-persistence contract.

Missing or replaced directories do not fall back to the ambient directory. Inspect status and use
explicit reattachment to repair the saved target. Native validation checks platform/hostname and
device/file identity; it is not an OS sandbox and cannot distinguish identical cloned machine identities
or guarantee against an external filesystem swap after admission. Historical worker contracts without
recorded physical identity retain explicitly diagnosed path-only recovery.

Directory routing does not transcode files. The existing edit/recovery path retains encoding, BOM,
individual line endings, and untouched bytes; directory selection never authorizes a different codec.
