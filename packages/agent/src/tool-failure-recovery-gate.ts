import { getToolExecutionUnchangedRetryLimit } from "@caupulican/pi-ai/tool-repair-registry";
import type { ToolResultMessage } from "@caupulican/pi-ai/types";
import {
	forEachPairedToolResult,
	getToolExecutionKey,
	getToolExecutionKeyHashParts,
	getToolFailureRecordExecutionKey,
	isClosedOperationFailureCode,
	isPromptScopedFailureCode,
	readVisibleToolFailureCode,
	restoreToolFailureRecord,
	sanitizeToolFailureEvidence,
	type ToolFailureMemoryRecord,
} from "./tool-failure-memory.ts";
import type {
	AgentMessage,
	AgentTool,
	AgentToolFailureEvidenceContext,
	AgentToolFailureRecoveryAuthority,
	AgentToolFailureRecoveryTarget,
	AgentToolResult,
} from "./types.ts";
import { isAgentToolFailureRecoveryAuthority } from "./types.ts";

const MAX_BLOCKED_REPLAYS_PER_FAILURE = 2;
const BASE_FAILURE_EXECUTIONS_PER_OPERATION = 1;
const MAX_RECOVERY_PROBES_PER_OPERATION = 1;
const MAX_REJECTIONS_PER_OPERATION = 4;
const MAX_HOT_RECOVERY_STATES = 64;
const SEEN_EXECUTION_FILTER_BYTES = 64 * 1024;
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
	evidence?: string;
}

export type ToolFailureRecoveryGateEffect =
	| {
			kind: "failure";
			tool?: AgentTool<any>;
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
	recoveryProbes: number;
	blockedReplays: number;
	recoveryAvailable: boolean;
	operationCircuitOpen: boolean;
}

type TranscriptRecoveryReduction =
	| { kind: "resolved" }
	| { kind: "ignored"; state: FailureRecoveryState | undefined }
	| { kind: "failed"; state: FailureRecoveryState };

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
 * Bounded negative lookup for exact execution identities.
 *
 * A miss proves the operation has not failed while this gate has been alive. A hit only means
 * "possibly seen" and must be verified against the transcript, so collisions can cost a scan but
 * can never deny an execution. Keeping this separate from the hot state cache lets old exact
 * circuits survive eviction without retaining one live object graph per historical operation.
 */
class SeenExecutionFilter {
	private readonly bits = new Uint8Array(SEEN_EXECUTION_FILTER_BYTES);

	add(executionKey: string): void {
		for (const hash of getToolExecutionKeyHashParts(executionKey)) this.set(hash);
	}

	mightContain(executionKey: string): boolean {
		for (const hash of getToolExecutionKeyHashParts(executionKey)) {
			if (!this.has(hash)) return false;
		}
		return true;
	}

	private set(hash: number): void {
		const bit = (hash >>> 0) % (SEEN_EXECUTION_FILTER_BYTES * 8);
		this.bits[bit >>> 3] |= 1 << (bit & 7);
	}

	private has(hash: number): boolean {
		const bit = (hash >>> 0) % (SEEN_EXECUTION_FILTER_BYTES * 8);
		return (this.bits[bit >>> 3] & (1 << (bit & 7))) !== 0;
	}
}

/**
 * Owns execution admission and bounded unresolved-failure budgets.
 *
 * Recovery authority is exact and tool-owned. A failed tool declares opaque backend-specific targets;
 * a loaded recovery tool may teach actions only for the same authority and target kind. Only raw
 * successful repair evidence with byte-exact scope can reopen one probe. Argument text and hooks have
 * no recovery authority.
 *
 * Run-level halt stays on the current run, but admission is never denied because unrelated operations
 * happened to fail. A bounded hot cache carries active per-operation state. A fixed-size negative
 * lookup sends an evicted exact replay back to the transcript for authoritative reconstruction, so
 * cache pressure cannot either stop new work or reopen an already-exhausted operation.
 */
export class ToolFailureRecoveryGate {
	private readonly statesByExecutionKey = new Map<string, FailureRecoveryState>();
	private readonly seenFailedExecutions = new SeenExecutionFilter();
	/** Exact successes not yet present in the transcript snapshot consulted by admission. */
	private readonly resolvedBeforeTranscriptCommit = new Set<string>();
	private transcriptMessages: readonly AgentMessage[] = [];
	private transcriptLength = 0;
	private transcriptTail: AgentMessage | undefined;
	private restoredFromTranscript = false;
	private halted: ToolFailureRecoveryHalt | undefined;

	isEmpty(): boolean {
		return this.statesByExecutionKey.size === 0 && this.halted === undefined;
	}

	restoreFromMessages(messages: readonly AgentMessage[]): void {
		this.trackTranscript(messages);
		if (this.restoredFromTranscript || !this.isEmpty()) return;
		this.restoredFromTranscript = true;
		forEachPairedToolResult(messages, ({ tool, args, executionKey, result }) => {
			const reduction = this.reduceTranscriptResult(this.statesByExecutionKey.get(executionKey), tool, args, result);
			if (reduction.kind === "resolved") {
				this.clearResolvedState(executionKey);
				return;
			}
			if (reduction.kind === "ignored") return;
			this.seenFailedExecutions.add(executionKey);
			this.retainHotState(executionKey, reduction.state);
		});
	}

	planFailure(
		failedTool: AgentTool<any>,
		args: unknown,
		failure: AgentToolFailureEvidenceContext,
		availableTools: readonly AgentTool<any>[],
		reservation: ToolFailureExecutionReservation | undefined,
	): ToolFailureRecoveryPlan {
		const targets = readFailureTargets(failedTool, args, failure.failureCode);
		const actions = readAvailableRecoveryActions(availableTools, targets);
		const unchangedRetryRemaining = this.hasUnchangedRetryRemaining(
			failedTool,
			args,
			failure.failureCode,
			reservation,
		);
		const evidence = readFailureEvidence(failedTool, args, failure);
		return {
			targets,
			guidance: formatRecoveryGuidance(failure.failureCode, actions, unchangedRetryRemaining),
			...(evidence ? { evidence } : {}),
		};
	}

	admit(
		tool: AgentTool<any>,
		args: unknown,
		record: ToolFailureMemoryRecord | undefined,
		messages: readonly AgentMessage[] = this.transcriptMessages,
	): ToolFailureRecoveryAdmission {
		this.trackTranscript(messages);
		const runHalt = this.halted;
		if (runHalt) {
			return {
				kind: "blocked",
				record: runHalt.record,
				exhausted: true,
				scope: "run",
				diagnostic: runHalt.diagnostic,
			};
		}

		const executionKey = getToolExecutionKey(tool.name, args);
		if (this.resolvedBeforeTranscriptCommit.has(executionKey)) return { kind: "allowed" };
		let state = this.getHotState(executionKey);
		if (!state && this.seenFailedExecutions.mightContain(executionKey)) {
			state = this.restoreOperationFromTranscript(executionKey);
		}
		if (!state && record && getToolFailureRecordExecutionKey(record) === executionKey) {
			state = this.getOrCreateState(executionKey, record, readFailureTargets(tool, args, record.failureCode));
		}
		if (!state) return { kind: "allowed" };

		if (record && getToolFailureRecordExecutionKey(record) === executionKey) state.record = record;
		if (state.operationCircuitOpen) {
			if (state.recoveryAvailable && state.recoveryProbes < MAX_RECOVERY_PROBES_PER_OPERATION) {
				state.operationCircuitOpen = false;
				state.recoveryAvailable = false;
				state.recoveryProbes++;
				state.reservedExecutions++;
				state.blockedReplays = 0;
				return { kind: "allowed", reservation: { executionKey } };
			}
			if (usesOperationLocalExhaustion(tool)) {
				const diagnostic = `Operation recovery circuit remains closed after replay of ${state.record.failureCode}.`;
				return { kind: "blocked", record: state.record, exhausted: true, scope: "operation", diagnostic };
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
		this.observeFailure(effect.tool, effect.record, effect.args, effect.targets ?? [], effect.reservation);
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

	private getOrCreateState(
		executionKey: string,
		record: ToolFailureMemoryRecord,
		targets: readonly AgentToolFailureRecoveryTarget[],
	): FailureRecoveryState {
		const existing = this.getHotState(executionKey);
		if (existing) return existing;
		const state = createFailureRecoveryState(record, targets);
		this.retainHotState(executionKey, state);
		return state;
	}

	private observeFailure(
		tool: AgentTool<any> | undefined,
		record: ToolFailureMemoryRecord,
		args: unknown,
		targets: readonly AgentToolFailureRecoveryTarget[],
		reservation: ToolFailureExecutionReservation | undefined,
	): void {
		const executionKey = getToolExecutionKey(record.tool, args);
		this.resolvedBeforeTranscriptCommit.delete(executionKey);
		this.seenFailedExecutions.add(executionKey);
		const state = this.getOrCreateState(executionKey, record, targets);
		if (this.halted) return;
		state.record = record;
		state.recoveryTargets = targets;
		state.recoveryAvailable = false;
		state.blockedReplays = 0;
		if (reservation?.executionKey !== executionKey) state.reservedExecutions++;

		state.failures++;

		const operationFailureLimit =
			record.state === "failed"
				? BASE_FAILURE_EXECUTIONS_PER_OPERATION +
					getToolExecutionUnchangedRetryLimit(record.failureCode) +
					MAX_RECOVERY_PROBES_PER_OPERATION
				: MAX_REJECTIONS_PER_OPERATION;
		if (state.failures >= operationFailureLimit) {
			if (usesOperationLocalExhaustion(tool)) {
				state.operationCircuitOpen = true;
				return;
			}
			this.halted = {
				record,
				diagnostic: `Recovery circuit opened after ${state.failures} failed outcomes for one operation.`,
			};
		}
	}

	private observeSuccess(tool: AgentTool<any>, args: unknown, result: AgentToolResult<any>): void {
		const successfulExecutionKey = getToolExecutionKey(tool.name, args);
		// Tool results are appended to the transcript after the current execution batch completes.
		// Until then the last persisted failure is stale authority: remember the exact success so a
		// later sequential call in this same batch cannot resurrect that failure from the transcript.
		this.resolvedBeforeTranscriptCommit.add(successfulExecutionKey);
		const evidenceTargets = readRecoveryEvidenceTargets(tool, args, result);
		for (const [executionKey, state] of this.statesByExecutionKey) {
			if (executionKey === successfulExecutionKey) {
				this.clearResolvedState(executionKey);
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

	private clearResolvedState(executionKey: string): void {
		this.statesByExecutionKey.delete(executionKey);
	}

	private trackTranscript(messages: readonly AgentMessage[]): void {
		const tail = messages[messages.length - 1];
		if (
			messages !== this.transcriptMessages ||
			messages.length !== this.transcriptLength ||
			tail !== this.transcriptTail
		) {
			// An advanced transcript now authoritatively records completed results. The temporary
			// exact-success overlay is bounded to one uncommitted execution batch.
			this.resolvedBeforeTranscriptCommit.clear();
		}
		this.transcriptMessages = messages;
		this.transcriptLength = messages.length;
		this.transcriptTail = tail;
	}

	private getHotState(executionKey: string): FailureRecoveryState | undefined {
		const state = this.statesByExecutionKey.get(executionKey);
		if (!state) return undefined;
		this.statesByExecutionKey.delete(executionKey);
		this.statesByExecutionKey.set(executionKey, state);
		return state;
	}

	private retainHotState(executionKey: string, state: FailureRecoveryState): void {
		this.statesByExecutionKey.delete(executionKey);
		this.statesByExecutionKey.set(executionKey, state);
		while (this.statesByExecutionKey.size > MAX_HOT_RECOVERY_STATES) {
			const oldest = this.statesByExecutionKey.keys().next().value;
			if (oldest === undefined) break;
			this.statesByExecutionKey.delete(oldest);
		}
	}

	private restoreOperationFromTranscript(executionKey: string): FailureRecoveryState | undefined {
		let restoredState: FailureRecoveryState | undefined;
		forEachPairedToolResult(this.transcriptMessages, ({ tool, args, executionKey: candidateKey, result }) => {
			if (candidateKey !== executionKey) return;
			const reduction = this.reduceTranscriptResult(restoredState, tool, args, result);
			if (reduction.kind === "resolved") {
				restoredState = undefined;
				return;
			}
			if (reduction.kind === "failed") restoredState = reduction.state;
		});
		if (restoredState) this.retainHotState(executionKey, restoredState);
		return restoredState;
	}

	private reduceTranscriptResult(
		state: FailureRecoveryState | undefined,
		tool: string,
		args: unknown,
		result: ToolResultMessage,
	): TranscriptRecoveryReduction {
		if (!result.isError) return { kind: "resolved" };
		const record = restoreToolFailureRecord(result, tool, args);
		const visibleCode = readVisibleToolFailureCode(result);
		if (isPromptScopedFailureCode(visibleCode) || isPromptScopedFailureCode(record.failureCode)) {
			return { kind: "ignored", state };
		}
		const next = state ?? createFailureRecoveryState(record, []);
		next.record = record;
		if (isClosedOperationFailureCode(visibleCode)) {
			next.operationCircuitOpen = true;
			next.blockedReplays = MAX_BLOCKED_REPLAYS_PER_FAILURE;
			next.recoveryAvailable = false;
			return { kind: "failed", state: next };
		}
		if (visibleCode === "repeated_failed_operation") {
			next.blockedReplays++;
			return { kind: "failed", state: next };
		}
		next.reservedExecutions++;
		next.failures++;
		return { kind: "failed", state: next };
	}
}

function usesOperationLocalExhaustion(tool: AgentTool<any> | undefined): boolean {
	return tool?.failureRecovery?.exhaustionScope === "operation";
}

function readFailureEvidence(
	tool: AgentTool<any>,
	args: unknown,
	failure: AgentToolFailureEvidenceContext,
): string | undefined {
	try {
		const contract = tool.failureRecovery;
		const getEvidence = contract?.getFailureEvidence;
		if (!getEvidence) return undefined;
		const evidence = Reflect.apply(getEvidence, contract, [args, failure]);
		return sanitizeToolFailureEvidence(evidence);
	} catch {
		return undefined;
	}
}

function createFailureRecoveryState(
	record: ToolFailureMemoryRecord,
	recoveryTargets: readonly AgentToolFailureRecoveryTarget[],
): FailureRecoveryState {
	return {
		record,
		recoveryTargets,
		reservedExecutions: 0,
		failures: 0,
		recoveryProbes: 0,
		blockedReplays: 0,
		recoveryAvailable: false,
		operationCircuitOpen: false,
	};
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
