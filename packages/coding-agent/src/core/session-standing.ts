/**
 * Session standing: what one session is (a root, a worker, a bot's own session or an in-memory vehicle) and the one
 * code-owned table of what each standing may do. session-role.ts answers the process question (is this process a
 * worker); this module answers the per-session one. Every session-scoped gate reads a named capability from
 * `sessionCapabilities`, so two sessions answer differently only through the table below.
 */
import type { RoutineScope } from "./routines/routine-holder.ts";
import { isWorkerSession } from "./session-role.ts";

export type SessionStanding =
	/** The owner's own session: interactive, SDK or CLI. */
	| { readonly kind: "root" }
	/** A worker reporting to a parent: a worker process, `PI_CHILD_SESSION=1`, or an SDK child. */
	| { readonly kind: "worker" }
	/** A bot's own session. `agentId` is reserved for its per-bot state roots; no capability reads it yet. */
	| { readonly kind: "bot"; readonly agentId: string }
	/** An in-memory session another host drives: an away channel's third-party turn, an away parent's model calls. */
	| { readonly kind: "vehicle" };

export interface SessionCapabilities {
	/** Holds the process-wide singletons: runtime update, the shared bot session host, the remote hub, the placed-job route. */
	readonly ownsProcessSingletons: boolean;
	/** Does the host's duties: serves channels and `channel_reply`, reconciles the always-on service, reopens bots owed work. */
	readonly ownsHostDuties: boolean;
	/** Reads the owner's memory into its prompt: the knowledge prompt and reader, the USER.md persona, the file-store block. */
	readonly readsOwnerMemory: boolean;
	/** Writes the owner's memory: MEMORY.md and USER.md, the memory tool, provider writes, knowledge collection, the switch. */
	readonly ownsMemoryWrites: boolean;
	/** Owns the owner's history: the ICM project chat and its wire, history recall, `zoom`/`date`, the transcript hierarchy. */
	readonly ownsHistory: boolean;
	/** Owns the agentDir's learning: durable learning state, reflection and learner writes, skill curation. */
	readonly ownsLearning: boolean;
	/** Holds the soul gate: writes to the owner's soul.md are held and reviewed through this session. */
	readonly reviewsSoulWrites: boolean;
	/** Edits the owner's proactivity settings (the `proactivity` tool). */
	readonly writesOwnerSettings: boolean;
	/** Answers for its checkout: pins the GitHub origin and acts ahead on the checkout's failing CI. */
	readonly answersForCheckout: boolean;
	/** Manages bots: the `bot` tool, leaders and their terminal route, the retire-leader refusal. */
	readonly managesBots: boolean;
	/** Directs workers: the delegation gate, director prompt and root work hooks, the plan tool and executor, retention. */
	readonly directsWorkers: boolean;
	/** Runs the proactive lanes: proactive review and the research lane. */
	readonly runsProactiveLanes: boolean;
	/** Converses with the owner: keeps harness notices, the work lifecycle prompt, `self_compact`, semantic uncertainties. */
	readonly conversesWithOwner: boolean;
	/** May ask the owner live: an edge operation without a grant gets the confirmation handler instead of a refusal. */
	readonly asksOwnerLive: boolean;
	/** Keeps owner follow-ups: a refused handoff operation is deferred to the owner, and announced when the session starts. */
	readonly keepsOwnerFollowUps: boolean;
	/** An owner may wait on its foreground turns, so their requests may buy the fast tier. */
	readonly liveOwnerTurns: boolean;
	/** Its provider requests run in the caller's interaction mode, with interactive auth recovery, not as background. */
	readonly interactiveAuth: boolean;
	/** What its routine runtime holds; undefined where it holds none. */
	readonly routineScope: RoutineScope | undefined;
}

type FlagCapability = Exclude<keyof SessionCapabilities, "routineScope">;

type Row = readonly [root: boolean, worker: boolean, bot: boolean, vehicle: boolean];

/** One row per capability, one column per standing kind. */
const FLAGS: Readonly<Record<FlagCapability, Row>> = {
	ownsProcessSingletons: [true, false, false, false],
	ownsHostDuties: [true, false, false, false],
	readsOwnerMemory: [true, false, false, false],
	ownsMemoryWrites: [true, false, false, false],
	ownsHistory: [true, false, false, false],
	ownsLearning: [true, false, false, false],
	reviewsSoulWrites: [true, false, false, false],
	writesOwnerSettings: [true, false, false, false],
	answersForCheckout: [true, false, false, false],
	managesBots: [true, false, false, false],
	directsWorkers: [true, false, false, false],
	runsProactiveLanes: [true, false, false, false],
	conversesWithOwner: [true, false, false, false],
	asksOwnerLive: [true, false, false, false],
	keepsOwnerFollowUps: [true, false, false, false],
	liveOwnerTurns: [true, false, false, false],
	interactiveAuth: [true, false, false, false],
};

const ROUTINE_SCOPES: Readonly<Record<SessionStanding["kind"], RoutineScope | undefined>> = {
	root: "session",
	worker: undefined,
	bot: "own-watches",
	vehicle: undefined,
};

const COLUMNS = { root: 0, worker: 1, bot: 2, vehicle: 3 } as const;

function capabilitiesOf(kind: SessionStanding["kind"]): SessionCapabilities {
	const column = COLUMNS[kind];
	const flags = Object.fromEntries(Object.entries(FLAGS).map(([name, row]) => [name, row[column]]));
	return Object.freeze({ ...(flags as Record<FlagCapability, boolean>), routineScope: ROUTINE_SCOPES[kind] });
}

const CAPABILITIES: Readonly<Record<SessionStanding["kind"], SessionCapabilities>> = {
	root: capabilitiesOf("root"),
	worker: capabilitiesOf("worker"),
	bot: capabilitiesOf("bot"),
	vehicle: capabilitiesOf("vehicle"),
};

/** What a session of this standing may do; the same frozen value for every session of one kind. */
export function sessionCapabilities(standing: SessionStanding): SessionCapabilities {
	return CAPABILITIES[standing.kind];
}

const ROOT: SessionStanding = Object.freeze({ kind: "root" });
const WORKER: SessionStanding = Object.freeze({ kind: "worker" });

/**
 * The session's standing, resolved once where the session is built. An explicit `standing` wins; otherwise the
 * deprecated `isChildSession` (true: a worker), or when that is absent `PI_CHILD_SESSION=1` (an external marker a
 * launcher may set), makes it a worker. A worker process turns a root into a worker; a bot or a vehicle keeps its
 * standing there.
 */
export function resolveSessionStanding(
	input: { readonly standing?: SessionStanding; readonly isChildSession?: boolean },
	env: NodeJS.ProcessEnv = process.env,
): SessionStanding {
	const declared = input.standing ?? ((input.isChildSession ?? env.PI_CHILD_SESSION === "1") ? WORKER : ROOT);
	return declared.kind === "root" && isWorkerSession(env) ? WORKER : declared;
}
