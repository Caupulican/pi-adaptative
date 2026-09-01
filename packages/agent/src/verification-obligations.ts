import type { AssistantMessage } from "@caupulican/pi-ai/types";
import type { AgentMessage } from "./types.ts";

const MAX_ACTIVE_VERIFICATION_OBLIGATIONS = 16;
/** Custom terminal handoffs must remain bounded before parsing or retaining their individual records. */
const MAX_VERIFICATION_EVENTS_PER_MESSAGE = MAX_ACTIVE_VERIFICATION_OBLIGATIONS;
const MAX_VERIFICATION_ID_LENGTH = 128;
const VERIFICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A durable bounded witness that more unresolved failures existed than individual slots can retain. */
const VERIFICATION_OVERFLOW_ID = "_verification_overflow";
export const VERIFICATION_HANDOFF_REQUIRED_ERROR = "verification_handoff_required";
/** Stable kind identity for the durable, append-on-change obligation record (see
 * transient-records.ts). Never changes across the life of a conversation - it is the join key
 * `reconcileTransientRecords` uses to find the last recorded instance in durable history. */
export const VERIFICATION_OBLIGATION_TRANSIENT_KIND = "pi_verification_obligation";

type VerificationStatus = "failed" | "passed";

type VerificationRecord = {
	version: 1;
	id: string;
	status: VerificationStatus;
	originTaskId?: string;
};

export type VerificationObligationSnapshotDetails = {
	piVerificationObligations: {
		version: 1;
		activeIds: string[];
	};
};

function ownDataValue(record: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isVerificationId(value: unknown): value is string {
	return (
		typeof value === "string" && value.length <= MAX_VERIFICATION_ID_LENGTH && VERIFICATION_ID_PATTERN.test(value)
	);
}

function isSnapshotVerificationId(value: unknown): value is string {
	return value === VERIFICATION_OVERFLOW_ID || isVerificationId(value);
}

function isOriginTaskId(value: unknown): value is string {
	return isVerificationId(value);
}

function readVerificationRecord(candidate: unknown): VerificationRecord | undefined {
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
	const version = ownDataValue(candidate, "version");
	const id = ownDataValue(candidate, "id");
	const status = ownDataValue(candidate, "status");
	const originTaskId = ownDataValue(candidate, "originTaskId");
	if (version !== 1 || !isVerificationId(id) || (status !== "failed" && status !== "passed")) return undefined;
	if (originTaskId !== undefined && !isOriginTaskId(originTaskId)) return undefined;
	return { version, id, status, ...(originTaskId !== undefined ? { originTaskId } : {}) };
}

function readToolVerificationRecord(details: unknown): VerificationRecord | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	return readVerificationRecord(ownDataValue(details, "piVerification"));
}

function readBackgroundTaskId(details: unknown): { present: boolean; taskId?: string } {
	if (!details || typeof details !== "object" || Array.isArray(details)) return { present: false };
	const taskId = ownDataValue(details, "taskId");
	return taskId === undefined ? { present: false } : { present: true, ...(isOriginTaskId(taskId) ? { taskId } : {}) };
}

function readBackgroundTaskPlaceholder(details: unknown): string | undefined {
	const task = readBackgroundTaskId(details);
	if (!task.taskId || !details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const sessionId = ownDataValue(details, "sessionId");
	return ownDataValue(details, "status") === "running" && isOriginTaskId(sessionId) ? task.taskId : undefined;
}

function boundedCanonicalIds(activeIds: readonly string[]): string[] | undefined {
	if (activeIds.length > MAX_ACTIVE_VERIFICATION_OBLIGATIONS) return undefined;
	const sortedIds = [...activeIds].sort();
	for (let index = 0; index < sortedIds.length; index++) {
		const id = sortedIds[index];
		if (!isSnapshotVerificationId(id) || (index > 0 && id === sortedIds[index - 1])) return undefined;
	}
	return sortedIds;
}

function readVerificationObligationSnapshot(details: unknown): string[] | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const candidate = ownDataValue(details, "piVerificationObligations");
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
	if (ownDataValue(candidate, "version") !== 1) return undefined;
	const activeIds = ownDataValue(candidate, "activeIds");
	if (!Array.isArray(activeIds) || !activeIds.every((id): id is string => typeof id === "string")) return undefined;
	const canonicalIds = boundedCanonicalIds(activeIds);
	if (!canonicalIds || !canonicalIds.every((id, index) => id === activeIds[index])) return undefined;
	return canonicalIds;
}

function readVerificationEvents(details: unknown): VerificationRecord[] | typeof VERIFICATION_OVERFLOW_ID | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const events = ownDataValue(details, "piVerificationEvents");
	if (!Array.isArray(events)) return undefined;
	if (events.length > MAX_VERIFICATION_EVENTS_PER_MESSAGE) return VERIFICATION_OVERFLOW_ID;
	const records: VerificationRecord[] = [];
	for (const event of events) {
		const record = readVerificationRecord(event);
		if (!record) return undefined;
		records.push(record);
	}
	return records;
}

/** Creates the one canonical, bounded compaction detail shape for active obligations. */
export function createVerificationObligationSnapshotDetails(
	activeIds: readonly string[],
): VerificationObligationSnapshotDetails | undefined {
	const canonicalIds = boundedCanonicalIds(activeIds);
	return canonicalIds ? { piVerificationObligations: { version: 1, activeIds: canonicalIds } } : undefined;
}

function formatActiveVerificationFailures(ids: readonly string[]): string | undefined {
	if (ids.length === 0) return undefined;
	return [
		"ACTIVE VERIFICATION FAILURES",
		"Trusted verification obligations remain unresolved. Do not finish with a tool-free answer until the same id reports status passed.",
		"Analyze the red output and relevant changes, inspect and repair the authoritative owner, then rerun the same verification.",
		"Unrelated successful tools do not clear an obligation. Completion claims are forbidden while any verification obligation remains active.",
		`An active ${VERIFICATION_OVERFLOW_ID} means bounded history lost individual failure identities; tool passes never clear that overflow obligation.`,
		"If external authority makes completion impossible, respond with exactly one line for every active id: VERIFICATION_UNRESOLVED <id>: <reason>. Include no other text.",
		"Active ids:",
		...ids.map((id) => `- ${id}`),
	].join("\n");
}

/**
 * Text for the durable record appended the moment the LAST active obligation resolves (see
 * transient-records.ts's `TransientRecordSlot.clearedText`). Without this explicit record,
 * append-on-change would leave the most recent ACTIVE instruction sitting in history with nothing
 * after it saying otherwise - indistinguishable, to a reader of the raw transcript, from "still
 * active, unchanged since it was last sent".
 */
export const VERIFICATION_OBLIGATIONS_CLEARED_TEXT =
	"ACTIVE VERIFICATION FAILURES\nAll verification obligations that were active earlier in this " +
	"conversation have since resolved (a passing verification reported the same id). None are " +
	"currently active; no id-specific completion format is required.";

function rememberFailedVerification(activeIds: Map<string, true>, id: string): void {
	if (activeIds.has(id)) {
		activeIds.delete(id);
		activeIds.set(id, true);
		return;
	}
	if (activeIds.size < MAX_ACTIVE_VERIFICATION_OBLIGATIONS) {
		activeIds.set(id, true);
		return;
	}

	const alreadyOverflowed = activeIds.has(VERIFICATION_OVERFLOW_ID);
	for (const activeId of activeIds.keys()) {
		if (activeId === VERIFICATION_OVERFLOW_ID) continue;
		activeIds.delete(activeId);
		break;
	}
	activeIds.set(alreadyOverflowed ? id : VERIFICATION_OVERFLOW_ID, true);
}

/**
 * Tracks trusted verification obligations from tool results and host-owned transcript checkpoints.
 * The instruction is projected only at the provider boundary; provider text cannot create or clear one.
 */
export class VerificationObligationTracker {
	private readonly activeIds = new Map<string, true>();
	/** First transcript position of each host-owned background placeholder. */
	private readonly backgroundTaskRevisions = new Map<string, number>();
	/** Revision of each retained active identity; omitted identities cannot be cleared by a stale pass. */
	private readonly activeRevisions = new Map<string, number>();
	private transcriptRevision = 0;

	constructor(messages: readonly AgentMessage[] = []) {
		this.record(messages);
	}

	restore(messages: readonly AgentMessage[]): void {
		this.activeIds.clear();
		this.activeRevisions.clear();
		this.backgroundTaskRevisions.clear();
		this.transcriptRevision = 0;
		this.record(messages);
	}

	record(messages: readonly AgentMessage[]): void {
		for (const message of messages) {
			const revision = ++this.transcriptRevision;
			if (message.role === "compactionSummary") {
				const activeIds = readVerificationObligationSnapshot(message.details);
				if (!activeIds) continue;
				this.activeIds.clear();
				this.activeRevisions.clear();
				this.backgroundTaskRevisions.clear();
				for (const id of activeIds) {
					this.activeIds.set(id, true);
					this.activeRevisions.set(id, revision);
				}
				continue;
			}
			const background = message.role === "toolResult" ? readBackgroundTaskId(message.details) : { present: false };
			const placeholderTaskId =
				message.role === "toolResult" ? readBackgroundTaskPlaceholder(message.details) : undefined;
			if (placeholderTaskId && !this.backgroundTaskRevisions.has(placeholderTaskId)) {
				while (this.backgroundTaskRevisions.size >= MAX_ACTIVE_VERIFICATION_OBLIGATIONS) {
					const oldestTaskId = this.backgroundTaskRevisions.keys().next().value;
					if (oldestTaskId === undefined) break;
					this.backgroundTaskRevisions.delete(oldestTaskId);
				}
				this.backgroundTaskRevisions.set(placeholderTaskId, revision);
			}
			const records =
				message.role === "toolResult"
					? [readToolVerificationRecord(message.details)].filter(
							(record): record is VerificationRecord => record !== undefined,
						)
					: message.role === "custom"
						? readVerificationEvents(message.details)
						: undefined;
			if (!records) continue;
			if (records === VERIFICATION_OVERFLOW_ID) {
				this.applyRecord({ version: 1, id: VERIFICATION_OVERFLOW_ID, status: "failed" }, revision, false);
				continue;
			}
			for (const record of records) {
				const backgroundRevision = record.originTaskId
					? this.backgroundTaskRevisions.get(record.originTaskId)
					: undefined;
				const isBackgroundRecord =
					message.role === "custom" || background.present || record.originTaskId !== undefined;
				const recordRevision = backgroundRevision ?? revision;
				const originMatchesSource =
					message.role === "custom"
						? record.originTaskId !== undefined
						: record.originTaskId === undefined
							? !background.present
							: background.present && background.taskId === record.originTaskId;
				const canClear =
					record.status === "passed" &&
					(message.role !== "toolResult" || message.isError !== true) &&
					originMatchesSource &&
					(!isBackgroundRecord || backgroundRevision !== undefined);
				this.applyRecord(record, recordRevision, canClear);
			}
		}
	}

	private applyRecord(record: VerificationRecord, revision: number, canClear: boolean): void {
		const previousRevision = this.activeRevisions.get(record.id);
		if (previousRevision !== undefined && revision < previousRevision) return;
		if (record.status === "passed") {
			if (!canClear) return;
			this.activeIds.delete(record.id);
			this.activeRevisions.delete(record.id);
			return;
		}
		rememberFailedVerification(this.activeIds, record.id);
		for (const id of this.activeRevisions.keys()) {
			if (!this.activeIds.has(id)) this.activeRevisions.delete(id);
		}
		if (this.activeIds.has(record.id)) this.activeRevisions.set(record.id, revision);
		if (this.activeIds.has(VERIFICATION_OVERFLOW_ID)) {
			this.activeRevisions.set(VERIFICATION_OVERFLOW_ID, revision);
		}
	}

	/**
	 * Bounded instruction naming every currently active obligation, or `undefined` when none are
	 * active. Meant for the request's trailing transient position (see
	 * `AgentContext.trailingInstruction` and `provider-request-planner.ts`), never for
	 * `systemPrompt`: unlike the system prompt, the trailing region is not byte zero of the request,
	 * so this can change turn to turn - as obligations appear and resolve - without invalidating the
	 * provider's cached prefix.
	 */
	requestInstruction(): string | undefined {
		return formatActiveVerificationFailures(this.getActiveIds());
	}

	/**
	 * Compose the same instruction directly into an arbitrary system prompt string. Kept for callers
	 * that genuinely want system-prompt composition (e.g. a one-shot request with no separate
	 * trailing channel); the agent loop itself uses {@link requestInstruction} instead so this text
	 * never sits at byte zero of a multi-turn run's request.
	 */
	appendSystemPrompt(systemPrompt: string): string {
		const instruction = this.requestInstruction();
		if (!instruction) return systemPrompt;
		return systemPrompt ? `${systemPrompt}\n\n${instruction}` : instruction;
	}

	/** Returns the bounded active obligation identities in deterministic order. */
	getActiveIds(): readonly string[] {
		return [...this.activeIds.keys()].sort();
	}

	permitsTerminalMessage(message: AssistantMessage): boolean {
		if (this.activeIds.size === 0) return true;
		const text = message.content
			.filter(
				(block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text",
			)
			.map((block) => block.text)
			.join("\n");
		const lines = text.split("\n");
		if (lines.length !== this.activeIds.size) return false;

		const handoffIds = new Set<string>();
		for (const line of lines) {
			const handoff = /^VERIFICATION_UNRESOLVED ([^\s:]+):\s*\S[^\r\n]*$/.exec(line);
			const id = handoff?.[1];
			if (
				!id ||
				(!isVerificationId(id) && id !== VERIFICATION_OVERFLOW_ID) ||
				!this.activeIds.has(id) ||
				handoffIds.has(id)
			) {
				return false;
			}
			handoffIds.add(id);
		}
		return handoffIds.size === this.activeIds.size;
	}

	/** Removes an invalid tool-free completion without spending another provider request. */
	enforceTerminalMessage(message: AssistantMessage, stopReason: "stop" | "error"): AssistantMessage {
		if (
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			message.content.some((block) => block.type === "toolCall") ||
			this.permitsTerminalMessage(message)
		) {
			return message;
		}
		return {
			...message,
			content: [],
			stopReason,
			errorMessage: VERIFICATION_HANDOFF_REQUIRED_ERROR,
		};
	}
}

/** Preserve validated verification metadata when the normal failure projection replaces details. */
export function retainedVerificationDetails(details: unknown): { piVerification: VerificationRecord } | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const record = readVerificationRecord(ownDataValue(details, "piVerification"));
	return record ? { piVerification: record } : undefined;
}
