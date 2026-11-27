/** Indexes durable goal lifetimes and refuses ambiguous ownership before orchestration effects. */
import type { SessionEntry, SessionManager } from "../../kernel/node.ts";
import { GOAL_STATE_CUSTOM_TYPE } from "../../kernel/session/session-entries.ts";
import { visitSessionAncestry } from "../../kernel/session/session-tree.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { type GoalState, isGoalEvent } from "./goal-state.ts";

export { GOAL_STATE_CUSTOM_TYPE };

interface GoalIdentitySource {
	getEntries?(): readonly SessionEntry[];
	getBranch?(): readonly SessionEntry[];
	getEntryCount?(): number;
	getEntriesSince?(start: number): readonly SessionEntry[];
	getSessionId?(): string;
	getEntry?(id: string): SessionEntry | undefined;
}

interface RecordedGoalIdentity {
	goalId: string;
	createdAt?: string;
	cleared?: boolean;
	status?: string;
	revision?: number;
	terminalRevision?: number;
	terminalStatus?: "completed" | "cancelled";
	reopenRevisions?: readonly number[];
}

function recordedGoalLifecycle(
	events: unknown,
	base: unknown,
): Pick<RecordedGoalIdentity, "terminalRevision" | "terminalStatus" | "reopenRevisions"> {
	if (
		!Array.isArray(events) ||
		typeof base !== "number" ||
		!Number.isSafeInteger(base) ||
		base < 0 ||
		!events.every(isGoalEvent)
	)
		return {};
	let terminalRevision: number | undefined;
	let terminalStatus: "completed" | "cancelled" | undefined;
	const reopenRevisions: number[] = [];
	for (const [index, event] of events.entries()) {
		const revision = base + index + 1;
		if (event.type === "complete_goal" || event.type === "complete_goal_manually" || event.type === "cancel_goal") {
			terminalRevision = revision;
			terminalStatus = event.type === "cancel_goal" ? "cancelled" : "completed";
		}
		if (
			event.type === "edit_goal" ||
			event.type === "correct_completed_goal" ||
			event.type === "reopen_unproven_completion"
		)
			reopenRevisions.push(revision);
	}
	return {
		...(terminalRevision === undefined ? {} : { terminalRevision, terminalStatus }),
		...(reopenRevisions.length ? { reopenRevisions } : {}),
	};
}

function recordedGoalIdentity(entry: SessionEntry): RecordedGoalIdentity | undefined {
	if (entry.type !== "custom" || entry.customType !== GOAL_STATE_CUSTOM_TYPE || !isPlainRecord(entry.data))
		return undefined;
	const data = entry.data;
	if (
		(data.version === 1 || (data.version === 2 && data.kind === "checkpoint")) &&
		isPlainRecord(data.state) &&
		typeof data.state.goalId === "string"
	) {
		const state = data.state;
		const revision = typeof state.revision === "number" ? state.revision : undefined;
		const lifecycle = recordedGoalLifecycle(
			state.events,
			revision === undefined || !Array.isArray(state.events) ? undefined : revision - state.events.length,
		);
		return {
			goalId: data.state.goalId,
			...(typeof state.createdAt === "string" ? { createdAt: state.createdAt } : {}),
			...(typeof state.status === "string" ? { status: state.status } : {}),
			...(revision === undefined ? {} : { revision }),
			...((state.status === "completed" || state.status === "cancelled") && revision !== undefined
				? { terminalRevision: revision, terminalStatus: state.status }
				: {}),
			...(lifecycle.reopenRevisions ? { reopenRevisions: lifecycle.reopenRevisions } : {}),
		};
	}
	if (data.version === 2 && (data.kind === "events" || data.kind === "cleared") && typeof data.goalId === "string")
		return {
			goalId: data.goalId,
			...(data.kind === "cleared" ? { cleared: true } : recordedGoalLifecycle(data.events, data.baseRevision)),
		};
	return undefined;
}

interface GoalIdentityIndex {
	sessionId?: string;
	count: number;
	tail?: SessionEntry;
	origins: Map<string, string>;
	conflicts: Set<string>;
	clears: Map<string, Set<string>>;
	terminals: Map<string, Map<string, { revision: number; status: "completed" | "cancelled" }>>;
	reopens: Map<string, Map<string, readonly number[]>>;
	checkpoints: Map<string, { goalId: string; createdAt: string }>;
}
const goalIdentities = new WeakMap<object, GoalIdentityIndex>();

/** Only goal records are retained. Parent lookup is needed only after a clear could prove same-clock reuse. */
function goalIdentityIndex(source: GoalIdentitySource): GoalIdentityIndex {
	const incremental = !!source.getEntriesSince && !!source.getEntryCount && !!source.getSessionId && !!source.getEntry;
	const count = source.getEntryCount?.() ?? 0;
	const sessionId = source.getSessionId?.();
	let index = incremental ? goalIdentities.get(source) : undefined;
	if (
		!index ||
		index.sessionId !== sessionId ||
		index.count > count ||
		(index.tail && source.getEntry?.(index.tail.id) !== index.tail)
	)
		index = {
			sessionId,
			count: 0,
			origins: new Map(),
			conflicts: new Set(),
			clears: new Map(),
			terminals: new Map(),
			reopens: new Map(),
			checkpoints: new Map(),
		};
	const entries = incremental
		? source.getEntriesSince!(index.count)
		: (source.getEntries?.() ?? source.getBranch?.() ?? []);
	const fallbackEntries = source.getEntry ? undefined : new Map(entries.map((entry) => [entry.id, entry]));
	const ancestry = {
		size: incremental ? count : entries.length,
		get: (id: string) => source.getEntry?.(id) ?? fallbackEntries?.get(id),
	};
	for (const entry of entries) {
		const identity = recordedGoalIdentity(entry);
		if (identity?.createdAt !== undefined) {
			const original = index.origins.get(identity.goalId);
			if (original !== undefined && original !== identity.createdAt) index.conflicts.add(identity.goalId);
			else if (original === undefined) index.origins.set(identity.goalId, identity.createdAt);
			const clears = index.clears.get(identity.goalId);
			const terminals = identity.status === "active" ? index.terminals.get(identity.goalId) : undefined;
			if ((clears || terminals) && !index.conflicts.has(identity.goalId)) {
				const reopenRevisions = new Set(identity.reopenRevisions);
				visitSessionAncestry(entry.parentId ? ancestry.get(entry.parentId) : undefined, ancestry, (prior) => {
					for (const revision of index!.reopens.get(identity.goalId)?.get(prior.id) ?? [])
						reopenRevisions.add(revision);
					const terminal = terminals?.get(prior.id);
					if (
						clears?.has(prior.id) ||
						(terminal && (terminal.status === "cancelled" || !reopenRevisions.has(terminal.revision + 1)))
					) {
						index!.conflicts.add(identity.goalId);
						return false;
					}
					if (terminal) return false;
					const checkpoint = index!.checkpoints.get(prior.id);
					if (checkpoint?.goalId === identity.goalId && checkpoint.createdAt === identity.createdAt) return false;
				});
			}
			index.checkpoints.set(entry.id, { goalId: identity.goalId, createdAt: identity.createdAt });
		}
		if (identity?.terminalRevision !== undefined && identity.terminalStatus !== undefined) {
			const terminals =
				index.terminals.get(identity.goalId) ??
				new Map<string, { revision: number; status: "completed" | "cancelled" }>();
			terminals.set(entry.id, { revision: identity.terminalRevision, status: identity.terminalStatus });
			index.terminals.set(identity.goalId, terminals);
		}
		if (identity?.reopenRevisions) {
			const reopens = index.reopens.get(identity.goalId) ?? new Map<string, readonly number[]>();
			reopens.set(entry.id, identity.reopenRevisions);
			index.reopens.set(identity.goalId, reopens);
		}
		if (identity?.cleared) {
			const clears = index.clears.get(identity.goalId) ?? new Set<string>();
			clears.add(entry.id);
			index.clears.set(identity.goalId, clears);
		}
	}
	index.count = incremental ? count : entries.length;
	index.tail = entries.at(-1) ?? index.tail;
	if (incremental) goalIdentities.set(source, index);
	return index;
}

export function goalIdentityConflict(source: GoalIdentitySource, goal: GoalState | string): string | undefined {
	const index = goalIdentityIndex(source);
	const goalId = typeof goal === "string" ? goal : goal.goalId;
	const original = index.origins.get(goalId);
	return index.conflicts.has(goalId) ||
		(typeof goal !== "string" && original !== undefined && original !== goal.createdAt)
		? `Goal ID '${goalId}' belongs to multiple durable lifetimes. Goal work is held to preserve their objectives and worker receipts. Use /goal clear, then start a goal with a new ID.`
		: undefined;
}

export function assertGoalIdentityUnambiguous(source: GoalIdentitySource, goal: GoalState | string): void {
	const conflict = goalIdentityConflict(source, goal);
	if (conflict) throw new Error(conflict);
}

/** Goal IDs address durable objectives and remain allocated after completion, clearing, or branch navigation. */
export function assertGoalIdentityAvailable(
	sessionManager: Pick<SessionManager, "getEntries">,
	state: GoalState,
	previous: GoalState | undefined,
	hasDurableObjective?: (goalId: string) => boolean,
): void {
	if (previous?.goalId === state.goalId && previous.createdAt === state.createdAt) return;
	const allocated =
		hasDurableObjective?.(state.goalId) ||
		sessionManager.getEntries().some((entry) => recordedGoalIdentity(entry)?.goalId === state.goalId);
	if (allocated)
		throw new Error(
			`Goal ID '${state.goalId}' is already allocated in this session. Choose a new goal ID for a new goal.`,
		);
}

/** A resume reports the durable ambiguity once and leaves orchestration untouched. */
export function reportGoalIdentityConflict(
	host: { getSessionManager(): GoalIdentitySource; emitWarning(message: string): void },
	goal: GoalState | undefined,
): boolean {
	const conflict = goal && goalIdentityConflict(host.getSessionManager(), goal);
	if (!conflict) return false;
	host.emitWarning(conflict);
	return true;
}
