/**
 * The ceiling a session holds over every worker it starts. A session that lends its workers the owner's reach (the root:
 * `SessionCapabilities.lendsOwnerReach`) answers "unbounded": a worker of it is bounded by its profile, the edge mode and
 * the session's envelope reads (its budget, inherited tool surface, denied tools and default capabilities), as before.
 * Any other session holds its workers to its own reach: a worker of it writes, reads, runs commands, reaches the network
 * and holds capabilities no wider than the session itself.
 *
 * The ceiling is read live at each worker plan (`buildWorkerExecutionPlan`), never captured when the session loads: a
 * session's envelope can be assigned after it is created, and its tool surface follows its tool selection. It is read from
 * the facts the session's own confinement is built from (`SessionConfinement`: its read-only shell line, read roots,
 * write roots and denied paths, as its path envelopes computed them), its held tools and its envelope. A worker placed in
 * a worktree lane works on a checkout of the session's directory, so the ceiling's roots are moved into that lane as the
 * request's own paths are (`WorkerLanePlacement`).
 */

import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import { getPrivateLaneDeniedPaths } from "../autonomy/lane-private-paths.ts";
import type { SessionConfinement } from "../autonomy/session-confinement.ts";
import type { HarnessCapability } from "../orchestration/contracts.ts";
import type { SessionCapabilities } from "../session-standing.ts";
import {
	getToolCapabilityPolicy,
	isGrantedExtensionToolName,
	READ_ONLY_SHELL_TOOL_NAMES,
	resolveCapabilityPathAccess,
} from "../tool-capability-policy.ts";

/** What a session that holds its workers to its own reach lends them. */
export interface WorkerParentCeiling {
	/** The roots its workers may write in: unset bounds no write root, empty writes nowhere. */
	readonly writeRoots?: readonly string[];
	/** Its workers edit nothing, in every mode (`writeRoots` is empty). */
	readonly readOnly: boolean;
	/** The session's shell is held to the read-only line: so is every worker's shell. */
	readonly shellReadOnly: boolean;
	/** The roots its workers may read in; unset when the session's reads are not confined. */
	readonly readRoots?: readonly string[];
	/** The paths denied to the session, denied to its workers as well. */
	readonly deniedPaths: readonly string[];
	/** The capabilities it holds: its envelope's, else those its held tools need (with the network its commands reach). */
	readonly capabilities: readonly HarnessCapability[];
}

/** The ceiling a directing session holds over its workers; "unbounded" where it lends the owner's reach. */
export type WorkerCeiling = WorkerParentCeiling | "unbounded";

/** What a session lends to read its ceiling from (`ParentExecutionContext` members). */
export interface WorkerCeilingSource {
	getSessionConfinement(): SessionConfinement;
	getForegroundToolNames(): readonly string[];
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
}

/** Whether a tool runs processes: an interpreter, a script, a launcher or a shell. */
function runsProcesses(toolName: string): boolean {
	return (
		getToolCapabilityPolicy(toolName)?.capabilityClauses.some((clause) => clause.includes("process.exec")) ?? false
	);
}

/**
 * Whether a held tool lets the session change files: the shell unless it is held to the read-only line, any other tool
 * that runs processes (an interpreter or a script is not judged command by command), a tool that needs a write path
 * capability, and a granted extension's tool or an uncatalogued one (what its code writes cannot be judged). A control
 * tool (a watch, a plan, a judgment, a message) changes no file, whatever a read-only grant keeps.
 */
function toolChangesFiles(toolName: string, shellReadOnly: boolean): boolean {
	if (READ_ONLY_SHELL_TOOL_NAMES.has(toolName.toLowerCase())) return !shellReadOnly;
	const policy = getToolCapabilityPolicy(toolName);
	if (!policy || isGrantedExtensionToolName(toolName)) return true;
	return (
		runsProcesses(toolName) ||
		policy.capabilityClauses.some((clause) => resolveCapabilityPathAccess(clause) === "write")
	);
}

/**
 * Whether the session's commands reach the network: an unjudged process tool always does, and a shell does unless it is
 * held to a read-only line without the network.
 */
function reachesNetwork(toolNames: readonly string[], confinement: SessionConfinement): boolean {
	return toolNames.some((name) =>
		READ_ONLY_SHELL_TOOL_NAMES.has(name.toLowerCase())
			? (confinement.readOnlyShell?.network ?? true)
			: runsProcesses(name),
	);
}

/** The capabilities a session without an envelope holds: every one its held tools may need, and the network its commands reach. */
function heldCapabilities(toolNames: readonly string[], network: boolean): HarnessCapability[] {
	const held = new Set<HarnessCapability>(
		toolNames.flatMap((name) => getToolCapabilityPolicy(name)?.capabilityClauses.flat() ?? []),
	);
	if (network) held.add("network.http");
	return [...held];
}

/** The ceiling of a session that holds its workers to its own reach, from its confinement, held tools and envelope. */
export function sessionWorkerCeiling(source: WorkerCeilingSource): WorkerParentCeiling {
	const confinement = source.getSessionConfinement();
	const { readOnlyShell, readScope, deniedPaths } = confinement;
	const toolNames = source.getForegroundToolNames();
	const shellReadOnly = readOnlyShell !== undefined;
	// A session that changes no file lends no write root; one that does lends the roots it writes in itself.
	const writeRoots = toolNames.some((name) => toolChangesFiles(name, shellReadOnly)) ? confinement.writeRoots : [];
	// The session's own tool-stream directory is read by it alone; a worker's reads are its own.
	const exempt = new Set(readScope?.exemptReadPaths ?? []);
	return {
		...(writeRoots ? { writeRoots } : {}),
		readOnly: writeRoots?.length === 0,
		shellReadOnly,
		...(readScope ? { readRoots: readScope.readRoots.filter((root) => !exempt.has(root)) } : {}),
		deniedPaths,
		capabilities:
			source.getCapabilityEnvelope()?.capabilities ??
			heldCapabilities(toolNames, reachesNetwork(toolNames, confinement)),
	};
}

/** The ceiling a session holds over its workers, by its standing: the owner's reach, else its own. */
export function workerCeilingOf(
	standing: Pick<SessionCapabilities, "lendsOwnerReach">,
	source: WorkerCeilingSource,
): WorkerCeiling {
	return standing.lendsOwnerReach ? "unbounded" : sessionWorkerCeiling(source);
}

/** Where a worker's directory lies among the worktree lanes (`WorkerLaneIsolation`). */
export interface WorkerLanePlacement {
	/**
	 * The mover of paths stated against the session's directory `root` into the lane `directory` lies in, as a request's
	 * own paths are moved there; undefined when `directory` is in no lane.
	 */
	laneOf(directory: string, root: string): ((entry: string) => string) | undefined;
}

/** The ceiling as a worker in a worktree lane is held to it: its roots moved into the lane by `move`. */
function ceilingInLane(ceiling: WorkerParentCeiling, move: (entry: string) => string): WorkerParentCeiling {
	return {
		...ceiling,
		...(ceiling.readRoots ? { readRoots: ceiling.readRoots.map(move) } : {}),
		...(ceiling.writeRoots ? { writeRoots: ceiling.writeRoots.map(move) } : {}),
	};
}

/** The capabilities a worker under `ceiling` may hold out of `capabilities`. */
export function capabilitiesUnderCeiling(
	capabilities: readonly HarnessCapability[],
	ceiling: WorkerParentCeiling,
): HarnessCapability[] {
	const held = new Set(ceiling.capabilities);
	return capabilities.filter((capability) => held.has(capability));
}

/**
 * What the session that starts a worker lends where its plan is built: the private harness paths every worker is denied,
 * the host's read root, the session's ceiling and whether it lends memory reads (retrieval on, in a session that holds
 * the owner's history or memory).
 */
export interface WorkerHostScope {
	readonly deniedPaths: readonly string[];
	readonly readRoot?: string;
	readonly parentCeiling: WorkerCeiling;
	readonly memoryEnabled: boolean;
}

/** The members of the session that starts a worker its host scope is read from (`ParentExecutionContext` members). */
export interface WorkerScopeHost {
	getCwd(): string;
	getAgentDir(): string;
	workerReadRoot?(): string;
	workerCeiling(): WorkerCeiling;
	servesLaneMemory(): boolean;
	getSettingsManager(): { getMemoryRetrievalSettings(): { enabled: boolean } };
}

/**
 * The host's scope over a worker that runs in `executionCwd`: the private paths denied to every lane, the read root a host
 * confines every worker to, the ceiling of the session that starts it, read now and moved into the worker's lane when
 * `lanes` places it in one, and its memory lending.
 */
export function workerHostScope(
	host: WorkerScopeHost,
	executionCwd: string | undefined,
	lanes: WorkerLanePlacement | undefined,
): WorkerHostScope {
	const ceiling = host.workerCeiling();
	const move =
		ceiling !== "unbounded" && executionCwd !== undefined ? lanes?.laneOf(executionCwd, host.getCwd()) : undefined;
	return {
		deniedPaths: getPrivateLaneDeniedPaths(host.getCwd(), host.getAgentDir()),
		...(host.workerReadRoot ? { readRoot: host.workerReadRoot() } : {}),
		parentCeiling: move && ceiling !== "unbounded" ? ceilingInLane(ceiling, move) : ceiling,
		memoryEnabled: host.getSettingsManager().getMemoryRetrievalSettings().enabled && host.servesLaneMemory(),
	};
}
