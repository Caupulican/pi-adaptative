/**
 * The durable record of delegations to leaders, kept in the root session's orchestration store: one objective per
 * delegation (`delegation-<id>`), with the charter, the dispatch, each update and the final Outcome as trusted kernel
 * evidence on it. The objective's own lifecycle (active, paused, completed, cancelled) is the delegation's. This module is
 * the only writer and reader of that record; nothing else keeps a copy.
 */

import { randomUUID } from "node:crypto";
import type { JsonObject } from "../../kernel/utils/json-types.ts";
import { MAX_ORCHESTRATION_DESCRIPTION_LENGTH, type ObjectiveStatus } from "../orchestration/contracts.ts";
import type { DurableTaskRuntime, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { boundedText } from "../util/bounded-line.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	type DelegationHop,
	LEADER_CAPABILITIES,
	type LeaderCapability,
	type LeaderEnvelope,
	type LeadRequest,
	leadRequestFrom,
} from "./leader-delegation.ts";
import { storedOutcomeFromValue } from "./worker-outcome-codec.ts";
import { isOutcomeFromNewerBuild, type Outcome } from "./worker-outcome-contract.ts";

export const DELEGATION_OBJECTIVE_PREFIX = "delegation-";
const CHARTER_EVIDENCE = "delegation-charter";
const DISPATCH_EVIDENCE = "delegation-dispatch";
const OUTCOME_EVIDENCE = "delegation-outcome";
const UPDATE_EVIDENCE_PREFIX = "delegation-update-";
/** The most updates one delegation keeps; a leader needing more is better given a new goal. */
export const MAX_DELEGATION_UPDATES = 32;
export const MAX_DELEGATION_UPDATE_CHARS = 2000;

/** Why a delegation closed; the Outcome says how it ended, this says who or what ended it. */
export const DELEGATION_CLOSE_REASONS = ["settled", "cancelled", "deadline", "budget", "leader_unavailable"] as const;
export type DelegationCloseReason = (typeof DELEGATION_CLOSE_REASONS)[number];

export interface LeaderCharter {
	readonly v: 1;
	readonly leader: string;
	/** `owner`: a standing leader the owner made; `root`: a goal leader the orchestrator appointed for this goal. */
	readonly appointedBy: "owner" | "root";
	readonly lead: LeadRequest;
	readonly envelope: LeaderEnvelope;
	readonly clipped: readonly string[];
	readonly createdAt: string;
}

export type DelegationState = "queued" | "running" | "paused" | "closed";

export interface DelegationRecord {
	readonly objectiveId: string;
	readonly title: string;
	readonly objectiveStatus: ObjectiveStatus;
	readonly state: DelegationState;
	readonly charter: LeaderCharter;
	readonly dispatchedAt?: string;
	readonly updates: readonly string[];
	readonly outcome?: Outcome;
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
	return {
		v: 1,
		leader: value.leader,
		appointedBy: value.appointedBy,
		lead,
		envelope,
		clipped,
		createdAt: value.createdAt,
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
			updates,
			...(outcome ? { outcome } : {}),
			...(closeReason ? { closeReason } : {}),
			...(closing ? { closedAt: closing.createdAt } : {}),
		});
	}
	return records.sort((left, right) => left.charter.createdAt.localeCompare(right.charter.createdAt));
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
			metadata: { dispatchedAt },
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
