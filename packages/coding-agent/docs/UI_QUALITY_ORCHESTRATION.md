# UI quality — activity lane

Milestone: transient orchestration consolidation. Mode: REMEDIATE. UI type: dense terminal pro-tool. Reference evidence is indexed under `docs/ui-reference/`.

## Seven-dimension score

| Dimension | Score | Evidence |
|---|---:|---|
| Color and tone balance | 3/3 | Muted active state; restrained semantic colors for task, worker, goal, success, warning, and failure. |
| Depth and softness | 2/3 | Space and tone establish hierarchy without a box or separator wall. |
| Spatial rhythm | 3/3 | One-cell inset, one horizontal separator grammar, no persistent multiline status block. |
| Typographic feel | 2/3 | Short active-form labels and dim overflow metadata fit terminal typography. |
| Motion and effects | 3/3 | Only state transition and bounded completion hold; no decorative animation. |
| Drive-feel | 3/3 | Routing, tool, task, worker, compaction, retry, and queue events update immediately. |
| Coherence and finish | 3/3 | One projection and lifecycle replace the old widget/footer/loader/status-message split. |

Accessibility gate: PASS. Status is not color-only, focus remains in the editor, narrow widths are bounded, and details remain keyboard-expandable.

## Reality gate

- Active task prefers `activeForm`, then blocked, then pending work.
- Concurrent workers and goals share one line and collapse behind `+N` at narrow widths.
- Green/red terminal feedback expires after two seconds.
- Resume does not replay old completions.
- Idle state occupies zero rows.
- Worker terminals explicitly run without human-facing UI routing.
- Actionable failures remain in history; successful bookkeeping does not.
- Collapsed retained tool results do not hydrate payloads, construct result renderers, or convert images before expansion.
