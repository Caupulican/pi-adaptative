/**
 * The durable record of delegations to leaders, kept in the root session's orchestration store: one objective per
 * delegation (`delegation-<id>`), with the charter, the dispatch, each update and the final Outcome as trusted kernel
 * evidence on it. The objective's own lifecycle (active, paused, completed, cancelled) is the delegation's. This module is
 * the only writer and reader of that record; nothing else keeps a copy.
 */

import { randomUUID } from "node:crypto";
import type { JsonObject } from "../../kernel/utils/json-types.ts";
import { MAX_ORCHESTRATION_DESCRIPTION_LENGTH, type ObjectiveStatus } from "../orchestration/contracts.ts";
import {
	isLeaderDelegationObjectiveId,
	LEADER_DELEGATION_OBJECTIVE_PREFIX,
} from "../orchestration/delegation-ledger.ts";
import type { AttemptRuntimeState, DurableTaskRuntime, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { boundedText } from "../util/bounded-line.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	type DelegationHop,
	LEADER_CAPABILITIES,
	LEADER_MAX_DEPTH_CEILING,
	type LeaderCapability,
	type LeaderEnvelope,
	type LeadRequest,
	leadRequestFrom,
} from "./leader-delegation.ts";
import { storedOutcomeFromValue } from "./worker-outcome-codec.ts";
import { isOutcomeFromNewerBuild, type Outcome } from "./worker-outcome-contract.ts";

export const DELEGATION_OBJECTIVE_PREFIX = LEADER_DELEGATION_OBJECTIVE_PREFIX;
const CHARTER_EVIDENCE = "delegation-charter";
const DISPATCH_EVIDENCE = "delegation-dispatch";
/** The dispatch mark of a delegation whose turns are filed under its objective (absent on one an earlier build dispatched). */
const DISPATCH_FILING_BY_OBJECTIVE = "objective";
const OUTCOME_EVIDENCE = "delegation-outcome";
/** Written on a nested delegation once its Outcome reached the parent leader; a restart reads it instead of resending. */
const DELIVERED_TO_PARENT_EVIDENCE = "delegation-outcome-delivered";
const UPDATE_EVIDENCE_PREFIX = "delegation-update-";
/** The most updates one delegation keeps; a leader needing more is better given a new goal. */
export const MAX_DELEGATION_UPDATES = 32;
export const MAX_DELEGATION_UPDATE_CHARS = 2000;

/** Why a delegation closed; the Outcome says how it ended, this says who or what ended it. */
export const DELEGATION_CLOSE_REASONS = [
	"settled",
	"cancelled",
	"deadline",
	"budget",
	"allowance",
	"leader_unavailable",
] as const;
export type DelegationCloseReason = (typeof DELEGATION_CLOSE_REASONS)[number];

export interface LeaderCharter {
	readonly v: 1;
	readonly leader: string;
	/** `owner`: a standing leader the owner made; `root`: a goal leader appointed for this goal (by the orchestrator or a leader). */
	readonly appointedBy: "owner" | "root";
	readonly lead: LeadRequest;
	readonly envelope: LeaderEnvelope;
	readonly clipped: readonly string[];
	readonly createdAt: string;
	/** The delegation whose leader handed this goal on; absent for a goal the orchestrator delegated. */
	readonly parentObjectiveId?: string;
}

export type DelegationState = "queued" | "running" | "paused" | "closed";

export interface DelegationRecord {
	readonly objectiveId: string;
	readonly title: string;
	readonly objectiveStatus: ObjectiveStatus;
	readonly state: DelegationState;
	readonly charter: LeaderCharter;
	readonly dispatchedAt?: string;
	/**
	 * Whether this delegation's turns are filed under its objective. False on one an earlier build dispatched: those turns
	 * were attributed by time window, and the controller keeps that attribution for them.
	 */
	readonly filedByObjective: boolean;
	readonly updates: readonly string[];
	readonly outcome?: Outcome;
	/** Whether a nested delegation's Outcome reached its parent leader (always false for a delegation with no parent). */
	readonly outcomeDeliveredToParent: boolean;
	readonly closeReason?: DelegationCloseReason;
	readonly closedAt?: string;
}

/** The runtime calls the ledger makes; the root session's durable task runtime satisfies it. */
export type LeaderLedgerRuntime = Pick<
	DurableTaskRuntime,
	| "getSnapshot"
	| "createObjective"
	| "recordObjectiveEvidence"
	| "pauseObjective"
	| "resumeObjective"
	| "cancelObjective"
	| "completeObjective"
>;

function toJson(value: object): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : undefined;
}

function hopFrom(value: unknown): DelegationHop | undefined {
	if (!isPlainRecord(value)) return undefined;
	const { machineId, objectiveId, leader } = value;
	return typeof machineId === "string" && typeof objectiveId === "string" && typeof leader === "string"
		? { machineId, objectiveId, leader }
		: undefined;
}

function envelopeFrom(value: unknown): LeaderEnvelope | undefined {
	if (!isPlainRecord(value)) return undefined;
	const capabilities = stringList(value.capabilities);
	const writePaths = stringList(value.writePaths);
	const chain = Array.isArray(value.chain) ? value.chain.map(hopFrom) : undefined;
	const models = isPlainRecord(value.models) ? value.models : undefined;
	const providers = models?.providers === undefined ? undefined : stringList(models.providers);
	if (
		!capabilities?.every((capability) => (LEADER_CAPABILITIES as readonly string[]).includes(capability)) ||
		!writePaths ||
		!chain ||
		chain.some((hop) => hop === undefined) ||
		!models ||
		(models.providers !== undefined && !providers) ||
		typeof value.readRoot !== "string" ||
		typeof value.leaderMayWrite !== "boolean" ||
		typeof value.remainingDepth !== "number" ||
		(value.budgetUsd !== undefined && typeof value.budgetUsd !== "number") ||
		(value.deadlineAt !== undefined && typeof value.deadlineAt !== "string")
	)
		return undefined;
	return {
		capabilities: capabilities as LeaderCapability[],
		readRoot: value.readRoot,
		writePaths,
		leaderMayWrite: value.leaderMayWrite,
		...(typeof value.budgetUsd === "number" ? { budgetUsd: value.budgetUsd } : {}),
		...(typeof value.deadlineAt === "string" ? { deadlineAt: value.deadlineAt } : {}),
		models: providers ? { providers } : {},
		remainingDepth: value.remainingDepth,
		chain: chain as DelegationHop[],
	};
}

/** A charter this build wrote; anything else (a newer build's shape, a damaged entry) is not a delegation it manages. */
function charterFrom(value: unknown): LeaderCharter | undefined {
	if (!isPlainRecord(value) || value.v !== 1) return undefined;
	const envelope = envelopeFrom(value.envelope);
	const clipped = stringList(value.clipped);
	if (
		typeof value.leader !== "string" ||
		(value.appointedBy !== "owner" && value.appointedBy !== "root") ||
		typeof value.createdAt !== "string" ||
		!envelope ||
		!clipped ||
		!isPlainRecord(value.lead)
	)
		return undefined;
	let lead: LeadRequest;
	try {
		lead = leadRequestFrom(value.lead);
	} catch {
		return undefined;
	}
	const parent = typeof value.parentObjectiveId === "string" && isLeaderDelegationObjectiveId(value.parentObjectiveId);
	return {
		v: 1,
		leader: value.leader,
		appointedBy: value.appointedBy,
		lead,
		envelope,
		clipped,
		createdAt: value.createdAt,
		...(parent ? { parentObjectiveId: value.parentObjectiveId as string } : {}),
	};
}

function closeReasonFrom(value: unknown): DelegationCloseReason | undefined {
	return (DELEGATION_CLOSE_REASONS as readonly unknown[]).includes(value)
		? (value as DelegationCloseReason)
		: undefined;
}

/** Every delegation this build can read, oldest first. */
export function readDelegations(snapshot: TaskRuntimeProjection): DelegationRecord[] {
	const records: DelegationRecord[] = [];
	for (const [objectiveId, state] of Object.entries(snapshot.objectives)) {
		if (!objectiveId.startsWith(DELEGATION_OBJECTIVE_PREFIX)) continue;
		const evidence = new Map(state.evidence.map((entry) => [entry.evidenceId, entry]));
		const charter = charterFrom(evidence.get(CHARTER_EVIDENCE)?.metadata);
		if (!charter) continue;
		const dispatch = evidence.get(DISPATCH_EVIDENCE)?.metadata;
		const closing = evidence.get(OUTCOME_EVIDENCE);
		let outcome: Outcome | undefined;
		if (closing?.metadata !== undefined) {
			try {
				const stored = storedOutcomeFromValue(closing.metadata.outcome, `${objectiveId}.outcome`);
				if (!isOutcomeFromNewerBuild(stored)) outcome = stored;
			} catch {
				outcome = undefined;
			}
		}
		const updates = state.evidence
			.filter((entry) => entry.evidenceId.startsWith(UPDATE_EVIDENCE_PREFIX))
			.map((entry) => (typeof entry.metadata?.text === "string" ? entry.metadata.text : entry.summary));
		const status = state.objective.status;
		const closedObjective = status === "completed" || status === "cancelled";
		const closeReason = closeReasonFrom(closing?.metadata?.closeReason);
		records.push({
			objectiveId,
			title: state.objective.title,
			objectiveStatus: status,
			state:
				closing || closedObjective
					? "closed"
					: status === "paused"
						? "paused"
						: typeof dispatch?.dispatchedAt === "string"
							? "running"
							: "queued",
			charter,
			...(typeof dispatch?.dispatchedAt === "string" ? { dispatchedAt: dispatch.dispatchedAt } : {}),
			filedByObjective: dispatch?.filing === DISPATCH_FILING_BY_OBJECTIVE,
			updates,
			...(outcome ? { outcome } : {}),
			outcomeDeliveredToParent: evidence.has(DELIVERED_TO_PARENT_EVIDENCE),
			...(closeReason ? { closeReason } : {}),
			...(closing ? { closedAt: closing.createdAt } : {}),
		});
	}
	return records.sort((left, right) => left.charter.createdAt.localeCompare(right.charter.createdAt));
}

/**
 * The open delegations nested under one delegation, deepest level first and oldest first within a level. The walk runs at
 * most as many levels as a chain may nest, so it ends even on a damaged parent link. The delegation itself is not included.
 */
export function openDescendantsDeepestFirst(
	records: readonly DelegationRecord[],
	objectiveId: string,
): DelegationRecord[] {
	const levels: DelegationRecord[][] = [];
	let frontier = new Set([objectiveId]);
	for (let level = 0; level < LEADER_MAX_DEPTH_CEILING; level++) {
		const next = records.filter(
			(record) =>
				record.state !== "closed" &&
				record.charter.parentObjectiveId !== undefined &&
				frontier.has(record.charter.parentObjectiveId),
		);
		if (next.length === 0) break;
		levels.push(next);
		frontier = new Set(next.map((record) => record.objectiveId));
	}
	return levels.reverse().flat();
}

/** The objective a turn's work is filed under: the delegation's own when the turn was started under it. */
function filedObjectiveOf(snapshot: TaskRuntimeProjection, attempt: AttemptRuntimeState): string | undefined {
	return snapshot.tasks[attempt.taskId]?.task.objectiveId;
}

/**
 * Whether a turn belongs to a delegation. A delegation dispatched by this build owns the turns filed under its objective:
 * what a turn was started as, never when it ran, so an owner's chat with the leader is not counted. A delegation an
 * earlier build dispatched has no filing mark: its turns are attributed by time window (from its dispatch until its close)
 * and only when the attempt's bot is the leader or a bot the leader created, so an unrelated worker in the window is not
 * the goal's.
 */
export function turnBelongsToDelegation(input: {
	readonly snapshot: TaskRuntimeProjection;
	readonly record: DelegationRecord;
	readonly attempt: AttemptRuntimeState;
	readonly directBotOf: (agentId: string) => string | undefined;
	readonly bots: () => readonly { readonly agentId: string; readonly createdBy?: string }[];
}): boolean {
	const { record, attempt } = input;
	if (attempt.agentId === undefined) return false;
	if (record.filedByObjective) return filedObjectiveOf(input.snapshot, attempt) === record.objectiveId;
	if (!record.dispatchedAt || attempt.createdAt < record.dispatchedAt) return false;
	if (record.closedAt !== undefined && attempt.createdAt > record.closedAt) return false;
	const alias = input.directBotOf(attempt.agentId);
	if (alias === undefined) return false;
	if (alias === record.charter.leader) return true;
	return input.bots().some((bot) => bot.agentId === alias && bot.createdBy === record.charter.leader);
}

/** A delegation's turns split between its leader and the bots that ran under it: its own leader's, and every other bot's. */
export function splitTurnsByLeader(
	turns: readonly AttemptRuntimeState[],
	aliasOf: (agentId: string) => string | undefined,
	leader: string,
): { readonly leaderTurns: AttemptRuntimeState[]; readonly ownedTurns: AttemptRuntimeState[] } {
	const aliasOfTurn = (turn: AttemptRuntimeState) => (turn.agentId === undefined ? undefined : aliasOf(turn.agentId));
	return {
		leaderTurns: turns.filter((turn) => aliasOfTurn(turn) === leader),
		ownedTurns: turns.filter((turn) => {
			const alias = aliasOfTurn(turn);
			return alias !== undefined && alias !== leader;
		}),
	};
}

/** The earliest deadline among the running delegations, in epoch milliseconds; undefined when none has one. */
export function earliestDeadlineMs(records: readonly DelegationRecord[]): number | undefined {
	return records
		.filter((record) => record.state === "running" && record.charter.envelope.deadlineAt !== undefined)
		.map((record) => Date.parse(record.charter.envelope.deadlineAt as string))
		.filter((at) => Number.isFinite(at))
		.sort((left, right) => left - right)[0];
}

function goalTitle(goal: string): string {
	return `Lead: ${boundedText(goal.split(/\r?\n/, 1)[0]!.trim(), 120)}`;
}

/** The writer: every durable step of a delegation goes through one of these calls. */
export class LeaderDelegationLedger {
	private readonly runtime: () => LeaderLedgerRuntime;
	private readonly now: () => number;

	constructor(runtime: () => LeaderLedgerRuntime, now: () => number) {
		this.runtime = runtime;
		this.now = now;
	}

	list(): DelegationRecord[] {
		return readDelegations(this.runtime().getSnapshot());
	}

	get(objectiveId: string): DelegationRecord | undefined {
		return this.list().find((record) => record.objectiveId === objectiveId);
	}

	/** A new delegation id; the charter's hop needs it before the record exists. */
	newObjectiveId(): string {
		return `${DELEGATION_OBJECTIVE_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
	}

	open(objectiveId: string, charter: LeaderCharter): DelegationRecord {
		const runtime = this.runtime();
		runtime.createObjective({
			objectiveId,
			title: goalTitle(charter.lead.goal),
			description: boundedText(charter.lead.goal, MAX_ORCHESTRATION_DESCRIPTION_LENGTH),
			constraints: charter.lead.constraints,
		});
		runtime.recordObjectiveEvidence(objectiveId, {
			evidenceId: CHARTER_EVIDENCE,
			kind: "observation",
			summary: `Delegated to ${charter.leader}.`,
			artifactIds: [],
			trusted: true,
			createdAt: charter.createdAt,
			metadata: toJson(charter),
		});
		return this.require(objectiveId);
	}

	/** Written before the brief is sent: a leader turn that starts after this time works for this delegation. */
	markDispatched(objectiveId: string): string {
		const dispatchedAt = new Date(this.now()).toISOString();
		this.runtime().recordObjectiveEvidence(objectiveId, {
			evidenceId: DISPATCH_EVIDENCE,
			kind: "observation",
			summary: "The brief was sent to the leader.",
			artifactIds: [],
			trusted: true,
			createdAt: dispatchedAt,
			// `filing` marks a delegation whose turns are filed under its objective; an earlier build's dispatch has none.
			metadata: { dispatchedAt, filing: DISPATCH_FILING_BY_OBJECTIVE },
		});
		return dispatchedAt;
	}

	recordUpdate(objectiveId: string, text: string): void {
		const record = this.require(objectiveId);
		if (record.updates.length >= MAX_DELEGATION_UPDATES)
			throw new Error(`This goal already has ${MAX_DELEGATION_UPDATES} updates; cancel it and lead a new one.`);
		const bounded = boundedText(text.trim(), MAX_DELEGATION_UPDATE_CHARS);
		this.runtime().recordObjectiveEvidence(objectiveId, {
			evidenceId: `${UPDATE_EVIDENCE_PREFIX}${record.updates.length + 1}`,
			kind: "observation",
			summary: "The orchestrator updated the goal.",
			artifactIds: [],
			trusted: true,
			createdAt: new Date(this.now()).toISOString(),
			metadata: { text: bounded },
		});
	}

	pause(objectiveId: string): void {
		this.runtime().pauseObjective(objectiveId, "human");
	}

	resume(objectiveId: string): void {
		this.runtime().resumeObjective(objectiveId);
	}

	/**
	 * Written once the nested delegation's Outcome reached its parent leader: the restart reads it instead of sending again.
	 * A second call is a no-op.
	 */
	recordChildOutcomeDelivered(objectiveId: string): void {
		const runtime = this.runtime();
		const recorded = runtime
			.getSnapshot()
			.objectives[objectiveId]?.evidence.some((entry) => entry.evidenceId === DELIVERED_TO_PARENT_EVIDENCE);
		if (recorded) return;
		runtime.recordObjectiveEvidence(objectiveId, {
			evidenceId: DELIVERED_TO_PARENT_EVIDENCE,
			kind: "observation",
			summary: "The outcome was delivered to the parent leader.",
			artifactIds: [],
			trusted: true,
			createdAt: new Date(this.now()).toISOString(),
			metadata: { delivered: true },
		});
	}

	/**
	 * Records the final Outcome once, then settles the objective. A delegation has one Outcome: a second close keeps the
	 * first and only finishes what a crash between the two steps left.
	 */
	close(objectiveId: string, outcome: Outcome, closeReason: DelegationCloseReason): DelegationRecord {
		const runtime = this.runtime();
		const recorded = runtime
			.getSnapshot()
			.objectives[objectiveId]?.evidence.some((entry) => entry.evidenceId === OUTCOME_EVIDENCE);
		if (!recorded)
			runtime.recordObjectiveEvidence(objectiveId, {
				evidenceId: OUTCOME_EVIDENCE,
				kind: "observation",
				summary: `The delegation ended: ${outcome.status}.`,
				artifactIds: [],
				trusted: true,
				createdAt: outcome.recordedAt,
				metadata: toJson({ outcome, closeReason }),
			});
		return this.settle(objectiveId);
	}

	/** The objective follows the recorded Outcome: completed when the goal was done or partly done, cancelled otherwise. */
	settle(objectiveId: string): DelegationRecord {
		const runtime = this.runtime();
		const record = this.require(objectiveId);
		if (record.objectiveStatus === "active" || record.objectiveStatus === "paused") {
			const done = record.outcome?.status === "succeeded" || record.outcome?.status === "partial";
			if (done) runtime.completeObjective(objectiveId);
			else runtime.cancelObjective(objectiveId);
		}
		return this.require(objectiveId);
	}

	private require(objectiveId: string): DelegationRecord {
		const record = this.get(objectiveId);
		if (!record) throw new Error(`Delegation ${objectiveId} is not readable.`);
		return record;
	}
}
