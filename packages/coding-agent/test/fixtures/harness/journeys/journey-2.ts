import "../builtin-install.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES } from "../../../../src/core/default-tool-surface.ts";
import { runJourney2BackgroundAndStallPhase } from "./journey-2-background-and-stall.ts";
import { runJourney2ContinuousChatPhase } from "./journey-2-continuous-chat.ts";
import { runJourney2OrchestrationPhase } from "./journey-2-orchestration.ts";
import { runJourney2QueuedRecoveryPhase } from "./journey-2-queued-recovery.ts";
/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import { LIMITS_PATH, runJourney } from "./shared.ts";

export async function runJourney2(): Promise<void> {
	await runJourney(
		{
			name: "journey-2",
			journey: 2,
			// The planned two large reports and their chunked artifact read need more than the default 32k root window. The window is
			// set once for the provider and the registry, so manual compaction and its keep budget still see one model.
			modelOptions: { root: { contextWindow: 131_072 } },
			// Exact expected refusal of the E7 negative control: the busy, dead-owner A is never resumed, and nothing else is allowed.
			warningAllowances: [
				/^Worker conversation setup failed: Worker queued context has no proof of never-started, dead-owner recovery\.$/,
				/^Memory subsystem init failed: The ICM chat for this project is owned by pid \d+ on [^\n]+, session [^\n]+, started [^\n]+, still running\. Only one session per project may run the ICM chat; close that session first\.$/,
				// R18/R19 (System One off): the refused idle-root wake-up's one retrying report and its park, both caused by the
				// session-file fence the one denied append raised.
				/^Failed to notify terminal background tool task batch tool-task-\d+ \(retrying\): Session persistence state is uncertain after a failed write; reopen the session file or start a new session before appending\.$/,
				/^Background tool completion wake-up for tool-task-\d+ is parked after 10 consecutive failed deliveries \(still pending; the session file refused a write and accepts no append until the session is reopened; delivery resumes then; tool_task action=wait collects it now\): Session persistence state is uncertain after a failed write; reopen the session file or start a new session before appending\.$/,
			],
			files: { [LIMITS_PATH]: "export const MAX_RETRIES = 3;\n" },
			// A clean checkout on main: a fresh writer worker gets its own worktree lane (dirty checkouts fall back to shared).
			repository: { committed: { "src/limits.ts": "export const MAX_RETRIES = 3;\n" } },
			// Deliberate control, not a budget fix: a 1k recent-keep moves the kept tail past the failed run, so the open
			// obligation must outlive the receipt that created it. The checkpoint asserts the receipt is absent from the provider
			// context while the obligation's trusted identity stays in the compaction details.
			settings: {
				defaultTools: [...DEFAULT_ACTIVE_TOOL_NAMES, "worktree_sync"],
				edge: { allow: [] },
				compaction: { keepRecentTokens: 1_000 },
			},
		},
		async (world) => {
			await runJourney2OrchestrationPhase(world);
			await runJourney2BackgroundAndStallPhase(world);
			await runJourney2QueuedRecoveryPhase(world);
			await runJourney2ContinuousChatPhase(world);
		},
	);
}
