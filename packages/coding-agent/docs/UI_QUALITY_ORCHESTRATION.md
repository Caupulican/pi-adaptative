# UI quality — native orchestration

Milestone: native orchestration consolidation, 2026-07-23. Mode: REMEDIATE. UI type: dense desktop terminal tool; keyboard-first, low-motion, state-heavy. Reference: the owner's Pi Teams and task-steps extensions. The extracted presentation grammar is original to the packaged harness: show one compact state summary, order work by urgency, reveal evidence only on expansion, and disappear when idle.

## Seven-dimension score

| Dimension | Score | Evidence |
|---|---:|---|
| Color and tone balance | 2/3 | Semantic Pi theme tokens; accent is limited to active state and success/warning/error retain distinct glyphs. |
| Depth and softness | 2/3 | Hierarchy uses tone, indentation, and whitespace instead of a hard box frame; terminal surfaces cannot express physical shadow/radius. |
| Spatial rhythm | 2/3 | One header, two-cell row inset, four-cell detail inset, bounded row count, and width-safe truncation. |
| Typographic feel | 2/3 | Bold active labels, dim metadata, struck terminal work, and a short two-level hierarchy within terminal typography. |
| Motion and effects | 3/3 | Event-driven replacement with no decorative animation is the correct reduced-motion path for this pro-tool. |
| Drive-feel | 3/3 | Task and lane events update immediately; loading, empty, active, blocked, terminal, and review-required states are designed. |
| Coherence and finish | 2/3 | `task_steps`, `delegate`, `delegate_status`, and the persistent strip use one renderer and one status vocabulary. |

Accessibility gate: pass. Status is never color-only; every line is width-bounded; no motion path exists to disable; existing keyboard tool expansion reveals details; empty/error states remain textual.

## Ranked findings and remediation

1. Generic raw task/worker output hid state priority → increased scanning cost and made orchestration feel bolted on → route all three native tools through `core/tools/orchestration-panel.ts` with shared glyph, tone, spacing, and truncation rules → M, completed.
2. Native state lacked a persistent visual owner → users lost the active checklist between tool calls and extension reloads could erase improvised widgets → add host-owned widget lanes in `modes/interactive/extension-ui-host.ts` and refresh them only from session/worker events → M, completed.
3. Detailed evidence competed with the action state → long notes and claims dominated normal use → keep the compact panel status-first and reveal bounded evidence, changed files, and blockers only through existing tool expansion → S, completed.
4. Theme and narrow-terminal regressions could silently fracture alignment → perceived quality would vary by environment → retain semantic tokens only and lock every rendered line to measured terminal width in focused tests → S, completed.

## Acceptance gate

Re-run the frames in `docs/ui-reference/` at narrow and normal terminal widths. Flow passes when status, work, and evidence read in that order. Product passes when task and worker state look like one manufactured system. Reality passes with long labels, blocked work, queued workers, missing evidence, extension reload, resume, and no active work. No dimension may score 0 and the event-driven active-state moment must remain 3/3.

Controlled 100-column TUI smoke: `/task add` mounted `ready` with one open row, `/task start` changed the same panel to `active`, and `/task done` removed the panel. The run used an isolated temporary agent directory, made no model call, and left no runtime directory in the repository.
