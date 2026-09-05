# Interactive Workbench

Human interactive sessions use a full-screen Workbench with the selected terminal theme, including Matrix. Unattended sessions retain their transcript layout.

The upper band contains compact work/team state and current execution evidence. It takes only the rows its content needs, up to 18 rows, while reserving conversation space. At narrow widths it becomes a single column. Status, extension widgets and input span the full terminal below the conversation.

Successful execution folds to a receipt when the agent stops. A new cycle clears its old previews; failure receipts remain visible until session replacement. Completed work and teams collapse without deleting tasks, worker sessions or durable evidence. Long plans show up to six prioritized rows; use the existing work/team inspector for the complete state.

## Reading and copying

- Mouse wheel inside conversation or `Alt+PageUp` / `Alt+PageDown`: scroll conversation without changing editor history.
- Scrolling upward pauses following. Scrolling back to the final page, `Ctrl+End`, or **Latest** resumes it.
- Drag to select conversation text. Selection freezes the displayed text while the model continues working. **Copy selection** or `Ctrl+X` copies it; tree-selector copying retains precedence.
- **Copy all** or `Alt+C` copies user/assistant prose and answered `ask_question` interactions from the current session branch, including history outside the visible window. Routine tool output is excluded. Copies above 10 MiB are refused explicitly; use `/export` instead.
- `Alt+O`: fold or expand the latest execution preview. `Ctrl+T`: open the complete action transcript, including images and full results.

New shortcuts are configurable through the existing keybinding manager: `app.conversation.pageUp`, `app.conversation.pageDown`, `app.conversation.latest`, `app.conversation.copy`, and `app.execution.toggle`. Editor shortcuts and active modal navigation retain their existing owners.

Terminal-native selection, typically available by holding Shift, depends on the terminal emulator and cannot notify the application to pause. The application-owned drag selection does pause. Clipboard transport uses the existing platform clipboard/OSC 52 adapter; remote terminal support varies.

## File effects and limits

Edit diffs, written content, command results and failures appear above conversation. Routine reads stay in the action transcript. Explicit user shell commands remain visible in the upper band.

After foreground `bash` or `python` tools finish, a read-only Git observation can reveal silent file effects. It is an event-triggered workspace comparison, not a watcher, completion detector, attribution mechanism, or proof of a clean worktree. Unchanged pre-existing changes are excluded when a baseline is available. If execution overlaps the initial snapshot, the UI says that displayed changes may predate the task. Current patches may include prior or concurrent edits.

Observations are bounded to 128 dirty paths, 32 diff paths, 256 KiB per Git response, two seconds per Git command, and 64 KiB per small-file read. Larger files use metadata. Ignored files and changes outside the current working directory are not observed. Non-Git directories and budget failures produce a notice instead of a clean-workspace claim. File effects arriving after completion still update the folded receipt.

Conversation rendering visits visible entries lazily, retains at most 2 MiB of derived row-cache text, and uses existing terminal line-diff rendering. Execution retains at most three bounded previews and displays the latest. No decorative animation timer or session-history scan runs per frame. Large individual visible messages still incur their renderer's normal cost.

## Verification

Focused regressions cover lazy rendering, cache bounds, selection during streaming and resize, follow/reading transitions, narrow layouts, full-width input, overlay focus restoration, questions, silent workspace changes, overlapping observations and stale-session fencing. Headless terminal tests validate cursor placement and resize behavior. These do not substitute for visual and clipboard acceptance in each user's terminal emulator.
