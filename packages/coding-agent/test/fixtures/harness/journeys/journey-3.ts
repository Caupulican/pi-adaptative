import "../builtin-install.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES } from "../../../../src/core/default-tool-surface.ts";
import { harnessPath, projectPath } from "../session-fixture.ts";
import { runJourney3ContinuousChatPhase } from "./journey-3-continuous-chat.ts";
import { runJourney3WorktreeAndGatesPhase } from "./journey-3-worktree-and-gates.ts";
/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import { NOTES_V1, ORIGINAL_LIMITS, OWNER_DRAFT_DIRTY, OWNER_DRAFT_V1, runJourney } from "./shared.ts";

export async function runJourney3(): Promise<void> {
	await runJourney(
		{
			name: "journey-3",
			// worktree_sync is opt-in: the owner's default-tools setting names it alongside the default surface. The owner's draft is
			// dirty from the start, so lanes are created explicitly and the worker is started on its request-visible lane checkout.
			settings: { defaultTools: [...DEFAULT_ACTIVE_TOOL_NAMES, "worktree_sync"] },
			warningAllowances: [
				/^Memory subsystem init failed: Legacy memory import is incomplete and will retry: 2026-01-01T00-00-00-000Z_headless-legacy\.jsonl: the file cannot be read: .+$/,
			],
			files: {
				[projectPath("src", "limits.ts")]: ORIGINAL_LIMITS,
				[projectPath("src", "owner.md")]: OWNER_DRAFT_DIRTY,
				[projectPath("src", "notes.md")]: NOTES_V1,
				[harnessPath("e10-outside", "d.txt")]: "E10-SENTINEL\n",
			},
			repository: {
				committed: { "src/limits.ts": ORIGINAL_LIMITS, "src/owner.md": OWNER_DRAFT_V1, "src/notes.md": NOTES_V1 },
				dirty: { "src/owner.md": OWNER_DRAFT_DIRTY },
			},
		},
		async (world) => {
			await runJourney3WorktreeAndGatesPhase(world);
			await runJourney3ContinuousChatPhase(world);
		},
	);
}
