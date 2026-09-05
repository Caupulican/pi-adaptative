# Interactive Workbench

Human interactive sessions use a full-screen Workbench with the selected terminal theme, including Matrix. Unattended sessions retain their transcript layout.

Rows, top to bottom: a title strip (application name, the plan or goal naming the work or else the session name, and the run state WORKING / WAITING / IDLE on the right), the live activity line, the work area, its divider, the conversation header, conversation rows, a rule marking the status boundary, the status band (transient notices, extension widgets and session status on a surface tone; location, usage, extension status and model share one row whenever the width allows), the input, extension widgets below it, and one key-hint row. Zones separate by surface tone (`workbenchSurface`, optional in custom themes and defaulting to the custom-message background) and spacing; nothing is framed.

The work area is a fixed zone: the inspector on the left (30% of the width: a **Work plan** block with completed/total steps and a **Team** block with active agents, each with a quiet placeholder when empty) and **Execution** on the right (file effects and command outcomes, with a placeholder until the first evidence). Its height is ten rows by default, limited to half of the space left after the title strip and dock; only the operator changes it. `Alt+O` (or a click on the divider) collapses it to the divider row, which then summarizes the blocks, and expands it again; `Alt+=` and `Alt+-` add or remove a row. Tool output never moves the conversation boundary: previews scroll inside their surface. Terminals narrower than 80 columns stack Execution above the inspector, and very short terminals show both in one scrolling surface or, below two rows, only the divider. Status and input stay anchored below the conversation. Extremely small terminals omit gutters to preserve native input and its cursor; oversized dialogs retain their own complete layout.

Evidence stays on screen until it is replaced: completion does not fold it, and a new cycle keeps the previous cycle's previews and counters until its own first tool result or file effect arrives. Failure counts remain visible until session replacement. A finished plan folds to one `Work complete` row and an idle team to one `Team idle · N sessions retained` row without deleting tasks, worker sessions or durable evidence. Long plans show up to six prioritized rows (blocked and failed first, then active, then pending) with the hidden count; use the existing work/team inspector for the complete state. Edit previews carry their added/removed line counts.

The conversation viewport never emits the OSC 133 prompt-zone marks that the inline transcript components carry: a terminal may treat one as "a prompt starts here" and move the cursor to column 0, which corrupted framed rows in Herdr, and the alternate screen has no scrollback for those marks to navigate.

## Reading and copying

- Mouse wheel inside an inspector or execution surface: scroll only that surface. Its title row shows the visible row range when content overflows; title rows and gutters are not scroll targets.
- Mouse wheel inside conversation or `Alt+PageUp` / `Alt+PageDown`: scroll conversation without changing editor history.
- Scrolling upward pauses following; the conversation header then reads *Reading* and offers **Latest ↓**. Scrolling back to the final page, `Ctrl+End`, or **Latest ↓** resumes it.
- Drag to select conversation text. A plain click only focuses the pane; the selection starts when the pointer moves, and only then does the displayed text freeze while the model continues working. `Ctrl+X` copies the selection (terminal-native selection copies on its own), and tree-selector copying retains precedence.
- The conversation anchors to the bottom: the latest row sits directly above the status band, and a transcript shorter than the area leaves its empty rows above, never below.
- Reading position anchors to the entry under the top row. When live-history trimming removes that entry, the conversation resumes following instead of jumping to the oldest retained rows.
- An answer the verification gate withheld (the model claimed completion while a trusted verification was still failing) shows as an `Answer withheld` line in the conversation instead of leaving the screen unchanged.
- **Copy conversation** or `Alt+C` copies user/assistant prose and answered `ask_question` interactions from the current session branch, including history outside the visible window. Routine tool output is excluded. Copies above 10 MiB are refused explicitly; use `/export` instead.
- `Alt+O`: collapse or expand the work area; `Alt+=` / `Alt+-`: resize it. `Ctrl+T`: open the complete action transcript, including images and full results.

New shortcuts are configurable through the existing keybinding manager: `app.conversation.pageUp`, `app.conversation.pageDown`, `app.conversation.latest`, `app.conversation.copy`, `app.execution.toggle`, `app.workbench.grow`, and `app.workbench.shrink`. Editor shortcuts and active modal navigation retain their existing owners.

Terminal-native selection, typically available by holding Shift, depends on the terminal emulator and cannot notify the application to pause. The application-owned drag selection does pause. Clipboard transport uses the existing platform clipboard/OSC 52 adapter; remote terminal support varies.

## File effects and limits

Edit diffs, written content, command results and failures appear above conversation. Routine reads stay in the action transcript. Explicit user shell commands remain visible in the upper band.

After foreground `bash` or `python` tools finish, a read-only Git observation can reveal silent file effects. It is an event-triggered workspace comparison, not a watcher, completion detector, attribution mechanism, or proof of a clean worktree. Unchanged pre-existing changes are excluded when a baseline is available. If execution overlaps the initial snapshot, the UI says that displayed changes may predate the task. Current patches may include prior or concurrent edits.

Observations are bounded to 128 dirty paths, 32 diff paths, 256 KiB per Git response, two seconds per Git command, and 64 KiB per small-file read. Larger files use metadata. Ignored files and changes outside the current working directory are not observed. Non-Git directories and budget failures produce a notice instead of a clean-workspace claim. File effects arriving after completion still update the folded receipt.

Conversation rendering visits visible entries lazily, retains at most 2 MiB of derived row-cache text, and uses existing terminal line-diff rendering. Frame cost is bounded by the visible rows, not by history: rows that already fit their zone skip the grapheme scan, so a 224×50 frame stays under a millisecond with 2,000 transcript entries where the previous full-transcript layout needed about sixteen. Execution retains up to twelve bounded previews per cycle, shows them in order with the cycle's action and file-effect counts in its title row, and follows the newest rows until the operator scrolls up; a new preview follows again. No decorative animation timer or session-history scan runs per frame. Large individual visible messages still incur their renderer's normal cost.

## Verification

Confirmed by the [layout regressions](../test/workbench.test.ts), [input regressions](../test/workbench-controller.test.ts), [narrow-pane and native-editor regressions](../test/workbench-pane-regressions.test.ts) and [headless terminal tests](../test/workbench-terminal.test.ts): closed borders, stable geometry across growing output, independent pane scrolling, border-adjusted selection, cursor placement, resize and overlay focus restoration. Adjacent tests cover lazy rendering, cache bounds, questions, silent workspace changes, overlapping observations and stale-session fencing. These do not substitute for visual and clipboard acceptance in each user's terminal emulator.
