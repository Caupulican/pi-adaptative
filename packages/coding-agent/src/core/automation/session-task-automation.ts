import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { Value } from "typebox/value";
import {
	appendSessionSnapshot,
	decodeSessionSnapshotPayload,
	type SessionSnapshotCodec,
	type SessionSnapshotPayload,
} from "../session-snapshot.ts";
import {
	MAX_OUTPUT_EXCERPT_BYTES,
	TASK_AUTOMATION_LIFECYCLE_STATES,
	type TaskAutomationDefinition,
	TaskAutomationDefinitionSchema,
	type TaskAutomationExecutionResult,
	type TaskAutomationLifecycleState,
	type TaskAutomationOperationContract,
	type TaskAutomationState,
	TaskAutomationStateSchema,
	type TaskAutomationStoragePort,
	validateTaskAutomationContract,
} from "./contracts.ts";

export const TASK_AUTOMATION_STATE_CUSTOM_TYPE = "task_automation_state";

export type { TaskAutomationState };

export type TaskAutomationStateSnapshotPayload = SessionSnapshotPayload<"state", TaskAutomationState>;

export function isTaskAutomationLifecycleState(value: unknown): value is TaskAutomationLifecycleState {
	return typeof value === "string" && (TASK_AUTOMATION_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isTaskAutomationDefinition(value: unknown): value is TaskAutomationDefinition {
	if (!Value.Check(TaskAutomationDefinitionSchema, value)) return false;
	if (!validateTaskAutomationContract(value.contract).valid) return false;

	// Ready state MUST have valid evidence
	if (value.state === "ready" && !value.evidence) {
		return false;
	}

	if (value.evidence !== undefined) {
		if (typeof value.evidence.workspaceCwd !== "string" || value.evidence.workspaceCwd.trim().length === 0) {
			return false;
		}
		if (value.workspaceCwd && value.evidence.workspaceCwd !== value.workspaceCwd) {
			return false;
		}
		if (!/^[a-f0-9]{64}$/i.test(value.evidence.scriptHash)) {
			return false;
		}
		if (Buffer.byteLength(value.evidence.verifierStdout, "utf8") > MAX_OUTPUT_EXCERPT_BYTES) return false;
		if (Buffer.byteLength(value.evidence.verifierStderr, "utf8") > MAX_OUTPUT_EXCERPT_BYTES) return false;

		// Evidence must be consistent with declared negative fixtures
		const contractNeg = (value.contract as TaskAutomationOperationContract).verifier.negativeControls;
		if (value.evidence.negativeControls.length !== contractNeg.length) return false;

		for (let i = 0; i < contractNeg.length; i++) {
			const res = value.evidence.negativeControls[i];
			const fixture = contractNeg[i];
			if (res.description !== fixture.description) return false;
			if (res.args.length !== fixture.args.length) return false;
			if (!res.args.every((a, idx) => a === fixture.args[idx])) return false;
			if (res.passed !== true) return false;
			if (res.exitCode === null || res.exitCode === 0) return false;
			if (fixture.expectedExitCode !== undefined && res.exitCode !== fixture.expectedExitCode) return false;
			if (res.error && Buffer.byteLength(res.error, "utf8") > MAX_OUTPUT_EXCERPT_BYTES) return false;
		}
	}

	if (value.lastExecution !== undefined) {
		if (value.lastExecution.outcome === "succeeded") {
			if (value.lastExecution.exitCode !== 0) return false;
			if (
				typeof value.lastExecution.completedAt !== "string" ||
				value.lastExecution.completedAt.trim().length === 0
			) {
				return false;
			}
		}
		if (Buffer.byteLength(value.lastExecution.stdout, "utf8") > MAX_OUTPUT_EXCERPT_BYTES) return false;
		if (Buffer.byteLength(value.lastExecution.stderr, "utf8") > MAX_OUTPUT_EXCERPT_BYTES) return false;
		if (
			value.lastExecution.error &&
			Buffer.byteLength(value.lastExecution.error, "utf8") > MAX_OUTPUT_EXCERPT_BYTES
		) {
			return false;
		}
	}

	return true;
}

export function isTaskAutomationState(value: unknown): value is TaskAutomationState {
	if (!Value.Check(TaskAutomationStateSchema, value)) return false;

	// Enforce unique names
	const names = new Set<string>();
	for (const a of value.automations) {
		const lower = a.name.trim().toLowerCase();
		if (names.has(lower)) return false;
		names.add(lower);
	}

	return value.automations.every(isTaskAutomationDefinition);
}

/**
 * Normalizes an automation snapshot on restore/decode:
 * Any in-flight execution (`executing`) or validation (`validating`) is marked `failed` (interrupted),
 * guaranteeing that crash recovery or session reload never blindly replays side effects.
 */
export function recoverAutomationInFlight(
	automation: TaskAutomationDefinition,
	now = new Date().toISOString(),
): TaskAutomationDefinition {
	if (automation.state !== "executing" && automation.state !== "validating") {
		return automation;
	}
	const isExecuting = automation.state === "executing";
	const recoveryExecution: TaskAutomationExecutionResult = {
		runId: automation.lastExecution?.runId ?? "interrupted",
		exitCode: null,
		stdout: automation.lastExecution?.stdout ?? "",
		stderr: isExecuting
			? "Interrupted by session restore or restart; outcome unknown. Side effects are not replayed automatically."
			: "Interrupted during script validation by session restore or restart.",
		durationMs: automation.lastExecution?.durationMs ?? 0,
		startedAt: automation.lastExecution?.startedAt ?? automation.updatedAt,
		completedAt: now,
		outcome: "failed",
		error: "interrupted_by_session_restore",
	};
	return {
		...automation,
		state: "failed",
		evidence: undefined,
		activeToken: undefined,
		lastExecution: isExecuting ? recoveryExecution : automation.lastExecution,
		updatedAt: now,
	};
}

/** Pure detached deep-clone using structuredClone. */
export function cloneTaskAutomationDefinition(a: TaskAutomationDefinition): TaskAutomationDefinition {
	return structuredClone(a);
}

/** Pure detached deep-clone using structuredClone. */
export function cloneTaskAutomationState(state: TaskAutomationState): TaskAutomationState {
	return structuredClone(state);
}

const TASK_AUTOMATION_STATE_SNAPSHOT_CODEC: SessionSnapshotCodec<TaskAutomationState, "state"> = {
	customType: TASK_AUTOMATION_STATE_CUSTOM_TYPE,
	valueKey: "state",
	isValue: isTaskAutomationState,
	clone: cloneTaskAutomationState,
};

export function appendTaskAutomationStateSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	state: TaskAutomationState,
): string {
	return appendSessionSnapshot(sessionManager, TASK_AUTOMATION_STATE_SNAPSHOT_CODEC, state);
}

export function decodeTaskAutomationStateSnapshotPayload(data: unknown): TaskAutomationState | undefined {
	const decoded = decodeSessionSnapshotPayload(data, TASK_AUTOMATION_STATE_SNAPSHOT_CODEC);
	return decoded
		? {
				...decoded,
				automations: decoded.automations.map((a) => recoverAutomationInFlight(a)),
			}
		: undefined;
}

/**
 * Resolves the newest snapshot on the active branch.
 * If the latest snapshot entry is malformed, it invalidates immediately (returns undefined);
 * it does NOT fall back to older entries.
 */
export function getLatestTaskAutomationStateSnapshot(
	sessionManager: Pick<SessionManager, "getLatestCustomEntryOnBranch">,
): TaskAutomationState | undefined {
	const entry = sessionManager.getLatestCustomEntryOnBranch(TASK_AUTOMATION_STATE_CUSTOM_TYPE);
	if (!entry) return undefined;
	return decodeTaskAutomationStateSnapshotPayload(entry.data);
}

export type LiveSessionManagerResolver =
	| Pick<SessionManager, "appendCustomEntry" | "getLatestCustomEntryOnBranch">
	| (() => Pick<SessionManager, "appendCustomEntry" | "getLatestCustomEntryOnBranch">);

/**
 * Creates storage port resolving a live SessionManager or getter on each operation.
 */
export function createSessionTaskAutomationStoragePort(
	sessionManagerOrGetter: LiveSessionManagerResolver,
): TaskAutomationStoragePort {
	const resolveManager = () => {
		const manager = typeof sessionManagerOrGetter === "function" ? sessionManagerOrGetter() : sessionManagerOrGetter;
		if (!manager) {
			throw new Error("Live SessionManager resolver returned undefined or null");
		}
		return manager;
	};

	return {
		appendSnapshot(state: TaskAutomationState): string {
			return appendTaskAutomationStateSnapshot(resolveManager(), state);
		},
		getLatestSnapshot(): TaskAutomationState | undefined {
			return getLatestTaskAutomationStateSnapshot(resolveManager());
		},
	};
}
