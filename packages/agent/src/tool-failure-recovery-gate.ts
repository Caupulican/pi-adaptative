import { getToolExecutionUnchangedRetryLimit } from "@caupulican/pi-ai/tool-repair-registry";
import {
	getToolExecutionKey,
	getToolExecutionKeyHashParts,
	getToolFailureRecordExecutionKey,
	getToolFailureRecordRawKey,
	getToolRawOperationKey,
	isPromptScopedFailureCode,
	readVisibleToolFailureCode,
	restoreToolFailureRecord,
	sanitizeToolFailureEvidence,
	type ToolFailureMemoryRecord,
} from "./tool-failure-memory.ts";
import { TOOL_FAILURE_READMISSION_RULE } from "./tool-failure-recovery-protocol.ts";
import type {
	AgentMessage,
	AgentTool,
	AgentToolFailureEvidenceContext,
	AgentToolFailureRecoveryAction,
	AgentToolFailureRecoveryTarget,
} from "./types.ts";
import { isAgentToolFailureRecoveryAuthority } from "./types.ts";

const MAX_TRACKED_OPERATIONS = 64;
const SEEN_EXECUTION_FILTER_BYTES = 64 * 1024;
const MAX_RECOVERY_TARGETS = 8;
const MAX_RECOVERY_ACTIONS = 8;
const MAX_TARGET_KIND_CHARS = 64;
const MAX_TARGET_SCOPE_CHARS = 32_768;
const MAX_ACTION_INSTRUCTION_CHARS = 160;
const MAX_RECOVERY_GUIDANCE_CHARS = 320;
const TARGET_KIND_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
/** Two doublings is 4x the original bound; past that the operation needs narrowing, not more time. */
const MAX_BOUND_ESCALATIONS_PER_EPISODE = 2;
/** A bound must at least double to count as a repair; +1ms increments must buy nothing. */
const MIN_BOUND_ESCALATION_FACTOR = 2;
/**
 * Resource-envelope field names, matched case-insensitively after removing separators. Mirrors the
 * set that `tool-failure-memory` excludes from operation identity — these name the bound, not the work.
 */
const ENVELOPE_BOUND_KEYS = new Set([
	"timeout",
	"timeoutms",
	"timeoutsec",
	"timeoutseconds",
	"maxwait",
	"maxwaitms",
	"waitms",
	"waitsec",
	"waitseconds",
]);

/** Largest positive finite bound named by any envelope field, or undefined when none is present. */
function readEnvelopeBound(args: unknown): number | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	let bound: number | undefined;
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
		if (!ENVELOPE_BOUND_KEYS.has(key.toLowerCase().replaceAll(/[_-]/g, ""))) continue;
		bound = bound === undefined ? value : Math.max(bound, value);
	}
	return bound;
}

export interface ToolFailureRecoveryPlan {
	targets: readonly AgentToolFailureRecoveryTarget[];
	guidance: string;
	evidence?: string;
}

export type ToolFailureRecoveryGateEffect =
	| {
			kind: "unproductive";
			tool?: AgentTool<any>;
			record: ToolFailureMemoryRecord;
			args: unknown;
	  }
	| { kind: "success"; tool: AgentTool<any>; args: unknown };

export type ToolFailureRecoveryAdmission =
	| { kind: "allowed" }
	| {
			kind: "blocked";
			record: ToolFailureMemoryRecord;
			/**
			 * The model did change the arguments, but only in resource-envelope fields, which are not
			 * part of the operation. The refusal must say that rather than claim nothing changed.
			 */
			envelopeOnlyChange: boolean;
	  };

/**
 * What is known about one exact operation the last time it ran to completion.
 *
 * `unproductive` marks an execution that produced nothing the agent can build on — the tool failed,
 * or it completed and reported a negative operation status. Either way, running the identical
 * operation again before anything else has changed cannot yield different information.
 */
interface OperationState {
	record: ToolFailureMemoryRecord;
	worldCursorAtLastExecution: number;
	/**
	 * Immediate identical retries this failure class still allows, from the execution-error catalogue.
	 * Some classes are transient by nature — a timeout, a throttled backend — and repeating the exact
	 * call really can return something new. Spending these does not depend on the world moving.
	 */
	unchangedRetriesRemaining: number;
	/**
	 * Largest resource-envelope bound this operation carried when it last ran, in whatever unit the
	 * tool uses. Units never need normalizing: this is only ever compared against a later value of
	 * the same field on the same operation, so the unit cancels.
	 */
	envelopeBound?: number;
	/**
	 * Bound escalations this episode still allows. A timeout is the one failure whose canonical repair
	 * is a bigger bound, so a strict, material increase buys an execution — but only a fixed few, or
	 * the operation could be replayed forever by growing its own timeout.
	 */
	boundEscalationsRemaining: number;
}

interface AvailableRecoveryAction {
	toolName: string;
	kind: "correct" | "repair";
	instruction: string;
}

/**
 * Bounded negative lookup for exact execution identities.
 *
 * A miss proves the operation has not been unproductive while this gate has been alive. A hit only
 * means "possibly seen" and must be verified against the transcript, so collisions can cost a scan
 * but can never deny an execution. Keeping this separate from the hot state cache lets old
 * operations survive eviction without retaining one live object graph per historical operation.
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
 * Admission governor for exact tool operations.
 *
 * It answers exactly one question: can repeating this identical operation, right now, tell the agent
 * anything it does not already know? An operation whose last execution was unproductive is admitted
 * again once the world has moved — that is, once any tool has succeeded, or the user has spoken,
 * since that operation last ran. Until then the replay is refused, because its result is already in
 * the transcript.
 *
 * The world cursor is the whole budget. There are no per-operation attempt counts, no probe quotas,
 * and no circuits that stay open for the rest of the session: correct repair work always re-admits
 * the operation it repaired, however many times the agent needs it.
 *
 * Refusal is always local to one operation. This gate cannot deny an unrelated tool, cannot
 * terminate a tool batch, and cannot end a run — a stuck agent is the runaway-loop backstop's
 * problem (`maxStallTurns`), and reporting a dead end is the model's own job.
 */
export class ToolFailureRecoveryGate {
	private readonly statesByExecutionKey = new Map<string, OperationState>();
	private readonly seenUnproductiveExecutions = new SeenExecutionFilter();
	/** Exact successes not yet present in the transcript snapshot consulted by admission. */
	private readonly resolvedBeforeTranscriptCommit = new Set<string>();
	private transcriptMessages: readonly AgentMessage[] = [];
	private transcriptLength = 0;
	private transcriptTail: AgentMessage | undefined;
	private restoredFromTranscript = false;
	private worldCursor = 0;

	isEmpty(): boolean {
		return this.statesByExecutionKey.size === 0;
	}

	restoreFromMessages(messages: readonly AgentMessage[]): void {
		this.trackTranscript(messages);
		if (this.restoredFromTranscript || !this.isEmpty()) return;
		this.restoredFromTranscript = true;
		this.worldCursor = walkTranscript(messages, (event) => {
			if (event.kind === "resolved") {
				this.statesByExecutionKey.delete(event.executionKey);
				return;
			}
			this.seenUnproductiveExecutions.add(event.executionKey);
			// A restored state starts with no transient-retry allowance: the transcript already shows the
			// attempts that were made, and the new user turn that triggers a restore has itself moved the
			// world, which is the broader permission anyway.
			this.retainState(event.executionKey, {
				record: event.record,
				worldCursorAtLastExecution: event.worldCursor,
				unchangedRetriesRemaining: 0,
				envelopeBound: event.envelopeBound,
				boundEscalationsRemaining: MAX_BOUND_ESCALATIONS_PER_EPISODE,
			});
		});
	}

	/**
	 * Record that the world moved for a reason other than a tool result — a new user turn. Authority,
	 * intent, and files can all change across one, so every operation becomes worth attempting again.
	 */
	noteWorldAdvance(): void {
		this.worldCursor++;
	}

	planFailure(
		failedTool: AgentTool<any>,
		args: unknown,
		failure: AgentToolFailureEvidenceContext,
		availableTools: readonly AgentTool<any>[],
	): ToolFailureRecoveryPlan {
		const targets = readFailureTargets(failedTool, args, failure.failureCode);
		const actions = readAvailableRecoveryActions(availableTools, targets);
		const evidence = readFailureEvidence(failedTool, args, failure);
		return {
			targets,
			guidance: formatRecoveryGuidance(
				actions,
				this.transientRetryStanding(getToolExecutionKey(failedTool.name, args), failure.failureCode),
			),
			...(evidence ? { evidence } : {}),
		};
	}

	/**
	 * Whether this failure class allows an immediate identical retry, and whether one survives the
	 * failure about to be recorded. Read before that failure is observed, so it mirrors exactly what
	 * `observeUnproductive` is about to leave behind.
	 */
	private transientRetryStanding(executionKey: string, failureCode: string): TransientRetryStanding {
		const retryLimit = getToolExecutionUnchangedRetryLimit(failureCode);
		if (retryLimit === 0) return "none";
		const state = this.statesByExecutionKey.get(executionKey);
		const remaining =
			!state || state.worldCursorAtLastExecution !== this.worldCursor ? retryLimit : state.unchangedRetriesRemaining;
		return remaining > 0 ? "available" : "spent";
	}

	admit(
		tool: AgentTool<any>,
		args: unknown,
		record: ToolFailureMemoryRecord | undefined,
		messages: readonly AgentMessage[] = this.transcriptMessages,
	): ToolFailureRecoveryAdmission {
		this.trackTranscript(messages);
		const executionKey = getToolExecutionKey(tool.name, args);
		if (this.resolvedBeforeTranscriptCommit.has(executionKey)) return { kind: "allowed" };
		let state = this.getHotState(executionKey);
		if (!state && this.seenUnproductiveExecutions.mightContain(executionKey)) {
			state = this.restoreOperationFromTranscript(executionKey);
		}
		if (
			!state &&
			record &&
			getToolFailureRecordExecutionKey(record) === executionKey &&
			// A prompt-scoped block is cleared by a new owner prompt, never by the agent. It is not a
			// repetition state, so it must not become one through the caller's failure memory either.
			!isPromptScopedFailureCode(record.failureCode)
		) {
			state = {
				record,
				worldCursorAtLastExecution: this.worldCursor,
				unchangedRetriesRemaining: 0,
				envelopeBound: readEnvelopeBound(args),
				boundEscalationsRemaining: MAX_BOUND_ESCALATIONS_PER_EPISODE,
			};
			this.retainState(executionKey, state);
		}
		if (!state) return { kind: "allowed" };
		if (record && getToolFailureRecordExecutionKey(record) === executionKey) state.record = record;

		// A schema rejection judges the literal argument object, so the field it named is part of the
		// operation for this purpose even though execution identity omits it. Refusing the corrected
		// call here would refuse the exact repair the harness demanded.
		const storedRawKey = getToolFailureRecordRawKey(state.record);
		const incomingRawKey = getToolRawOperationKey(tool.name, args);
		const rawArgumentsDiffer = storedRawKey !== undefined && storedRawKey !== incomingRawKey;
		if (state.record.phase === "validation" && rawArgumentsDiffer) {
			this.statesByExecutionKey.delete(executionKey);
			return { kind: "allowed" };
		}

		if (this.worldCursor > state.worldCursorAtLastExecution) return { kind: "allowed" };
		if (state.unchangedRetriesRemaining > 0) {
			state.unchangedRetriesRemaining--;
			return { kind: "allowed" };
		}
		// Raising the bound is the canonical repair for a timeout. Admit a strict, material increase,
		// a bounded number of times, so the one fix that addresses the cause is not classified as no fix.
		if (state.record.phase === "timeout" && state.boundEscalationsRemaining > 0) {
			const incomingBound = readEnvelopeBound(args);
			if (
				incomingBound !== undefined &&
				state.envelopeBound !== undefined &&
				incomingBound >= state.envelopeBound * MIN_BOUND_ESCALATION_FACTOR
			) {
				state.boundEscalationsRemaining--;
				state.envelopeBound = incomingBound;
				return { kind: "allowed" };
			}
		}
		return { kind: "blocked", record: state.record, envelopeOnlyChange: rawArgumentsDiffer };
	}

	apply(effect: ToolFailureRecoveryGateEffect | undefined): void {
		if (!effect) return;
		if (effect.kind === "success") {
			this.observeSuccess(effect.tool, effect.args);
			return;
		}
		this.observeUnproductive(effect.record, effect.args);
	}

	private observeUnproductive(record: ToolFailureMemoryRecord, args: unknown): void {
		const executionKey = getToolExecutionKey(record.tool, args);
		this.resolvedBeforeTranscriptCommit.delete(executionKey);
		this.seenUnproductiveExecutions.add(executionKey);
		const previous = this.statesByExecutionKey.get(executionKey);
		// The transient-retry allowance belongs to one episode: it refills when the world has moved
		// since this operation last ran, and is otherwise spent down so a transient class cannot
		// bankroll an unbounded run of identical calls.
		const startsFreshEpisode = !previous || previous.worldCursorAtLastExecution !== this.worldCursor;
		this.retainState(executionKey, {
			record,
			worldCursorAtLastExecution: this.worldCursor,
			unchangedRetriesRemaining: startsFreshEpisode
				? getToolExecutionUnchangedRetryLimit(record.failureCode)
				: previous.unchangedRetriesRemaining,
			// The bound just executed becomes the baseline the next one must materially beat.
			envelopeBound: readEnvelopeBound(args),
			boundEscalationsRemaining: startsFreshEpisode
				? MAX_BOUND_ESCALATIONS_PER_EPISODE
				: previous.boundEscalationsRemaining,
		});
	}

	private observeSuccess(tool: AgentTool<any>, args: unknown): void {
		const executionKey = getToolExecutionKey(tool.name, args);
		// Tool results are appended to the transcript after the current execution batch completes.
		// Until then the last persisted failure is stale authority: remember the exact success so a
		// later sequential call in this same batch cannot resurrect that failure from the transcript.
		this.resolvedBeforeTranscriptCommit.add(executionKey);
		this.statesByExecutionKey.delete(executionKey);
		this.worldCursor++;
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

	private getHotState(executionKey: string): OperationState | undefined {
		const state = this.statesByExecutionKey.get(executionKey);
		if (!state) return undefined;
		this.statesByExecutionKey.delete(executionKey);
		this.statesByExecutionKey.set(executionKey, state);
		return state;
	}

	private retainState(executionKey: string, state: OperationState): void {
		this.statesByExecutionKey.delete(executionKey);
		this.statesByExecutionKey.set(executionKey, state);
		while (this.statesByExecutionKey.size > MAX_TRACKED_OPERATIONS) {
			const oldest = this.statesByExecutionKey.keys().next().value;
			if (oldest === undefined) break;
			this.statesByExecutionKey.delete(oldest);
		}
	}

	private restoreOperationFromTranscript(executionKey: string): OperationState | undefined {
		let restored: OperationState | undefined;
		walkTranscript(this.transcriptMessages, (event) => {
			if (event.executionKey !== executionKey) return;
			restored =
				event.kind === "resolved"
					? undefined
					: {
							record: event.record,
							worldCursorAtLastExecution: event.worldCursor,
							unchangedRetriesRemaining: 0,
							envelopeBound: event.envelopeBound,
							boundEscalationsRemaining: MAX_BOUND_ESCALATIONS_PER_EPISODE,
						};
		});
		if (restored) this.retainState(executionKey, restored);
		return restored;
	}
}

type TranscriptEvent =
	| { kind: "resolved"; executionKey: string; worldCursor: number }
	| {
			kind: "unproductive";
			executionKey: string;
			worldCursor: number;
			record: ToolFailureMemoryRecord;
			envelopeBound?: number;
	  };

/**
 * Replay a transcript's world advances in order, reporting each completed operation with the cursor
 * value that was current when it ran. Advances are counted exactly as the live gate counts them —
 * every successful tool result, plus every user turn — so a resumed session admits precisely what an
 * uninterrupted one would. Returns the final cursor.
 */
function walkTranscript(messages: readonly AgentMessage[], visit: (event: TranscriptEvent) => void): number {
	const callsById = new Map<string, { name: string; args: unknown }>();
	let worldCursor = 0;
	for (const message of messages) {
		if (message.role === "user") {
			worldCursor++;
			continue;
		}
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") callsById.set(block.id, { name: block.name, args: block.arguments });
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const call = callsById.get(message.toolCallId);
		if (!call) continue;
		callsById.delete(message.toolCallId);
		const executionKey = getToolExecutionKey(call.name, call.args);
		if (!message.isError) {
			worldCursor++;
			visit({ kind: "resolved", executionKey, worldCursor });
			continue;
		}
		const record = restoreToolFailureRecord(message, call.name, call.args);
		// A prompt-scoped block is cleared by a new owner prompt, not by anything the agent can do, so
		// it never becomes a repetition state.
		if (
			isPromptScopedFailureCode(readVisibleToolFailureCode(message)) ||
			isPromptScopedFailureCode(record.failureCode)
		) {
			continue;
		}
		visit({ kind: "unproductive", executionKey, worldCursor, record, envelopeBound: readEnvelopeBound(call.args) });
	}
	return worldCursor;
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

function parseRecoveryAction(value: unknown): AgentToolFailureRecoveryAction | undefined {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const candidate = value as {
			kind?: unknown;
			authority?: unknown;
			targetKind?: unknown;
			instruction?: unknown;
		};
		if (
			(candidate.kind !== "correct" && candidate.kind !== "repair") ||
			!isAgentToolFailureRecoveryAuthority(candidate.authority) ||
			!validTargetKind(candidate.targetKind) ||
			typeof candidate.instruction !== "string"
		) {
			return undefined;
		}
		return {
			kind: candidate.kind,
			authority: candidate.authority,
			targetKind: candidate.targetKind,
			instruction: candidate.instruction,
		};
	} catch {
		return undefined;
	}
}

type TransientRetryStanding = "none" | "available" | "spent";

/**
 * The admission rule comes first and is never the part that truncates: a model that reads only the
 * opening clause still learns exactly what makes this operation runnable again.
 */
function formatRecoveryGuidance(
	actions: readonly AvailableRecoveryAction[],
	transientRetry: TransientRetryStanding,
): string {
	const rule =
		transientRetry === "available"
			? `This failure class allows 1 immediate unchanged retry. ${TOOL_FAILURE_READMISSION_RULE}`
			: transientRetry === "spent"
				? `Unchanged retry spent. ${TOOL_FAILURE_READMISSION_RULE}`
				: TOOL_FAILURE_READMISSION_RULE;
	if (actions.length === 0) {
		return `${rule} Do the corrective work first, or use a materially different operation justified by the diagnostic.`;
	}
	const available = actions.map((action) => `${action.toolName} ${action.kind}: ${action.instruction}`).join(" ");
	return truncate(`${rule} Loaded actions: ${available}`, MAX_RECOVERY_GUIDANCE_CHARS);
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars - 1)}…`;
}

function sameRecoveryTarget(left: AgentToolFailureRecoveryTarget, right: AgentToolFailureRecoveryTarget): boolean {
	return left.authority === right.authority && left.kind === right.kind && left.scope === right.scope;
}
