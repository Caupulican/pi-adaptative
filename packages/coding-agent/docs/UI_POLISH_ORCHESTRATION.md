# UI polish — activity lane

UI type: dense keyboard-first terminal tool. Phase: transient-status consolidation. Comparison sources: Codex `20dafe201d91d4405eef05ecd1db0257f13a9ac8`, Claude Code 2.1.219 (`7006c4c3acac98e554d3997baeda6a7fa4d1ff7c`), and the owner's Pi Teams/task-steps extensions. Only information choreography and lifecycle mechanics were extracted; no branding, frame geometry, source text, or identity was copied.

## Ranked findings

1. Task, goal, worker, routing, retry, compaction, queue, and tool progress used separate transcript, footer, widget, and loader paths. This duplicated truth and polluted scrollback. They now project into one event-driven horizontal line immediately above the editor.
2. Completed work needed feedback without becoming permanent history. The lane uses a muted active dot, holds green/red terminal feedback for two seconds, then removes it by timer event.
3. Resumed state could replay old terminal work as new. Session replacement primes terminal identities without displaying them; only later transitions flash.
4. Successful orchestration bookkeeping still produced empty or multiline tool cards. Collapsed successful task, goal, and worker tools now render nothing; explicit tool expansion retains the structured detail.
5. A terminal process did not prove a human was watching. `--session-mode user|worker` feeds the authoritative session-role contract; unattended workers do not receive approval UI, extension TUI context, widgets, footer, loaders, or activity-lane routing.
6. Loading session history still invoked collapsed tool-result renderers and image conversion. Retained results now stay behind their existing payload accessor until expansion; one expansion materializes once, and collapse releases the display cache.

## Acceptance battery

| Check | Verdict | Evidence |
|---|---|---|
| One status owner | PASS | One `ActivityLaneComponent`; the prior native orchestration widget and delegate footer fragment were removed. |
| Width and density | PASS | One line, display-cell truncation, bounded labels, and `+N` overflow. |
| State clarity | PASS | Glyph plus text plus semantic theme color; status is never color-only. |
| Completion lifecycle | PASS | Event/timer driven; success/failure disappears after a bounded hold. |
| Resume correctness | PASS | Existing terminal identities are primed and do not replay. |
| History cleanliness | PASS | Successful orchestration calls are absent while collapsed; retained tool-result payloads are not read or rendered until the existing expansion key is used. |
| Failure honesty | PASS | Tool errors, compaction failures, and final retry failures remain textual and actionable. |
| Audience isolation | PASS | Worker role disables human UI capability and does not mount transient visual surfaces. |
| Focus and interruption | PASS | The lane never captures focus; cancellation remains on the existing interrupt binding. |

Accessibility gate: PASS. The lane uses text and glyphs in addition to color, has no decorative motion, preserves editor focus, and stays within measured terminal width.

## Mechanism merge

- From Codex: one live task/status row owned by the composer area, updated by events, absent when idle.
- From Claude: active-form task wording, bounded horizontal activity, and short-lived completion feedback.
- From Pi: canonical goal/task/lane state, semantic theme tokens, explicit expansion, durable resume identity, and least-privilege session role.

The resulting UI is a Pi-native projection, not an incumbent clone.

Controlled 100-column smoke with an isolated agent directory and no provider request: `/task add` rendered one `Next 1/1` line, `/task start step-1` replaced it with `Step 1/1`, `/task done step-1` rendered `Completed` briefly, and the lane then returned to zero height. The temporary agent directory was removed.
