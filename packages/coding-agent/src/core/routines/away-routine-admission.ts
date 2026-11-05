/**
 * Which saved routine runs may run away (their session not open). A run away has no System One operation gate, no
 * worktree lane isolation, no memory and no owner words: those are the open session's. So only a run whose admitted
 * authority (worker and mandatory verifier) reads and reports, with at most a read-only profile's shell, runs away; a
 * run that can change files, processes,
 * memory, settings, skills or publish waits for its session and is reported once.
 */

import type { HarnessCapability } from "../capability-contract.ts";
import type { WorkerSavedIntent } from "../delegation/worker-saved-intent.ts";

/**
 * Capabilities that observe without changing anything a run away could not answer for. Excluded on purpose:
 * `skill.read` (no skill broker away), `research.execute` (model_fitness probes spend outside the attempt's
 * accounting and the away spend bound), `workflow.plan` (routine/task tools that plan or save work the open
 * session owns) and `semantic.judge` (no System One away).
 */
const AWAY_CAPABILITIES: ReadonlySet<HarnessCapability> = new Set<HarnessCapability>([
	"filesystem.read",
	"worktree.read",
	"repo.read",
	"source.read",
	"settings.read",
	"network.http",
]);

/** A due routine with no saved run: nothing pins the parent it would run in. */
export const AWAY_UNPINNED_REASON =
	"it has no saved run with a pinned origin, so it runs only while its session is open.";
/** A saved run whose pinned origin the parent's current branch no longer carries. */
export const AWAY_OFF_BRANCH_REASON =
	"its saved origin is not on the session's current branch, or that branch is empty, so it waits for the session to open.";

/** A saved run whose pinned origin names no session file: nothing locates the parent to open away. */
export const AWAY_NO_SESSION_FILE_REASON =
	"its saved origin names no session file, so it runs only while its session is open.";
/** The parent's lease registry cannot be read, so nothing proves its session closed. */
export const AWAY_LEASES_UNREADABLE_REASON =
	"its session's lease registry cannot be read, so nothing proves the session closed; it waits for the session to open.";

/** Why this saved run cannot run away, or undefined when it can. */
export function awayRunRefusal(intent: WorkerSavedIntent): string | undefined {
	const contract = intent.executionContract;
	const profiles = contract.verifier ? [contract.worker, contract.verifier] : [contract.worker];
	const outside = new Set<string>();
	for (const profile of profiles) {
		// Every worker is granted the host's shell (`process.exec`). A read-only profile keeps only a shell whose commands
		// the deterministic read-only line admits, with no interpreter or script tool, as in a session with System One off.
		const readOnlyShell = profile.profile.readOnly === true;
		for (const capability of profile.authority.capabilities)
			if (!AWAY_CAPABILITIES.has(capability) && !(readOnlyShell && capability === "process.exec"))
				outside.add(capability);
		if (profile.authority.writePaths.length > 0) outside.add("filesystem.write");
	}
	if (intent.knowledgeReferences.length > 0) outside.add("memory.query");
	// A goal and host-event subscriptions are tracked by the open session's goal owner and event custody.
	if (intent.objectiveId !== null) outside.add("a goal binding");
	if (intent.subscriptions.length > 0) outside.add("host-event subscriptions");
	if (outside.size === 0) return undefined;
	return `its run needs ${[...outside].sort().join(", ")}, which only the open session can gate and isolate, so it waits for the session to open.`;
}
