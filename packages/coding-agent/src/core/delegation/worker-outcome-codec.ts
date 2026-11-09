import { createHash } from "node:crypto";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "../orchestration/contracts.ts";
import { exactRecord, record } from "../orchestration/task-runtime-projection.ts";
import {
	DurableTaskRuntimeError,
	MAX_TASK_ESCALATIONS,
	type TaskEscalationRecord,
} from "../orchestration/task-runtime-state.ts";
import {
	ABANDON_REASONS,
	BLOCKER_ATTRIBUTIONS,
	BLOCKER_CODES,
	COVERAGE_SOURCES,
	NEXT_ACTION_KINDS,
	type NextAction,
	OUTCOME_ARTIFACT_KINDS,
	OUTCOME_ASSURANCES,
	OUTCOME_LIMITS,
	OUTCOME_SCOPES,
	OUTCOME_STATUSES,
	OUTCOME_VERSION,
	type Outcome,
	type OutcomeAttempt,
	type OutcomeFromNewerBuild,
	type RequirementCoverage,
	type StoredOutcome,
	UNCOVERED_REASONS,
} from "./worker-outcome-contract.ts";

/** `outcome-${taskId}-${generation}`, with the task id digested when the plain form would exceed the identifier bound. */
export function taskOutcomeId(taskId: string, generation: number): string {
	const plain = `outcome-${taskId}-${generation}`;
	if (plain.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH) return plain;
	return `outcome-${createHash("sha256").update(taskId).digest("hex").slice(0, 32)}-${generation}`;
}

/**
 * The one decoder of a stored outcome, shared by the `task.outcome_recorded` reducer and the projection snapshot codec.
 * Version 1 is validated field by field. A record from a newer build decodes to its identity only, so an older reader
 * replays the journal and recomputes the outcome instead of refusing or misreading a shape it does not know.
 */
export function storedOutcomeFromValue(value: unknown, label: string): StoredOutcome {
	const input = record(value, label);
	const version = input.v;
	if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
		throw new DurableTaskRuntimeError(`${label}.v is invalid.`);
	}
	if (version > OUTCOME_VERSION) return newerBuildOutcome(input, version);
	return outcomeFromRecord(input, label);
}

function newerBuildOutcome(input: Record<string, unknown>, version: number): OutcomeFromNewerBuild {
	return {
		v: version,
		outcomeId:
			typeof input.outcomeId === "string" &&
			input.outcomeId.length > 0 &&
			input.outcomeId.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH
				? input.outcomeId
				: "outcome-unknown",
		generation:
			typeof input.generation === "number" && Number.isSafeInteger(input.generation) && input.generation > 0
				? input.generation
				: 0,
		recordedAt:
			typeof input.recordedAt === "string" && input.recordedAt.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH
				? input.recordedAt
				: "",
		unsupported: true,
	};
}

const OUTCOME_FIELDS = [
	"v",
	"outcomeId",
	"scope",
	"nodeId",
	"taskId",
	"objectiveId",
	"generation",
	"status",
	"blocker",
	"attribution",
	"sourceCodes",
	"coverage",
	"assurance",
	"artifacts",
	"changedFiles",
	"cost",
	"durationMs",
	"attempts",
	"nextAction",
	"ladder",
	"children",
	"digestRef",
	"recordedAt",
];

function outcomeFromRecord(input: Record<string, unknown>, label: string): Outcome {
	exactRecord(input, label, OUTCOME_FIELDS);
	const status = member(input.status, OUTCOME_STATUSES, `${label}.status`);
	const blocker = member(input.blocker, BLOCKER_CODES, `${label}.blocker`);
	if ((status === "succeeded") !== (blocker === "none")) {
		throw new DurableTaskRuntimeError(`${label}.blocker must be none exactly when the outcome succeeded.`);
	}
	const cost = exactRecord(input.cost, `${label}.cost`, ["usd", "metered", "inputTokens", "outputTokens"]);
	const ladder = exactRecord(input.ladder, `${label}.ladder`, ["rung", "exit"]);
	const outcome: Outcome = {
		v: OUTCOME_VERSION,
		outcomeId: identifier(input.outcomeId, `${label}.outcomeId`),
		scope: member(input.scope, OUTCOME_SCOPES, `${label}.scope`),
		nodeId: identifier(input.nodeId, `${label}.nodeId`),
		...(input.taskId === undefined ? {} : { taskId: identifier(input.taskId, `${label}.taskId`) }),
		objectiveId: identifier(input.objectiveId, `${label}.objectiveId`),
		generation: count(input.generation, `${label}.generation`, 1),
		status,
		blocker,
		attribution: member(input.attribution, BLOCKER_ATTRIBUTIONS, `${label}.attribution`),
		sourceCodes: list(input.sourceCodes, OUTCOME_LIMITS.maxSourceCodes, `${label}.sourceCodes`, (entry, at) =>
			bounded(entry, OUTCOME_LIMITS.maxStringChars, at),
		),
		coverage: coverageFromValue(input.coverage, `${label}.coverage`),
		assurance: member(input.assurance, OUTCOME_ASSURANCES, `${label}.assurance`),
		artifacts: list(input.artifacts, OUTCOME_LIMITS.maxArtifacts, `${label}.artifacts`, (entry, at) => {
			const artifact = exactRecord(entry, at, ["kind", "ref"]);
			return {
				kind: member(artifact.kind, OUTCOME_ARTIFACT_KINDS, `${at}.kind`),
				ref: bounded(artifact.ref, OUTCOME_LIMITS.maxRefChars, `${at}.ref`),
			};
		}),
		changedFiles: list(input.changedFiles, OUTCOME_LIMITS.maxChangedFiles, `${label}.changedFiles`, (entry, at) =>
			bounded(entry, OUTCOME_LIMITS.maxRefChars, at),
		),
		cost: {
			usd: finiteAtLeastZero(cost.usd, `${label}.cost.usd`),
			metered: flag(cost.metered, `${label}.cost.metered`),
			inputTokens: count(cost.inputTokens, `${label}.cost.inputTokens`, 0),
			outputTokens: count(cost.outputTokens, `${label}.cost.outputTokens`, 0),
		},
		durationMs: count(input.durationMs, `${label}.durationMs`, 0),
		attempts: list(input.attempts, OUTCOME_LIMITS.maxAttempts, `${label}.attempts`, attemptFromValue),
		nextAction: nextActionFromValue(input.nextAction, `${label}.nextAction`),
		ladder: {
			rung: count(ladder.rung, `${label}.ladder.rung`, 0),
			exit: bounded(ladder.exit, OUTCOME_LIMITS.maxStringChars, `${label}.ladder.exit`),
		},
		...(input.children === undefined
			? {}
			: { children: list(input.children, OUTCOME_LIMITS.maxChildren, `${label}.children`, identifier) }),
		...(input.digestRef === undefined
			? {}
			: { digestRef: bounded(input.digestRef, OUTCOME_LIMITS.maxRefChars, `${label}.digestRef`) }),
		recordedAt: identifier(input.recordedAt, `${label}.recordedAt`),
	};
	return outcome;
}

function coverageFromValue(value: unknown, label: string): RequirementCoverage {
	const coverage = exactRecord(value, label, ["required", "covered", "uncovered"]);
	return {
		required: list(coverage.required, OUTCOME_LIMITS.maxRequirementIds, `${label}.required`, identifier),
		covered: list(coverage.covered, OUTCOME_LIMITS.maxRequirementIds, `${label}.covered`, (entry, at) => {
			const item = exactRecord(entry, at, ["id", "by"]);
			return { id: identifier(item.id, `${at}.id`), by: member(item.by, COVERAGE_SOURCES, `${at}.by`) };
		}),
		uncovered: list(coverage.uncovered, OUTCOME_LIMITS.maxRequirementIds, `${label}.uncovered`, (entry, at) => {
			const item = exactRecord(entry, at, ["id", "reason"]);
			return { id: identifier(item.id, `${at}.id`), reason: member(item.reason, UNCOVERED_REASONS, `${at}.reason`) };
		}),
	};
}

const ATTEMPT_FIELDS = [
	"attemptId",
	"resultId",
	"modelRef",
	"accountKey",
	"thinking",
	"rung",
	"laneStatus",
	"startedAt",
	"endedAt",
	"attestedBy",
];

function attemptFromValue(value: unknown, label: string): OutcomeAttempt {
	const attempt = exactRecord(value, label, ATTEMPT_FIELDS);
	const optional = (field: "resultId" | "accountKey" | "endedAt" | "attestedBy") =>
		attempt[field] === undefined ? {} : { [field]: identifier(attempt[field], `${label}.${field}`) };
	return {
		attemptId: identifier(attempt.attemptId, `${label}.attemptId`),
		...optional("resultId"),
		modelRef: identifier(attempt.modelRef, `${label}.modelRef`),
		...optional("accountKey"),
		thinking: identifier(attempt.thinking, `${label}.thinking`),
		rung: count(attempt.rung, `${label}.rung`, 0),
		laneStatus: identifier(attempt.laneStatus, `${label}.laneStatus`),
		startedAt: identifier(attempt.startedAt, `${label}.startedAt`),
		...optional("endedAt"),
		...optional("attestedBy"),
	};
}

function nextActionFromValue(value: unknown, label: string): NextAction {
	const action = record(value, label);
	const kind = member(action.kind, NEXT_ACTION_KINDS, `${label}.kind`);
	const ids = (): readonly string[] =>
		list(action.requirementIds, OUTCOME_LIMITS.maxRequirementIds, `${label}.requirementIds`, identifier);
	const text = (field: string): string => bounded(action[field], OUTCOME_LIMITS.maxStringChars, `${label}.${field}`);
	switch (kind) {
		case "accept":
		case "verify_in_lane":
			exactRecord(action, label, ["kind"]);
			return { kind };
		case "verify_independently":
		case "host_check":
			exactRecord(action, label, ["kind", "requirementIds"]);
			return { kind, requirementIds: ids() };
		case "rerun_uncovered": {
			exactRecord(action, label, ["kind", "requirementIds", "rung", "modelRef", "thinking"]);
			const rung = action.rung;
			if (rung !== 1 && rung !== 2) throw new DurableTaskRuntimeError(`${label}.rung is invalid.`);
			return {
				kind,
				requirementIds: ids(),
				rung,
				modelRef: identifier(action.modelRef, `${label}.modelRef`),
				thinking: identifier(action.thinking, `${label}.thinking`),
			};
		}
		case "retry_after":
			exactRecord(action, label, ["kind", "notBefore"]);
			return { kind, notBefore: identifier(action.notBefore, `${label}.notBefore`) };
		case "wait_capacity":
			exactRecord(action, label, ["kind", "reason"]);
			return { kind, reason: identifier(action.reason, `${label}.reason`) };
		case "replace":
			exactRecord(action, label, ["kind", "excludePlacement"]);
			return { kind, excludePlacement: identifier(action.excludePlacement, `${label}.excludePlacement`) };
		case "fix_request":
			exactRecord(action, label, ["kind", "remedy"]);
			return { kind, remedy: text("remedy") };
		case "ask_owner":
			exactRecord(action, label, ["kind", "question", "signature"]);
			return { kind, question: text("question"), signature: identifier(action.signature, `${label}.signature`) };
		case "ask_root":
			exactRecord(action, label, ["kind", "question"]);
			return { kind, question: text("question") };
		case "abandon":
			exactRecord(action, label, ["kind", "reason"]);
			return { kind, reason: member(action.reason, ABANDON_REASONS, `${label}.reason`) };
	}
}

const ESCALATION_FIELDS = [
	"outcomeId",
	"rung",
	"signature",
	"taskId",
	"attemptId",
	"placement",
	"modelRef",
	"thinking",
	"nodeId",
	"supersedesTaskId",
	"scheduledAt",
] as const;

/** One escalation record, shared by the `task.escalation_scheduled` reducer and the projection snapshot codec. */
export function taskEscalationRecordFromValue(value: unknown, label: string): TaskEscalationRecord {
	const input = exactRecord(value, label, ESCALATION_FIELDS);
	const rung = input.rung;
	if (rung !== 1 && rung !== 2) throw new DurableTaskRuntimeError(`${label}.rung is invalid.`);
	const optional = (field: "nodeId" | "supersedesTaskId") =>
		input[field] === undefined ? {} : { [field]: identifier(input[field], `${label}.${field}`) };
	return {
		outcomeId: identifier(input.outcomeId, `${label}.outcomeId`),
		rung,
		signature: identifier(input.signature, `${label}.signature`),
		taskId: identifier(input.taskId, `${label}.taskId`),
		attemptId: identifier(input.attemptId, `${label}.attemptId`),
		placement: identifier(input.placement, `${label}.placement`),
		modelRef: identifier(input.modelRef, `${label}.modelRef`),
		thinking: identifier(input.thinking, `${label}.thinking`),
		...optional("nodeId"),
		...optional("supersedesTaskId"),
		scheduledAt: identifier(input.scheduledAt, `${label}.scheduledAt`),
	};
}

export function taskEscalationsFromValue(value: unknown, label: string): readonly TaskEscalationRecord[] {
	return list(value, MAX_TASK_ESCALATIONS, label, taskEscalationRecordFromValue);
}

function member<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	const found = allowed.find((candidate) => candidate === value);
	if (found === undefined) throw new DurableTaskRuntimeError(`${label} is invalid.`);
	return found;
}

function bounded(value: unknown, maxChars: number, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
		throw new DurableTaskRuntimeError(`${label} is missing or exceeds its durable bound.`);
	}
	return value;
}

function identifier(value: unknown, label: string): string {
	return bounded(value, MAX_ORCHESTRATION_IDENTIFIER_LENGTH, label);
}

function count(value: unknown, label: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new DurableTaskRuntimeError(`${label} is invalid.`);
	}
	return value;
}

function finiteAtLeastZero(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new DurableTaskRuntimeError(`${label} is invalid.`);
	}
	return value;
}

function flag(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new DurableTaskRuntimeError(`${label} is invalid.`);
	return value;
}

function list<T>(
	value: unknown,
	limit: number,
	label: string,
	decode: (entry: unknown, label: string) => T,
): readonly T[] {
	if (!Array.isArray(value) || value.length > limit) {
		throw new DurableTaskRuntimeError(`${label} must be a list of at most ${limit} entries.`);
	}
	return value.map((entry, index) => decode(entry, `${label}[${index}]`));
}
