import { getToolExecutionUnchangedRetryLimit } from "@caupulican/pi-ai/tool-repair-registry";
import {
	forEachPairedToolResult,
	getToolExecutionKey,
	getToolFailureRecordExecutionKey,
	isClosedOperationFailureCode,
	isPromptScopedFailureCode,
	readVisibleToolFailureCode,
	restoreToolFailureRecord,
	type ToolFailureMemoryRecord,
} from "./tool-failure-memory.ts";
import type {
	AgentMessage,
	AgentTool,
	AgentToolFailureRecoveryAuthority,
	AgentToolFailureRecoveryTarget,
	AgentToolResult,
} from "./types.ts";
import { isAgentToolFailureRecoveryAuthority } from "./types.ts";

const MAX_BLOCKED_REPLAYS_PER_FAILURE = 2;
const BASE_FAILURE_EXECUTIONS_PER_OPERATION = 1;
const MAX_RECOVERY_PROBES_PER_OPERATION = 1;
const MAX_REJECTIONS_PER_OPERATION = 4;
export const TOOL_FAILURE_RECOVERY_ACCOUNTING_WAVE_SIZE = 4;
const MAX_FAILURES_PER_FAMILY = TOOL_FAILURE_RECOVERY_ACCOUNTING_WAVE_SIZE;
const MAX_FAILURES_PER_RUN = 12;
const MAX_RECOVERY_STATES = 64;
const MAX_RECOVERY_TARGETS = 8;
const MAX_RECOVERY_ACTIONS = 8;
const MAX_TARGET_KIND_CHARS = 64;
const MAX_TARGET_SCOPE_CHARS = 32_768;
const MAX_ACTION_INSTRUCTION_CHARS = 160;
const MAX_RECOVERY_GUIDANCE_CHARS = 320;
const TARGET_KIND_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

export interface ToolFailureExecutionReservation {
	executionKey: string;
}

export interface ToolFailureRecoveryPlan {
	targets: readonly AgentToolFailureRecoveryTarget[];
	guidance: string;
}

export type ToolFailureRecoveryGateEffect =
	| {
			kind: "failure";
			record: ToolFailureMemoryRecord;
			args: unknown;
			targets?: readonly AgentToolFailureRecoveryTarget[];
			reservation?: ToolFailureExecutionReservation;
	  }
	| { kind: "success"; tool: AgentTool<any>; args: unknown; evidenceResult: AgentToolResult<any> };

export type ToolFailureRecoveryAdmission =
	| { kind: "allowed"; reservation?: ToolFailureExecutionReservation }
	| { kind: "blocked"; record: ToolFailureMemoryRecord; exhausted: false; diagnostic?: string }
	| {
			kind: "blocked";
			record: ToolFailureMemoryRecord;
			exhausted: true;
			scope: "operation" | "run";
			diagnostic?: string;
	  };

interface FailureRecoveryState {
	record: ToolFailureMemoryRecord;
	recoveryTargets: readonly AgentToolFailureRecoveryTarget[];
	reservedExecutions: number;
	failures: number;
	failureFamilyCounts: Map<string, number>;
	recoveryProbes: number;
	blockedReplays: number;
	recoveryAvailable: boolean;
	operationCircuitOpen: boolean;
}

interface AvailableRecoveryAction {
	toolName: string;
	kind: "correct" | "repair";
	instruction: string;
}

interface ParsedRecoveryAction {
	kind: "correct" | "repair";
	authority: AgentToolFailureRecoveryAuthority;
	targetKind: string;
	instruction: string;
	getEvidence?: (params: unknown, result: AgentToolResult<unknown>) => unknown;
}

export interface ToolFailureRecoveryHalt {
	record: ToolFailureMemoryRecord;
	diagnostic: string;
}

/**
 * Owns execution admission and bounded unresolved-failure budgets.
 *
 * Recovery authority is exact and tool-owned. A failed tool declares opaque backend-specific targets;
 * a loaded recovery tool may teach actions only for the same authority and target kind. Only raw
 * successful repair evidence with byte-exact scope can reopen one probe. Argument text and hooks have
 * no recovery authority.
 *
 * Run-level halt and family/run counters stay on the current run. Per-operation execution budget and
 * circuit are reconstructed from the transcript when a new run starts with an empty gate, so an
 * already-exhausted identical operation is not re-executed after a user turn or session resume.
 */
export class ToolFailureRecoveryGate {
	private readonly statesByExecutionKey = new Map<string, FailureRecoveryState>();
	private readonly failuresByFamily = new Map<string, number>();
	private totalFailures = 0;
	private halted: ToolFailureRecoveryHalt | undefined;

	isEmpty(): boolean {
		return this.statesByExecutionKey.size === 0 && this.halted === undefined && this.totalFailures === 0;
	}

	restoreFromMessages(messages: readonly AgentMessage[]): void {
		if (!this.isEmpty()) return;
		forEachPairedToolResult(messages, ({ tool, args, executionKey, result }) => {
			if (!result.isError) {
				const existing = this.statesByExecutionKey.get(executionKey);
				if (existing) this.clearResolvedState(executionKey, existing);
				return;
			}
			const restored = restoreToolFailureRecord(result, tool, args);
			const visibleCode = readVisibleToolFailureCode(result);
			if (isPromptScopedFailureCode(visibleCode) || isPromptScopedFailureCode(restored.failureCode)) {
				return;
			}
			const state = this.ensureRestoredState(executionKey, restored);
			if (!state) return false;
			if (isClosedOperationFailureCode(visibleCode)) {
				state.operationCircuitOpen = true;
				state.blockedReplays = MAX_BLOCKED_REPLAYS_PER_FAILURE;
				state.recoveryAvailable = false;
				return;
			}
			if (visibleCode === "repeated_failed_operation") {
				state.blockedReplays++;
				return;
			}
			state.reservedExecutions++;
			state.failures++;
		});
	}

	planFailure(
		failedTool: AgentTool<any>,
		args: unknown,
		failureCode: string,
		availableTools: readonly AgentTool<any>[],
		reservation: ToolFailureExecutionReservation | undefined,
	): ToolFailureRecoveryPlan {
		const targets = readFailureTargets(failedTool, args, failureCode);
		const actions = readAvailableRecoveryActions(availableTools, targets);
		const unchangedRetryRemaining = this.hasUnchangedRetryRemaining(failedTool, args, failureCode, reservation);
		return {
			targets,
			guidance: formatRecoveryGuidance(failureCode, actions, unchangedRetryRemaining),
		};
	}

	admit(
		tool: AgentTool<any>,
		args: unknown,
		record: ToolFailureMemoryRecord | undefined,
	): ToolFailureRecoveryAdmission {
		const stateCapacityHalt = this.halted;
		if (stateCapacityHalt) {
			return {
				kind: "blocked",
				record: stateCapacityHalt.record,
				exhausted: true,
				scope: "run",
				diagnostic: stateCapacityHalt.diagnostic,
			};
		}

		const executionKey = getToolExecutionKey(tool.name, args);
		let state = this.statesByExecutionKey.get(executionKey);
		if (!state && record && getToolFailureRecordExecutionKey(record) === executionKey) {
			state = this.getOrCreateState(executionKey, record, readFailureTargets(tool, args, record.failureCode));
		}
		if (this.halted) {
			return {
				kind: "blocked",
				record: this.halted.record,
				exhausted: true,
				scope: "run",
				diagnostic: this.halted.diagnostic,
			};
		}
		if (!state) return { kind: "allowed" };

		if (record) state.record = record;
		if (state.operationCircuitOpen) {
			if (state.recoveryAvailable && state.recoveryProbes < MAX_RECOVERY_PROBES_PER_OPERATION) {
				state.operationCircuitOpen = false;
				state.recoveryAvailable = false;
				state.recoveryProbes++;
				state.reservedExecutions++;
				state.blockedReplays = 0;
				return { kind: "allowed", reservation: { executionKey } };
			}
			const diagnostic = `Run recovery circuit opened after replay of an operation whose local circuit was already open for ${state.record.failureCode}.`;
			this.halted = { record: state.record, diagnostic };
			return { kind: "blocked", record: state.record, exhausted: true, scope: "run", diagnostic };
		}
		const automaticExecutionLimit =
			BASE_FAILURE_EXECUTIONS_PER_OPERATION + getToolExecutionUnchangedRetryLimit(state.record.failureCode);
		if (state.reservedExecutions < automaticExecutionLimit) {
			state.reservedExecutions++;
			state.blockedReplays = 0;
			return { kind: "allowed", reservation: { executionKey } };
		}
		if (state.recoveryAvailable && state.recoveryProbes < MAX_RECOVERY_PROBES_PER_OPERATION) {
			state.recoveryAvailable = false;
			state.recoveryProbes++;
			state.reservedExecutions++;
			state.blockedReplays = 0;
			return { kind: "allowed", reservation: { executionKey } };
		}

		state.blockedReplays++;
		if (state.blockedReplays >= MAX_BLOCKED_REPLAYS_PER_FAILURE) {
			state.operationCircuitOpen = true;
			const diagnostic = `Operation recovery circuit opened after ${state.blockedReplays} blocked replays of ${state.record.failureCode}.`;
			return { kind: "blocked", record: state.record, exhausted: true, scope: "operation", diagnostic };
		}
		return { kind: "blocked", record: state.record, exhausted: false };
	}

	apply(effect: ToolFailureRecoveryGateEffect | undefined): ToolFailureRecoveryHalt | undefined {
		if (!effect || this.halted) return undefined;
		if (effect.kind === "success") {
			this.observeSuccess(effect.tool, effect.args, effect.evidenceResult);
			return undefined;
		}
		this.observeFailure(effect.record, effect.args, effect.targets ?? [], effect.reservation);
		return this.halted;
	}

	isHalted(): boolean {
		return this.halted !== undefined;
	}

	getHalt(): ToolFailureRecoveryHalt | undefined {
		return this.halted;
	}

	private hasUnchangedRetryRemaining(
		tool: AgentTool<any>,
		args: unknown,
		failureCode: string,
		reservation: ToolFailureExecutionReservation | undefined,
	): boolean {
		const retryLimit = getToolExecutionUnchangedRetryLimit(failureCode);
		if (retryLimit === 0) return false;
		const executionKey = getToolExecutionKey(tool.name, args);
		const state = this.statesByExecutionKey.get(executionKey);
		const executionsIncludingCurrent = state
			? state.reservedExecutions + (reservation?.executionKey === executionKey ? 0 : 1)
			: 1;
		return executionsIncludingCurrent < BASE_FAILURE_EXECUTIONS_PER_OPERATION + retryLimit;
	}

	private ensureRestoredState(
		executionKey: string,
		record: ToolFailureMemoryRecord,
	): FailureRecoveryState | undefined {
		const existing = this.statesByExecutionKey.get(executionKey);
		if (existing) {
			existing.record = record;
			return existing;
		}
		if (this.statesByExecutionKey.size >= MAX_RECOVERY_STATES) return undefined;
		const state: FailureRecoveryState = {
			record,
			recoveryTargets: [],
			reservedExecutions: 0,
			failures: 0,
			failureFamilyCounts: new Map(),
			recoveryProbes: 0,
			blockedReplays: 0,
			recoveryAvailable: false,
			operationCircuitOpen: false,
		};
		this.statesByExecutionKey.set(executionKey, state);
		return state;
	}

	private getOrCreateState(
		executionKey: string,
		record: ToolFailureMemoryRecord,
		targets: readonly AgentToolFailureRecoveryTarget[],
	): FailureRecoveryState {
		const existing = this.statesByExecutionKey.get(executionKey);
		if (existing) return existing;
		const state: FailureRecoveryState = {
			record,
			recoveryTargets: targets,
			reservedExecutions: 0,
			failures: 0,
			failureFamilyCounts: new Map(),
			recoveryProbes: 0,
			blockedReplays: 0,
			recoveryAvailable: false,
			operationCircuitOpen: false,
		};
		if (this.statesByExecutionKey.size >= MAX_RECOVERY_STATES) {
			this.halted = {
				record,
				diagnostic: `Recovery circuit opened at the ${MAX_RECOVERY_STATES}-operation state bound.`,
			};
			return state;
		}
		this.statesByExecutionKey.set(executionKey, state);
		return state;
	}

	private observeFailure(
		record: ToolFailureMemoryRecord,
		args: unknown,
		targets: readonly AgentToolFailureRecoveryTarget[],
		reservation: ToolFailureExecutionReservation | undefined,
	): void {
		const executionKey = getToolExecutionKey(record.tool, args);
		const state = this.getOrCreateState(executionKey, record, targets);
		if (this.halted) return;
		state.record = record;
		state.recoveryTargets = targets;
		state.recoveryAvailable = false;
		state.blockedReplays = 0;
		if (reservation?.executionKey !== executionKey) state.reservedExecutions++;

		state.failures++;
		this.totalFailures++;
		const familyKey = `${record.tool}\0${record.failureCode}`;
		const familyFailures = (this.failuresByFamily.get(familyKey) ?? 0) + 1;
		this.failuresByFamily.set(familyKey, familyFailures);
		state.failureFamilyCounts.set(familyKey, (state.failureFamilyCounts.get(familyKey) ?? 0) + 1);

		const operationFailureLimit =
			record.state === "failed"
				? BASE_FAILURE_EXECUTIONS_PER_OPERATION +
					getToolExecutionUnchangedRetryLimit(record.failureCode) +
					MAX_RECOVERY_PROBES_PER_OPERATION
				: MAX_REJECTIONS_PER_OPERATION;
		if (state.failures >= operationFailureLimit) {
			this.halted = {
				record,
				diagnostic: `Recovery circuit opened after ${state.failures} failed outcomes for one operation.`,
			};
			return;
		}
		if (familyFailures >= MAX_FAILURES_PER_FAMILY) {
			this.halted = {
				record,
				diagnostic: `Recovery circuit opened after ${familyFailures} failures in one tool failure family.`,
			};
			return;
		}
		if (this.totalFailures >= MAX_FAILURES_PER_RUN) {
			this.halted = {
				record,
				diagnostic: `Recovery circuit opened after ${this.totalFailures} tool failures in one run.`,
			};
		}
	}

	private observeSuccess(tool: AgentTool<any>, args: unknown, result: AgentToolResult<any>): void {
		const successfulExecutionKey = getToolExecutionKey(tool.name, args);
		const evidenceTargets = readRecoveryEvidenceTargets(tool, args, result);
		for (const [executionKey, state] of this.statesByExecutionKey) {
			if (executionKey === successfulExecutionKey) {
				this.clearResolvedState(executionKey, state);
				continue;
			}
			if (
				state.recoveryProbes < MAX_RECOVERY_PROBES_PER_OPERATION &&
				hasSharedRecoveryTarget(state.recoveryTargets, evidenceTargets)
			) {
				state.recoveryAvailable = true;
				state.blockedReplays = 0;
			}
		}
	}

	private clearResolvedState(executionKey: string, state: FailureRecoveryState): void {
		this.statesByExecutionKey.delete(executionKey);
		this.totalFailures = Math.max(0, this.totalFailures - state.failures);
		for (const [familyKey, stateFailures] of state.failureFamilyCounts) {
			const remaining = (this.failuresByFamily.get(familyKey) ?? 0) - stateFailures;
			if (remaining > 0) this.failuresByFamily.set(familyKey, remaining);
			else this.failuresByFamily.delete(familyKey);
		}
	}
}

function readFailureTargets(
	tool: AgentTool<any>,
	args: unknown,
	failureCode: string,
): readonly AgentToolFailureRecoveryTarget[] {
	try {
		const contract = tool.failureRecovery;
		const getTargets = contract?.getFailureTargets;
		if (!getTargets) return [];
		const targets = Reflect.apply(getTargets, contract, [args, { failureCode }]);
		return sanitizeRecoveryTargets(targets);
	} catch {
		return [];
	}
}

function sanitizeRecoveryTargets(value: unknown): readonly AgentToolFailureRecoveryTarget[] {
	if (!Array.isArray(value)) return [];
	const targets: AgentToolFailureRecoveryTarget[] = [];
	for (const candidate of value) {
		if (targets.length >= MAX_RECOVERY_TARGETS) break;
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const { authority, kind, scope } = candidate as { authority?: unknown; kind?: unknown; scope?: unknown };
		if (!isAgentToolFailureRecoveryAuthority(authority) || !validTargetKind(kind) || !validTargetScope(scope)) {
			continue;
		}
		if (targets.some((target) => sameRecoveryTarget(target, { authority, kind, scope }))) continue;
		targets.push({ authority, kind, scope });
	}
	return targets;
}

function validTargetKind(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_TARGET_KIND_CHARS &&
		TARGET_KIND_PATTERN.test(value)
	);
}

function validTargetScope(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= MAX_TARGET_SCOPE_CHARS && !value.includes("\0")
	);
}

function readAvailableRecoveryActions(
	tools: readonly AgentTool<any>[],
	targets: readonly AgentToolFailureRecoveryTarget[],
): readonly AvailableRecoveryAction[] {
	if (targets.length === 0) return [];
	const actions: AvailableRecoveryAction[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		for (const candidate of readDeclaredRecoveryActions(tool)) {
			if (actions.length >= MAX_RECOVERY_ACTIONS) return actions;
			const action = parseRecoveryAction(candidate);
			if (
				!action ||
				!targets.some((target) => target.authority === action.authority && target.kind === action.targetKind)
			) {
				continue;
			}
			const instruction = truncate(action.instruction.trim(), MAX_ACTION_INSTRUCTION_CHARS);
			if (!instruction) continue;
			const key = `${tool.name}\0${action.kind}\0${instruction}`;
			if (seen.has(key)) continue;
			seen.add(key);
			actions.push({ toolName: tool.name, kind: action.kind, instruction });
		}
	}
	return actions;
}

function readDeclaredRecoveryActions(tool: AgentTool<any>): readonly unknown[] {
	try {
		const declared = tool.failureRecovery?.actions;
		if (!Array.isArray(declared)) return [];
		const actions: unknown[] = [];
		const count = Math.min(declared.length, MAX_RECOVERY_ACTIONS);
		for (let index = 0; index < count; index++) actions.push(declared[index]);
		return actions;
	} catch {
		return [];
	}
}

function parseRecoveryAction(value: unknown): ParsedRecoveryAction | undefined {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const candidate = value as {
			kind?: unknown;
			authority?: unknown;
			targetKind?: unknown;
			instruction?: unknown;
			getEvidence?: unknown;
		};
		if (
			!isAgentToolFailureRecoveryAuthority(candidate.authority) ||
			!validTargetKind(candidate.targetKind) ||
			typeof candidate.instruction !== "string"
		) {
			return undefined;
		}
		if (candidate.kind === "correct") {
			return {
				kind: candidate.kind,
				authority: candidate.authority,
				targetKind: candidate.targetKind,
				instruction: candidate.instruction,
			};
		}
		if (candidate.kind !== "repair" || typeof candidate.getEvidence !== "function") return undefined;
		const getEvidence = candidate.getEvidence;
		return {
			kind: candidate.kind,
			authority: candidate.authority,
			targetKind: candidate.targetKind,
			instruction: candidate.instruction,
			getEvidence: (params, result) => Reflect.apply(getEvidence, value, [params, result]),
		};
	} catch {
		return undefined;
	}
}

function readRecoveryEvidenceTargets(
	tool: AgentTool<any>,
	args: unknown,
	result: AgentToolResult<any>,
): readonly AgentToolFailureRecoveryTarget[] {
	const targets: AgentToolFailureRecoveryTarget[] = [];
	for (const candidate of readDeclaredRecoveryActions(tool)) {
		const action = parseRecoveryAction(candidate);
		if (targets.length >= MAX_RECOVERY_TARGETS || !action || action.kind !== "repair" || !action.getEvidence) {
			continue;
		}
		let scopes: unknown;
		try {
			scopes = action.getEvidence(args, result);
		} catch {
			continue;
		}
		if (!Array.isArray(scopes)) continue;
		for (const scope of scopes) {
			if (targets.length >= MAX_RECOVERY_TARGETS) break;
			if (!validTargetScope(scope)) continue;
			const target = { authority: action.authority, kind: action.targetKind, scope };
			if (!targets.some((candidate) => sameRecoveryTarget(candidate, target))) targets.push(target);
		}
	}
	return targets;
}

function formatRecoveryGuidance(
	failureCode: string,
	actions: readonly AvailableRecoveryAction[],
	unchangedRetryRemaining: boolean,
): string {
	const hasTimeoutRetryPolicy = getToolExecutionUnchangedRetryLimit(failureCode) > 0;
	const timeoutPolicy = hasTimeoutRetryPolicy
		? unchangedRetryRemaining
			? "Timeout policy allows 1 unchanged retry; if it fails, never retry unchanged."
			: "Timeout unchanged retry exhausted; never retry unchanged."
		: undefined;
	if (actions.length === 0) {
		if (timeoutPolicy) return `${timeoutPolicy} Change/narrow operation, or report blocker.`;
		return "No loaded tool declares recovery. Never retry unchanged. Use materially different operation justified by diagnostic/schema, or report blocker.";
	}
	const available = actions.map((action) => `${action.toolName} ${action.kind}: ${action.instruction}`).join(" ");
	const hasRepair = actions.some((action) => action.kind === "repair");
	const authority = hasRepair
		? "Only exact matching repair evidence grants 1 probe; else change operation."
		: "Actions require changed operation; unchanged remains blocked.";
	return truncate(
		`${timeoutPolicy ? `${timeoutPolicy} ` : ""}Loaded actions: ${available} ${authority}`,
		MAX_RECOVERY_GUIDANCE_CHARS,
	);
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars - 1)}…`;
}

function sameRecoveryTarget(left: AgentToolFailureRecoveryTarget, right: AgentToolFailureRecoveryTarget): boolean {
	return left.authority === right.authority && left.kind === right.kind && left.scope === right.scope;
}

function hasSharedRecoveryTarget(
	left: readonly AgentToolFailureRecoveryTarget[],
	right: readonly AgentToolFailureRecoveryTarget[],
): boolean {
	if (left.length > right.length) return hasSharedRecoveryTarget(right, left);
	return left.some((target) => right.some((candidate) => sameRecoveryTarget(target, candidate)));
}
