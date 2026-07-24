# UI polish — native orchestration

UI type: desktop pro-tool TUI. Named incumbent: the owner's Pi Teams and task-steps extensions. Phase: context/presentation consolidation. Same-task frames are indexed in `docs/ui-reference/`; only information choreography was extracted. No extension code, branding, frame geometry, commands, polling, or storage behavior was copied.

## Ranked findings

1. Fact: native tools rendered implementation-oriented text while the reference made active state scannable in one glance → risk: the packaged harness felt less integrated than its extensions → fix: one semantic, width-aware orchestration panel shared by checklist and workers → M, completed.
2. Fact: worker activity lived in a footer fragment and checklist state lived only in transcript output → risk: users had to mentally reconcile two surfaces → fix: one quiet below-editor projection from native session truth, absent when idle → M, completed.
3. Fact: extension widget lifecycle was the only reusable mounting path → risk: native UI either impersonated an extension or disappeared on `/reload` → fix: separate host-owned and extension-owned widget maps while keeping one renderer/container path → M, completed.
4. Fact: raw details exposed IDs and long evidence at the same weight as current work → risk: dense output buried the next action → fix: collapsed views omit checklist IDs and defer bounded evidence/claims to expansion → S, completed.

## Visual battery

| Check | Verdict | Evidence |
|---|---|---|
| Iconography / imagery weight | PASS | One restrained status-glyph language; no decorative icon set is appropriate for a terminal. |
| Surface tone steps + tonal grace | PASS | Existing semantic theme tones carry title, text, dim metadata, accent, warning, and error without hard borders. |
| Spacing rhythm + alignment / symmetry / balance | PASS | Shared two/four-cell insets and measured suffix/label widths keep rows aligned. |
| Typography hierarchy | PASS | Badge/action, bold active work, normal labels, and dim metadata form a closed hierarchy. |
| State clarity — selection, hover, focus | PASS | Non-interactive rows encode every state; existing keyboard expansion remains the single focused interaction. |
| Content-quality bugs wearing UI clothes | PASS | Empty, hidden-count, missing-evidence, unreviewed, skipped, and unknown-lane states are explicit and bounded. |
| Density calibration | PASS | At most eight persistent rows plus header/notice; idle state mounts nothing. |
| Theme, width, and DPI parity | PASS | No literal colors or cell assumptions; semantic tokens and `visibleWidth` bounds cover terminal variation. |

## UX battery

| Check | Verdict | Evidence |
|---|---|---|
| Surrounding-context compatibility | PASS | No polling, focus capture, modal, shell, filesystem, or extension-lifecycle side effect. |
| First-60-seconds friction | PASS | State appears automatically when native work exists and disappears automatically when drained. |
| Interruption audit | PASS | Updates replace a host widget in place and never steal focus. |
| Dead-end audit | PASS | Empty/error/skipped/review-required states explain the condition in text. |
| Muscle-memory parity | PASS | Existing `/task`, `task_steps`, `delegate_status`, and tool-expansion paths remain unchanged. |
| Latency honesty | PASS | Session and lane terminal events update immediately; no hidden completion polling. |
| Destructive-action safety | N/A | Presentation owns no mutation or destructive control. |
| Discoverability | PASS | The automatic panel is visible during work; slash-command help and tool results remain the full entry paths. |

Accessibility gate: PASS. State is conveyed by glyph and text as well as color, focus remains in the editor, motion is absent, and lines are clipped by display-cell width.

## Acceptance test

Repeat the same before/reference/after task at the same 80-column terminal width, then at 34 columns and in both themes. It must pass the art-design-system filters: flow (state → work → evidence), product (one coherent native system), and reality (long content, concurrent lanes, reload/resume, idle cleanup). Leak-check every frame before reuse.

The packaged TUI was also smoked at 100 columns with an isolated agent directory: add → `ready`, start → `active`, done → widget absent. No provider request was sent.
