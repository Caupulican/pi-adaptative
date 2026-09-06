import type { AssistantMessage } from "@caupulican/pi-ai/types";
import type { AgentMessage } from "./types.ts";

const MAX_ACTIVE_VERIFICATION_OBLIGATIONS = 16;
/** Custom terminal handoffs must remain bounded before parsing or retaining their individual records. */
const MAX_VERIFICATION_EVENTS_PER_MESSAGE = MAX_ACTIVE_VERIFICATION_OBLIGATIONS;
export const MAX_VERIFICATION_ID_LENGTH = 128;
export const VERIFICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A durable bounded witness that more unresolved failures existed than individual slots can retain. */
const VERIFICATION_OVERFLOW_ID = "_verification_overflow";
export const VERIFICATION_HANDOFF_REQUIRED_ERROR = "verification_handoff_required";
/** Stable kind identity for the durable, append-on-change obligation record (see
 * transient-records.ts). Never changes across the life of a conversation - it is the join key
 * `reconcileTransientRecords` uses to find the last recorded instance in durable history. */
export const VERIFICATION_OBLIGATION_TRANSIENT_KIND = "pi_verification_obligation";

type VerificationStatus = "failed" | "passed";

export type VerificationRecord = {
	version: 1;
	id: string;
	status: VerificationStatus;
	originTaskId?: string;
	outcome?: "executed" | "setup_failed" | "unconfirmed";
	/** Host-derived identity of equivalent requested checks within one workspace. */
	repairGroup?: string;
	/** Requested setup replacement; the tracker validates its scope, phase and ordering. */
	repairOf?: string;
};

export type VerificationObligationSnapshotDetails = {
	piVerificationObligations: {
		version: 1;
		activeIds: string[];
		setupFailures?: Array<{ id: string; repairGroup: string }>;
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
	const outcome = ownDataValue(candidate, "outcome");
	const repairGroup = ownDataValue(candidate, "repairGroup");
	const repairOf = ownDataValue(candidate, "repairOf");
	if (version !== 1 || !isVerificationId(id) || (status !== "failed" && status !== "passed")) return undefined;
	if (originTaskId !== undefined && !isOriginTaskId(originTaskId)) return undefined;
	if (outcome !== undefined && outcome !== "executed" && outcome !== "setup_failed" && outcome !== "unconfirmed")
		return undefined;
	if (status === "passed" && outcome !== undefined && outcome !== "executed") return undefined;
	if (repairGroup !== undefined && !isVerificationId(repairGroup)) return undefined;
	if (repairOf !== undefined && !isVerificationId(repairOf)) return undefined;
	return {
		version,
		id,
		status,
		...(originTaskId !== undefined ? { originTaskId } : {}),
		...(outcome !== undefined ? { outcome } : {}),
		...(repairGroup !== undefined ? { repairGroup } : {}),
		...(repairOf !== undefined ? { repairOf } : {}),
	};
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

function canonicalSetupFailures(
	value: unknown,
	activeIds: readonly string[],
): Array<{ id: string; repairGroup: string }> | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > activeIds.length) return undefined;
	const seen = new Set<string>();
	const records: Array<{ id: string; repairGroup: string }> = [];
	for (const candidate of value) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
		const id = ownDataValue(candidate, "id");
		const repairGroup = ownDataValue(candidate, "repairGroup");
		if (!isVerificationId(id) || !isVerificationId(repairGroup) || !activeIds.includes(id) || seen.has(id))
			return undefined;
		seen.add(id);
		records.push({ id, repairGroup });
	}
	return records.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function readVerificationObligationSnapshot(
	details: unknown,
): VerificationObligationSnapshotDetails["piVerificationObligations"] | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const candidate = ownDataValue(details, "piVerificationObligations");
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
	if (ownDataValue(candidate, "version") !== 1) return undefined;
	const activeIds = ownDataValue(candidate, "activeIds");
	if (!Array.isArray(activeIds) || !activeIds.every((id): id is string => typeof id === "string")) return undefined;
	const canonicalIds = boundedCanonicalIds(activeIds);
	if (!canonicalIds?.every((id, index) => id === activeIds[index])) return undefined;
	const rawSetup = ownDataValue(candidate, "setupFailures");
	const setupFailures = canonicalSetupFailures(rawSetup, canonicalIds);
	if (!setupFailures) return undefined;
	if (
		Array.isArray(rawSetup) &&
		!setupFailures.every((entry, index) => ownDataValue(rawSetup[index], "id") === entry.id)
	)
		return undefined;
	return { version: 1, activeIds: canonicalIds, ...(setupFailures.length ? { setupFailures } : {}) };
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
	setupFailures?: readonly { id: string; repairGroup: string }[],
): VerificationObligationSnapshotDetails | undefined {
	const canonicalIds = boundedCanonicalIds(activeIds);
	if (!canonicalIds) return undefined;
	const canonicalSetup = canonicalSetupFailures(setupFailures, canonicalIds);
	if (!canonicalSetup) return undefined;
	return {
		piVerificationObligations: {
			version: 1,
			activeIds: canonicalIds,
			...(canonicalSetup.length ? { setupFailures: canonicalSetup } : {}),
		},
	};
}

function formatActiveVerificationFailures(
	ids: readonly string[],
	setupGroups: ReadonlyMap<string, string>,
): string | undefined {
	if (ids.length === 0) return undefined;
	return [
		"ACTIVE VERIFICATION FAILURES",
		"Trusted verification obligations remain unresolved. A trusted pass for the same id resolves an obligation. An explicitly linked empty-test setup repair also requires matching test arguments within the same workspace and a later executed pass.",
		"Analyze the red output and relevant changes, inspect and repair the authoritative owner, then rerun the same verification.",
		"Unrelated successful tools do not clear an obligation. Completion claims are forbidden while any verification obligation remains active.",
		`An active ${VERIFICATION_OVERFLOW_ID} means bounded history lost individual failure identities; tool passes never clear that overflow obligation.`,
		"If verification cannot be completed, explain the completed work, remaining failures, and next action in ordinary prose. The host retains unresolved status separately; no special answer format is required.",
		"Active ids:",
		...ids.map(
			(id) => `- ${id}${setupGroups.has(id) ? ` (empty-test setup; corrected bash may set repairOf="${id}")` : ""}`,
		),
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
	"conversation have since resolved through trusted passing verification or validated setup repair. None are " +
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
	private readonly activeSetupGroups = new Map<string, string>();
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
		this.activeSetupGroups.clear();
		this.activeRevisions.clear();
		this.backgroundTaskRevisions.clear();
		this.transcriptRevision = 0;
		this.record(messages);
	}

	record(messages: readonly AgentMessage[]): void {
		for (const message of messages) {
			const revision = ++this.transcriptRevision;
			if (message.role === "compactionSummary") {
				const snapshot = readVerificationObligationSnapshot(message.details);
				if (!snapshot) continue;
				this.activeIds.clear();
				this.activeSetupGroups.clear();
				this.activeRevisions.clear();
				this.backgroundTaskRevisions.clear();
				for (const id of snapshot.activeIds) {
					this.activeIds.set(id, true);
					this.activeRevisions.set(id, revision);
				}
				for (const record of snapshot.setupFailures ?? [])
					this.activeSetupGroups.set(record.id, record.repairGroup);
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
			const repairedRevision = record.repairOf === undefined ? undefined : this.activeRevisions.get(record.repairOf);
			if (
				record.repairOf !== undefined &&
				record.outcome === "executed" &&
				record.repairGroup !== undefined &&
				this.activeSetupGroups.get(record.repairOf) === record.repairGroup &&
				repairedRevision !== undefined &&
				revision > repairedRevision
			) {
				this.activeIds.delete(record.repairOf);
				this.activeRevisions.delete(record.repairOf);
				this.activeSetupGroups.delete(record.repairOf);
			}
			this.activeIds.delete(record.id);
			this.activeRevisions.delete(record.id);
			this.activeSetupGroups.delete(record.id);
			return;
		}
		const setupGroup =
			record.outcome === "setup_failed" &&
			record.repairGroup !== undefined &&
			(!this.activeIds.has(record.id) || this.activeSetupGroups.get(record.id) === record.repairGroup)
				? record.repairGroup
				: undefined;
		rememberFailedVerification(this.activeIds, record.id);
		for (const id of this.activeRevisions.keys()) {
			if (!this.activeIds.has(id)) {
				this.activeRevisions.delete(id);
				this.activeSetupGroups.delete(id);
			}
		}
		if (setupGroup !== undefined && this.activeIds.has(record.id)) this.activeSetupGroups.set(record.id, setupGroup);
		else this.activeSetupGroups.delete(record.id);
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
		return formatActiveVerificationFailures(this.getActiveIds(), this.activeSetupGroups);
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

	/** Capture both unresolved identities and the bounded proof permitting setup repair. */
	createSnapshotDetails(): VerificationObligationSnapshotDetails | undefined {
		return createVerificationObligationSnapshotDetails(
			this.getActiveIds(),
			[...this.activeSetupGroups].map(([id, repairGroup]) => ({ id, repairGroup })),
		);
	}

	/** Retains the model's handoff while preventing an unresolved run from reporting success. */
	enforceTerminalMessage(message: AssistantMessage): AssistantMessage {
		if (
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			message.content.some((block) => block.type === "toolCall") ||
			this.activeIds.size === 0
		) {
			return message;
		}
		return {
			...message,
			stopReason: "error",
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
