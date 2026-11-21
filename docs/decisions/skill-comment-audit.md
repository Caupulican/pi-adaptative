# Comment audit of skill discovery and updates

The inventory uses the original line numbers at commit `470f3ada4`. Each row identifies parser tokens by their starting lines. A block spanning several lines has one entry. The three consecutive line comments about thinking levels form one workaround.

| File in `packages/coding-agent/src/core/` | Original lines | Category | Disposition |
|---|---|---|---|
| `skill-discovery.ts` | 6 | Decision Record | Shared discovery recorded in ADR 0001 |
| `skill-mutation.ts` | 5, 21 | Decision Record | Physical-root and lock-order rules recorded in ADR 0002 |
| `skill-repair.ts` | 59, 100 | Decision Record | Inspection recorded in ADR 0001 and repair in ADR 0002 |
| `skill-work-paths.ts` | 7 | Decision Record | Path ranking recorded in ADR 0001 |
| `skills.ts` | 22, 62, 112, 114, 157, 169, 195, 211, 213, 327, 333, 337, 387, 389, 391, 393, 401, 408, 423 | Tautology | Deleted |
| `skills.ts` | 117, 139 | Stale | Removed the milestone and obsolete router references. ADR 0001 preserves the current effort-hint contract. |
| `skills.ts` | 25, 26, 27 | Excuse | Deleted the justification, recorded the issue locally and unified skill and settings validation with the shared validator |
| `skills.ts` | 15, 33, 44, 58, 75, 119, 152, 243, 279, 300, 322, 357, 395, 397, 420, 481 | Decision Record | Migrated to ADR 0001 |
| `skills.ts` | 132, 134, 215 | Decision Record | Recorded in ADR 0001. Retained the three SDK declaration comments for `Skill.effects`, `Skill.paths` and `LoadSkillsFromDirOptions.isPathAllowed`. |

The five files contained 49 comment tokens on 99 standalone lines. The sweep removed 46 tokens and 93 lines. Six lines remain in published interface documentation. The lint baseline names the three retained comments verbatim.

A November 21 inventory of the working tree counted **90,586 comment-only lines** across 2,938 repository-owned JavaScript and TypeScript files, plus 649 lines shared with code. That is the gross upper bound on source lines removed if every standalone comment disappears. ADRs, published documentation and required directives affect the net saving. Recompute with `node scripts/check-source-comments.mjs --inventory .`.

[Discovery and activation decision](0001-skill-discovery.md) · [Definition write decision](0002-skill-definition-writes.md) · [Thinking-level issue and repair](../issues/skill-thinking-level-validation.md)
