import { createHash, randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir } from "../../config.ts";
import type { ProcessOwner } from "../../kernel/reliability/owner-identity.ts";
import type { WorkerControlRecord } from "../../kernel/worker-control-stamp.ts";
import { checkSoulText } from "../agent-identity.ts";
import { botTeamStoreFile } from "../agent-paths.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import {
	countCalendarSlots,
	latestCalendarSlotAtOrBefore,
	MAX_CALENDAR_MISSED_COUNT,
	nextCalendarSlotAfter,
} from "../routines/calendar-schedule.ts";
import {
	decideRoutineEvents,
	initialRoutineCursor,
	MAX_ROUTINE_COMMAND_ID_CHARS,
	MAX_ROUTINE_EVENT_MISSED_COUNT,
	MAX_ROUTINE_OCCURRENCES,
	MAX_ROUTINE_PROMPT_CHARS,
	MAX_ROUTINE_REPLAY_TOMBSTONES,
	MAX_ROUTINE_SUMMARY_CHARS,
	nextRoutineAt,
	type PersistentRoutineDefinition,
	type PersistentRoutineTarget,
	parseLegacyRoutineDefinition,
	parseRoutineDefinitionView,
	parseRoutineExecutionSnapshot,
	parseRoutineOccurrence,
	parseRoutineScheduleInput,
	parseRoutineTarget,
	type RoutineClaimResult,
	type RoutineCursor,
	type RoutineDefinitionView,
	type RoutineDelivery,
	type RoutineHostEventFact,
	type RoutineHostEventFeed,
	type RoutineOccurrence,
	type RoutineOccurrenceClaimInput,
	type RoutineOccurrenceListFilter,
	type RoutineSchedule,
	type RoutineTerminalOutcome,
	rebasedRoutineCursor,
	routineCursorAfter,
	routineOccurrenceId,
	routinePreviousSlot,
	routineResultDigest,
	routineScheduleInputOf,
	routineSlotRule,
	routineStartDeadline,
	routineTriggerAt,
	type UpsertPersistentRoutineInput,
} from "../routines/routine-contract.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isRecordObject } from "../util/value-guards.ts";
import {
	claimDaemonLeaseFile,
	collectBotInboxEntries,
	collectTeamInboxEntries,
	type DaemonLeaseRelease,
	daemonLeaseBelongsTo,
	formatDurationIntervalMs,
	type PersistentBotDaemonStatus,
	type PersistentBotInboxEntry,
	parseDurationIntervalMs,
	readDaemonLeaseStatus,
	recordDaemonLaunchPidFile,
	releaseDaemonLeaseFile,
	releaseLegacyTokenDaemonLeaseFile,
	renewDaemonLeaseFile,
} from "./bot-team-routine-helpers.ts";
import type { WorkerAgentView } from "./worker-agent-control.ts";

export {
	formatDurationIntervalMs,
	type PersistentBotDaemonStatus,
	type PersistentBotInboxEntry,
	type PersistentRoutineDefinition,
	type PersistentRoutineTarget,
	parseDurationIntervalMs,
	type RoutineDefinitionView,
	type RoutineOccurrence,
	type UpsertPersistentRoutineInput,
};

export type ActiveChatTarget =
	| { readonly kind: "root" }
	| { readonly kind: "bot"; readonly agentId: string }
	| { readonly kind: "team"; readonly teamId: string };

/** What a bot-and-team update touched: `"all"` for a store change, otherwise the agents whose lane state changed. */
export type BotTeamChange = "all" | readonly string[];

export type PersistentBotLiveState = "running" | "queued" | "idle" | "awaiting_parent" | "failed" | "retired";

export interface PersistentBotRecord {
	readonly agentId: string;
	readonly displayName: string;
	readonly description?: string;
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel?: string;
	/** The bot's soul: owner-authored text that opens its worker system prompt on every turn of every worker generation. */
	readonly soul?: string;
	readonly profileId?: string;
	/** A bot edits files only when asked to: its replies are then structured reports, not chat. */
	readonly canWrite?: boolean;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly retired?: boolean;
	readonly lastTranscriptRef?: string;
	readonly lastSummary?: string;
	readonly lastMessageAt?: number;
	readonly lastReadAt?: number;
}

export interface PersistentBotView {
	/** A bot alias: always a valid bot ID. Managed lanes (`collaboration:<job>:<agent>`) are not bots and are never projected. */
	readonly agentId: string;
	readonly displayName: string;
	readonly description?: string;
	readonly provider: string;
	readonly modelId: string;
	readonly modelRef: string;
	readonly thinkingLevel?: string;
	readonly soul?: string;
	readonly profileId?: string;
	readonly state: PersistentBotLiveState;
	readonly currentTaskId?: string;
	readonly currentSummary?: string;
	readonly teamIds: readonly string[];
	readonly persistent: boolean;
	readonly controllable: boolean;
	readonly updatedAt: string;
	readonly lastTranscriptRef?: string;
	readonly lastSummary?: string;
	readonly lastMessageAt?: number;
	readonly lastReadAt?: number;
	readonly unreadCount?: number;
	readonly routineCount?: number;
	readonly memoryFilePath?: string;
}

export interface PersistentTeamRecord {
	readonly teamId: string;
	readonly incarnationId?: string;
	readonly name: string;
	readonly description?: string;
	readonly memberAgentIds: readonly string[];
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastMessageAt?: number;
	readonly lastReadAt?: number;
	readonly unreadCount?: number;
	readonly memoryFilePath?: string;
}

export interface PersistentTeamMemberDelivery {
	readonly agentId: string;
	readonly outcome: "started" | "steering" | "queued" | "failed";
	readonly messageId?: string;
	readonly detail?: string;
}

export interface PersistentTeamMessage {
	readonly messageId: string;
	readonly teamId: string;
	readonly teamIncarnationId?: string;
	readonly sender:
		| { readonly kind: "operator" }
		| { readonly kind: "brain" }
		| { readonly kind: "bot"; readonly agentId: string };
	readonly text: string;
	readonly timestamp: number;
	readonly targetAgentIds: readonly string[];
	readonly deliveries: readonly PersistentTeamMemberDelivery[];
}

export interface UpsertPersistentBotInput {
	readonly agentId: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly provider?: string;
	readonly modelId?: string;
	readonly thinkingLevel?: string;
	/** Replaces the soul; an empty string clears it. Refused when threat-flagged; it has no size limit. */
	readonly soul?: string;
	readonly profileId?: string;
	readonly canWrite?: boolean;
	readonly retired?: boolean;
	readonly lastTranscriptRef?: string;
	readonly lastSummary?: string;
	readonly lastMessageAt?: number;
	readonly lastReadAt?: number;
}

export interface UpsertPersistentTeamInput {
	readonly teamId: string;
	readonly name?: string;
	readonly description?: string;
	readonly memberAgentIds: readonly string[];
	readonly lastReadAt?: number;
}

export interface BotOperatorMessageDispatchResult {
	readonly agentId: string;
	readonly mode: "started" | "followed_up" | "steered" | "queued";
	readonly messageId?: string;
	readonly laneId?: string;
	readonly modelRef: string;
}

export interface TeamOperatorMessageDispatchResult {
	readonly teamId: string;
	readonly message: PersistentTeamMessage;
	readonly deliveries: readonly PersistentTeamMemberDelivery[];
}

/** Where a bot's memory block joins its task: the operator's words come first, so chat views cut the text here. */
export const BOT_MEMORY_BLOCK_SEPARATOR = "\n\n---\n\n";
const BOT_MEMORY_BLOCK_HEADER = "### UNIFIED MEMORY & TEAM BLACKBOARD";

/** The text a bot's chat shows for a message: without the memory block the host appended to it. */
export function withoutBotMemoryBlock(text: string): string {
	// comms-legacy-decoder: the bot chat view cuts the host's memory block from the stored prompt text; the operator text is not stored as a field yet.
	const at = text.indexOf(`${BOT_MEMORY_BLOCK_SEPARATOR}${BOT_MEMORY_BLOCK_HEADER}`);
	return at < 0 ? text : text.slice(0, at);
}

/**
 * What the operator typed in one user message of a bot's conversation. A message that names its own typed record (every
 * message written since entries carry one) is sliced at the range the record gives for the operator's words, so no
 * frame or header is parsed; the host's memory block, joined to a task by a host constant, is cut from a task's words.
 * A message without a record is read by {@link operatorTextOf}.
 */
export function botChatOperatorText(
	message: { content: string | readonly { type: string; text?: string }[] },
	control: WorkerControlRecord | undefined,
): string {
	if (control?.body && typeof message.content === "string") {
		const words = message.content.slice(control.body.from, control.body.to);
		return (control.k === "task" ? withoutBotMemoryBlock(words) : words).trim();
	}
	return operatorTextOf(
		typeof message.content === "string"
			? message.content
			: message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n"),
	);
}

/** What the operator typed, from a user message without a typed record: without the host's task wrapper, control header and memory block. */
export function operatorTextOf(text: string): string {
	let shown = withoutBotMemoryBlock(text);
	// comms-legacy-decoder: a message written before messages carried a typed record shows the operator's words only inside the control header or TASK frame.
	const control = /^\[Worker control [^\]\n]*\]\n/u.exec(shown);
	if (control) shown = shown.slice(control[0].length);
	const task = /^TASK\n([\s\S]*?)(?:\nEND TASK(?:\n[\s\S]*)?)?$/u.exec(shown);
	return (task ? (task[1] ?? shown) : shown).trim();
}

/** A bot answers a follow-up in the worker claim envelope; the chat shows what it said, which is the envelope's summary. */
export function botReplyText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return text;
	try {
		const claim: unknown = JSON.parse(trimmed);
		if (isRecordObject(claim) && typeof claim.summary === "string" && typeof claim.status === "string")
			return claim.summary;
	} catch {
		// Not an envelope: the text is the reply.
	}
	return text;
}

const BOT_OR_TEAM_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_TEAM_MESSAGES_PER_TEAM = 200;

/** Legacy records retain a deterministic identity; every new group receives a fresh random identity. */
export function teamIncarnation(team: PersistentTeamRecord): string {
	return (
		team.incarnationId ??
		`legacy-${createHash("sha256")
			.update(JSON.stringify([team.teamId, team.createdAt]))
			.digest("hex")
			.slice(0, 48)}`
	);
}

export function normalizeBotOrTeamId(raw: string, label = "identifier"): string {
	const trimmed = raw.trim();
	if (!BOT_OR_TEAM_ID_REGEX.test(trimmed)) {
		throw new Error(
			`Invalid ${label}: "${raw}". Identifiers must start with an alphanumeric character, contain only letters, numbers, underscores, dots, or hyphens, and be 1 to 128 characters long.`,
		);
	}
	return trimmed;
}

/**
 * The stored form of a bot soul. The text becomes standing instructions in every worker generation of the bot, so it
 * is screened when written: a flagged soul is refused with the findings. It has no size limit here; admission checks
 * the worker contract and prompt-budget limits. An empty result means the soul is cleared.
 */
export function normalizeBotSoul(text: string): string {
	const checked = checkSoulText(text);
	if (!checked.ok) throw new Error(`Bot soul rejected: ${checked.reason}.`);
	return checked.soul ?? "";
}

export function sameActiveChatTarget(a: ActiveChatTarget, b: ActiveChatTarget): boolean {
	switch (a.kind) {
		case "root":
			return b.kind === "root";
		case "bot":
			return b.kind === "bot" && a.agentId === b.agentId;
		case "team":
			return b.kind === "team" && a.teamId === b.teamId;
		default: {
			const _exhaustive: never = a;
			return false;
		}
	}
}

export function formatActiveChatTargetBadge(
	target: ActiveChatTarget,
	bots?: readonly PersistentBotView[],
	teams?: readonly PersistentTeamRecord[],
): string {
	switch (target.kind) {
		case "root":
			return "Brain (root)";
		case "bot": {
			const bot = bots?.find((b) => b.agentId === target.agentId);
			if (bot) {
				return `Bot: ${target.agentId} · ${bot.state}`;
			}
			return `Bot: ${target.agentId}`;
		}
		case "team": {
			const team = teams?.find((t) => t.teamId === target.teamId);
			if (team) {
				return `Team: ${target.teamId} (${team.memberAgentIds.length} bots)`;
			}
			return `Team: ${target.teamId}`;
		}
		default: {
			const _exhaustive: never = target;
			return "Brain (root)";
		}
	}
}

export function parseDirectChatAddress(
	text: string,
	knownBotIds: ReadonlySet<string>,
	knownTeamIds: ReadonlySet<string>,
): { readonly target: ActiveChatTarget; readonly body: string } | undefined {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("@")) {
		return undefined;
	}
	const match = trimmed.match(/^@(\S+)\s+([\s\S]+)$/);
	if (!match) {
		return undefined;
	}
	const rawTarget = match[1];
	const body = match[2].trim();
	if (body.length === 0) {
		return undefined;
	}

	if (rawTarget === "root" || rawTarget === "brain") {
		return { target: { kind: "root" }, body };
	}

	if (rawTarget.startsWith("team:")) {
		const teamId = rawTarget.slice(5);
		if (!teamId || !BOT_OR_TEAM_ID_REGEX.test(teamId)) {
			return undefined;
		}
		return { target: { kind: "team", teamId }, body };
	}

	if (rawTarget.startsWith("bot:")) {
		const agentId = rawTarget.slice(4);
		if (!agentId || !BOT_OR_TEAM_ID_REGEX.test(agentId)) {
			return undefined;
		}
		return { target: { kind: "bot", agentId }, body };
	}

	if (knownTeamIds.has(rawTarget)) {
		return { target: { kind: "team", teamId: rawTarget }, body };
	}

	if (knownBotIds.has(rawTarget)) {
		return { target: { kind: "bot", agentId: rawTarget }, body };
	}

	return undefined;
}

function parseModelRef(rawRef: string): { provider: string; modelId: string } {
	const trimmed = rawRef.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
		return {
			provider: trimmed.slice(0, slashIndex),
			modelId: trimmed.slice(slashIndex + 1),
		};
	}
	if (slashIndex === 0) {
		return {
			provider: "unknown",
			modelId: trimmed.slice(1) || "default",
		};
	}
	return {
		provider: "unknown",
		modelId: trimmed || "default",
	};
}

function parseBotRecord(value: unknown): PersistentBotRecord | undefined {
	if (!isRecordObject(value)) {
		return undefined;
	}
	const {
		agentId,
		displayName,
		description,
		provider,
		modelId,
		thinkingLevel,
		soul: storedSoul,
		instructions: legacyInstructions,
		profileId,
		canWrite,
		createdAt,
		updatedAt,
		retired,
		lastTranscriptRef,
		lastSummary,
		lastMessageAt,
		lastReadAt,
	} = value;
	// Records written before the soul concept stored the same text under `instructions`; the next save writes `soul`.
	const soul = storedSoul ?? legacyInstructions;

	if (
		typeof agentId !== "string" ||
		!BOT_OR_TEAM_ID_REGEX.test(agentId) ||
		typeof displayName !== "string" ||
		typeof provider !== "string" ||
		typeof modelId !== "string" ||
		typeof createdAt !== "string" ||
		typeof updatedAt !== "string"
	) {
		return undefined;
	}

	return {
		agentId,
		displayName,
		description: typeof description === "string" ? description : undefined,
		provider,
		modelId,
		thinkingLevel: typeof thinkingLevel === "string" ? thinkingLevel : undefined,
		soul: typeof soul === "string" ? soul : undefined,
		profileId: typeof profileId === "string" ? profileId : undefined,
		canWrite: typeof canWrite === "boolean" ? canWrite : undefined,
		createdAt,
		updatedAt,
		retired: typeof retired === "boolean" ? retired : undefined,
		lastTranscriptRef: typeof lastTranscriptRef === "string" ? lastTranscriptRef : undefined,
		lastSummary: typeof lastSummary === "string" ? lastSummary : undefined,
		lastMessageAt: typeof lastMessageAt === "number" && Number.isFinite(lastMessageAt) ? lastMessageAt : undefined,
		lastReadAt: typeof lastReadAt === "number" && Number.isFinite(lastReadAt) ? lastReadAt : undefined,
	};
}

function parseTeamRecord(value: unknown): PersistentTeamRecord | undefined {
	if (!isRecordObject(value)) {
		return undefined;
	}
	const {
		teamId,
		incarnationId,
		name,
		description,
		memberAgentIds,
		createdAt,
		updatedAt,
		lastMessageAt,
		lastReadAt,
		memoryFilePath,
	} = value;

	if (
		typeof teamId !== "string" ||
		!BOT_OR_TEAM_ID_REGEX.test(teamId) ||
		typeof createdAt !== "string" ||
		typeof updatedAt !== "string" ||
		(incarnationId !== undefined &&
			(typeof incarnationId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(incarnationId))) ||
		!Array.isArray(memberAgentIds)
	) {
		return undefined;
	}

	const validMembers: string[] = [];
	for (const id of memberAgentIds) {
		if (typeof id === "string" && BOT_OR_TEAM_ID_REGEX.test(id)) {
			validMembers.push(id);
		}
	}

	return {
		teamId,
		...(typeof incarnationId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(incarnationId) ? { incarnationId } : {}),
		name: typeof name === "string" ? name : teamId,
		description: typeof description === "string" ? description : undefined,
		memberAgentIds: validMembers,
		createdAt,
		updatedAt,
		lastMessageAt: typeof lastMessageAt === "number" && Number.isFinite(lastMessageAt) ? lastMessageAt : undefined,
		lastReadAt: typeof lastReadAt === "number" && Number.isFinite(lastReadAt) ? lastReadAt : undefined,
		memoryFilePath: typeof memoryFilePath === "string" ? memoryFilePath : undefined,
	};
}

function parseTeamMessage(value: unknown): PersistentTeamMessage | undefined {
	if (!isRecordObject(value)) {
		return undefined;
	}
	const { messageId, teamId, teamIncarnationId, sender, text, timestamp, targetAgentIds, deliveries } = value;

	if (
		typeof messageId !== "string" ||
		typeof teamId !== "string" ||
		!BOT_OR_TEAM_ID_REGEX.test(teamId) ||
		typeof text !== "string" ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp) ||
		!isRecordObject(sender) ||
		!Array.isArray(targetAgentIds) ||
		!Array.isArray(deliveries)
	) {
		return undefined;
	}

	let parsedSender: PersistentTeamMessage["sender"] | undefined;
	if (sender.kind === "operator") {
		parsedSender = { kind: "operator" };
	} else if (sender.kind === "brain") {
		parsedSender = { kind: "brain" };
	} else if (sender.kind === "bot" && typeof sender.agentId === "string") {
		parsedSender = { kind: "bot", agentId: sender.agentId };
	}
	if (!parsedSender) {
		return undefined;
	}

	const validTargets: string[] = [];
	for (const t of targetAgentIds) {
		if (typeof t === "string") {
			validTargets.push(t);
		}
	}

	const validDeliveries: PersistentTeamMemberDelivery[] = [];
	for (const d of deliveries) {
		if (isRecordObject(d) && typeof d.agentId === "string") {
			const outcome = d.outcome;
			if (outcome === "started" || outcome === "steering" || outcome === "queued" || outcome === "failed") {
				validDeliveries.push({
					agentId: d.agentId,
					outcome,
					messageId: typeof d.messageId === "string" ? d.messageId : undefined,
					detail: typeof d.detail === "string" ? d.detail : undefined,
				});
			}
		}
	}

	return {
		messageId,
		teamId,
		...(typeof teamIncarnationId === "string" ? { teamIncarnationId } : {}),
		sender: parsedSender,
		text,
		timestamp,
		targetAgentIds: validTargets,
		deliveries: validDeliveries,
	};
}

/** A competing initializer or outcome append owns any file that already exists. */
function createMemoryHeader(filePath: string, header: string): void {
	try {
		writeFileSync(filePath, header, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

function appendBoundedFile(filePath: string, line: string, maxLines = 80): void {
	mkdirSync(dirname(filePath), { recursive: true });
	withFileLockSync(
		filePath,
		() => {
			let lines = existsSync(filePath) ? readFileSync(filePath, "utf8").split(/\r?\n/) : [];
			lines.push(line);
			if (lines.length > maxLines) lines = lines.slice(-maxLines);
			writeFileAtomicSync(filePath, lines.join("\n"));
		},
		{ retries: 0 },
	);
}

/**
 * The routine's run-state cache for one claimed occurrence: running until its result, then that result's outcome and
 * summary. Only run state changes; the definition, revision and updatedAt stay the admitted revision's.
 */
function withRoutineRunState(routine: RoutineDefinitionView, occurrence: RoutineOccurrence): RoutineDefinitionView {
	const { lastSummary: _previousSummary, ...rest } = routine;
	const result = occurrence.result;
	return {
		...rest,
		lastRunAt: routineTriggerAt(occurrence.trigger),
		lastStatus: result?.outcome ?? "running",
		...(result ? { lastSummary: result.summary } : {}),
	};
}

export class PersistentBotTeamStore {
	private readonly agentDir: string;
	private readonly filePath: string;
	private readonly bots = new Map<string, PersistentBotRecord>();
	private readonly teams = new Map<string, PersistentTeamRecord>();
	private readonly teamMessages = new Map<string, PersistentTeamMessage[]>();
	private readonly routines = new Map<string, RoutineDefinitionView>();
	private readonly routineOccurrences = new Map<string, RoutineOccurrence>();
	private readonly routineReplayTombstones = new Set<string>();
	private routineRevisionCounter = 0;
	private readonly listeners = new Set<() => void>();
	private mutationChanged = false;
	private watcher: FSWatcher | undefined;
	private refreshQueued = false;
	private watchGeneration = 0;
	private loadedDigest: string | undefined;
	/** The loaded file has a top-level `routines` array: the shape an earlier inline-script daemon acts on. */
	private legacyRoutinesExposed = false;
	private readonly onDiagnostic: (message: string) => void;

	constructor(
		agentDir: string = getAgentDir(),
		onDiagnostic: (message: string) => void = (message) => process.emitWarning(message),
	) {
		this.agentDir = agentDir;
		this.onDiagnostic = onDiagnostic;
		this.filePath = botTeamStoreFile(agentDir);
		this.reload();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		try {
			this.startWatching();
		} catch (error) {
			this.listeners.delete(listener);
			throw error;
		}
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.stopWatching();
		};
	}

	dispose(): void {
		this.stopWatching();
		this.listeners.clear();
	}

	private stopWatching(): void {
		this.watchGeneration++;
		this.refreshQueued = false;
		this.watcher?.close();
		this.watcher = undefined;
	}

	private startWatching(): void {
		if (this.watcher) return;
		mkdirSync(dirname(this.filePath), { recursive: true });
		const generation = ++this.watchGeneration;
		const refresh = () => {
			if (generation !== this.watchGeneration || this.refreshQueued) return;
			this.refreshQueued = true;
			queueMicrotask(() => {
				if (generation !== this.watchGeneration) return;
				this.refreshQueued = false;
				try {
					if (this.reload(true)) this.notify();
				} catch (error) {
					this.onDiagnostic(
						`Bot and team store refresh failed; retaining its last readable state: ${String(error)}`,
					);
				}
			});
		};
		// Watch the directory: atomic rename replaces the file inode.
		this.watcher = watch(dirname(this.filePath), { persistent: false }, (_event, filename) => {
			if (filename === null || filename.toString() === basename(this.filePath)) refresh();
		});
		this.watcher.on("error", (error) => {
			if (generation !== this.watchGeneration) return;
			this.stopWatching();
			this.onDiagnostic(`Bot and team store watcher stopped: ${error.message}`);
		});
		// Reconcile writes between construction and subscription after admission is installed.
		refresh();
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Suppress listener errors during broadcast
			}
		}
	}

	private migrateLegacyRoutineView(value: unknown): RoutineDefinitionView | undefined {
		const definition = parseLegacyRoutineDefinition(value);
		if (definition?.schedule.kind !== "interval" || !isRecordObject(value)) return undefined;
		const cursor: RoutineCursor = { kind: "interval", nextIndex: 1 };
		const nextRunAt = nextRoutineAt(definition.schedule, cursor);
		if (nextRunAt === undefined) return undefined;
		const lastRunAt =
			typeof value.lastRunAt === "number" && Number.isSafeInteger(value.lastRunAt) ? value.lastRunAt : undefined;
		const lastStatus = ["queued", "running", "succeeded", "failed"].includes(String(value.lastStatus))
			? (value.lastStatus as RoutineDefinitionView["lastStatus"])
			: undefined;
		const lastSummary =
			typeof value.lastSummary === "string" ? value.lastSummary.slice(0, MAX_ROUTINE_SUMMARY_CHARS) : undefined;
		return {
			...definition,
			cursor,
			nextRunAt,
			...(lastRunAt === undefined ? {} : { lastRunAt }),
			...(lastStatus ? { lastStatus } : {}),
			...(lastSummary ? { lastSummary } : {}),
		};
	}

	private latestDueTrigger(
		routine: RoutineDefinitionView,
		firstDueAt: number,
		nowMs: number,
	): Extract<RoutineOccurrence["trigger"], { kind: "schedule" }> {
		if (routine.schedule.kind === "event") throw new Error("Event routines have no clock slot.");
		if (routine.schedule.kind === "once") return { kind: "schedule", scheduledAt: firstDueAt, missedCount: 0 };
		if (routine.schedule.kind === "calendar") {
			const scheduledAt = latestCalendarSlotAtOrBefore(routine.schedule, nowMs, firstDueAt);
			return {
				kind: "schedule",
				scheduledAt,
				missedCount: Math.min(
					MAX_CALENDAR_MISSED_COUNT,
					(routine.cursor.kind === "calendar" ? (routine.cursor.skipped ?? 0) : 0) +
						countCalendarSlots(routine.schedule, firstDueAt, scheduledAt, MAX_CALENDAR_MISSED_COUNT),
				),
			};
		}
		const lastIndex = Math.floor((nowMs - routine.schedule.anchorAt) / routine.schedule.intervalMs);
		const scheduledAt = routine.schedule.anchorAt + routine.schedule.intervalMs * lastIndex;
		const firstIndex = routine.cursor.kind === "interval" ? routine.cursor.nextIndex : 1;
		return { kind: "schedule", scheduledAt, missedCount: Math.max(0, lastIndex - firstIndex) };
	}

	private createClaimedOccurrence(
		definition: RoutineDefinitionView,
		occurrenceId: string,
		trigger: RoutineOccurrence["trigger"],
		owner: string,
		leaseMs: number,
		nowMs: number,
		parentOrigin: WorkerReceiptOrigin,
	): RoutineOccurrence {
		if (!this.routineJournalHasRoom())
			throw new Error("Routine occurrence journal is full of active, uncertain or undelivered entries.");
		const definitionSnapshot: PersistentRoutineDefinition = {
			routineId: definition.routineId,
			incarnationId: definition.incarnationId,
			revision: definition.revision,
			target: definition.target,
			prompt: definition.prompt,
			schedule: definition.schedule,
			enabled: definition.enabled,
			...(definition.executionSnapshot ? { executionSnapshot: definition.executionSnapshot } : {}),
			createdAt: definition.createdAt,
			updatedAt: definition.updatedAt,
		};
		return {
			occurrenceId,
			routineId: definition.routineId,
			routineRevision: definition.revision,
			definition: definitionSnapshot,
			parentOrigin,
			target: definition.target,
			trigger,
			phase: "claimed",
			createdAt: nowMs,
			updatedAt: nowMs,
			claim: { token: randomUUID(), owner, leaseUntil: nowMs + leaseMs },
		};
	}

	private updateClaimedOccurrence(
		input: { occurrenceId: string; claimToken: string; nowMs: number },
		update: (occurrence: RoutineOccurrence) => RoutineOccurrence,
	): void {
		this.mutate(() => {
			const current = this.routineOccurrences.get(input.occurrenceId);
			if (
				!current?.claim ||
				current.claim.token !== input.claimToken ||
				current.phase === "terminal" ||
				current.phase === "uncertain"
			)
				throw new Error("Routine occurrence claim is stale.");
			if (!Number.isSafeInteger(input.nowMs) || input.nowMs < current.updatedAt)
				throw new Error("This host's clock reads earlier than the routine occurrence's last transition.");
			const next = update(structuredClone(current));
			const deferred = current.phase === "dispatching" && next.phase === "pending";
			const transitionAllowed =
				deferred ||
				(current.phase === "claimed" && next.phase === "dispatching" && current.claim.leaseUntil > input.nowMs) ||
				((current.phase === "dispatching" || current.phase === "running") &&
					(next.phase === "running" || next.phase === "terminal" || next.phase === "uncertain"));
			if (!transitionAllowed)
				throw new Error("Routine occurrence transition is invalid or its dispatch lease expired.");
			if (
				next.occurrenceId !== current.occurrenceId ||
				next.routineId !== current.routineId ||
				next.routineRevision !== current.routineRevision ||
				next.createdAt !== current.createdAt ||
				next.updatedAt !== input.nowMs ||
				JSON.stringify([next.definition, next.parentOrigin, next.target, next.trigger]) !==
					JSON.stringify([current.definition, current.parentOrigin, current.target, current.trigger]) ||
				(!deferred && JSON.stringify(next.claim) !== JSON.stringify(current.claim)) ||
				(!deferred && current.dispatchKey !== undefined && next.dispatchKey !== current.dispatchKey) ||
				(current.executionRef !== undefined && next.executionRef?.taskId !== current.executionRef.taskId) ||
				(!deferred && !next.dispatchKey) ||
				(next.dispatchKey !== undefined && (next.dispatchKey.length > 512 || next.dispatchKey.includes("\0"))) ||
				!parseRoutineOccurrence(next)
			)
				throw new Error("Routine transition cannot change its admitted identity or retain invalid state.");
			this.routineOccurrences.set(current.occurrenceId, next);
			this.save();
		});
	}

	private withResult(
		occurrence: RoutineOccurrence,
		outcome: RoutineTerminalOutcome,
		summaryRaw: string,
		recipient: string,
		ownerUpdate?: "none",
	): RoutineOccurrence {
		const summary = summaryRaw.trim().slice(0, MAX_ROUTINE_SUMMARY_CHARS) || "No summary was provided.";
		if (recipient !== occurrence.parentOrigin.sessionId)
			throw new Error("Routine result recipient does not match its admitted parent.");
		if (ownerUpdate !== undefined && outcome !== "succeeded")
			throw new Error("Only a succeeded routine run can skip the owner update.");
		const digest = routineResultDigest(outcome, summary, recipient, ownerUpdate === "none");
		const finished: RoutineOccurrence = {
			...occurrence,
			result: { outcome, summary, digest, delivery: "pending", recipient, ...(ownerUpdate ? { ownerUpdate } : {}) },
		};
		// The routine's last run state follows the result of its most recently claimed occurrence only.
		const routine = this.routines.get(occurrence.routineId);
		if (
			routine?.incarnationId === occurrence.definition.incarnationId &&
			routine.lastRunAt === routineTriggerAt(occurrence.trigger)
		)
			this.routines.set(routine.routineId, withRoutineRunState(routine, finished));
		return finished;
	}

	/** Prunes delivered history when the journal is at capacity; whether one more occurrence then fits. */
	private routineJournalHasRoom(): boolean {
		if (this.routineOccurrences.size < MAX_ROUTINE_OCCURRENCES) return true;
		const removable = Array.from(this.routineOccurrences.values())
			.filter(
				(item) =>
					item.phase === "terminal" &&
					item.result?.delivery === "acknowledged" &&
					(!item.priorUncertaintyResult || item.priorUncertaintyResult.delivery === "acknowledged"),
			)
			.sort((a, b) => a.updatedAt - b.updatedAt);
		while (this.routineOccurrences.size >= MAX_ROUTINE_OCCURRENCES && removable.length > 0) {
			const item = removable.shift();
			if (!item) continue;
			// Slot occurrences cannot recur behind their cursor; manual commands and CI attempts can be re-presented.
			if (item.trigger.kind !== "schedule") {
				if (this.routineReplayTombstones.size >= MAX_ROUTINE_REPLAY_TOMBSTONES) continue;
				this.routineReplayTombstones.add(item.occurrenceId);
			}
			this.routineOccurrences.delete(item.occurrenceId);
		}
		return this.routineOccurrences.size < MAX_ROUTINE_OCCURRENCES;
	}

	private cancelUndispatchedRoutineOccurrences(routineId: string, nowMs: number): void {
		for (const item of this.routineOccurrences.values()) {
			if (item.routineId !== routineId || (item.phase !== "pending" && item.phase !== "claimed")) continue;
			const cancelled = this.withResult(
				{ ...item, phase: "terminal", updatedAt: nowMs },
				"cancelled",
				"Routine was paused or deleted before dispatch.",
				item.parentOrigin.sessionId,
			);
			this.routineOccurrences.set(item.occurrenceId, cancelled);
		}
	}

	private highestRoutineRevision(): number {
		let highest = 0;
		for (const routine of this.routines.values()) highest = Math.max(highest, routine.revision);
		for (const occurrence of this.routineOccurrences.values())
			highest = Math.max(highest, occurrence.routineRevision);
		return highest;
	}

	/**
	 * Writes the store. Routines are kept under `routineSchedules`, never the version-1 `routines` key: an inline-script
	 * daemon of an earlier build rewrites the store, unlocked and non-atomically, only while its top level holds a
	 * `routines` array, so every save also seals the store against that writer (see `bot-daemon-legacy.ts`).
	 */
	private save(): void {
		if (this.routines.size > MAX_ROUTINE_OCCURRENCES)
			throw new Error("Routine definition registry exceeds its bounded capacity.");
		if (
			this.routineOccurrences.size > MAX_ROUTINE_OCCURRENCES ||
			this.routineReplayTombstones.size > MAX_ROUTINE_REPLAY_TOMBSTONES
		)
			throw new Error("Routine occurrence custody exceeds its bounded capacity.");
		for (const routine of this.routines.values()) {
			if (!parseRoutineDefinitionView(routine))
				throw new Error("Refusing to persist an invalid routine definition or cursor.");
		}
		for (const occurrence of this.routineOccurrences.values()) {
			if (!parseRoutineOccurrence(occurrence)) throw new Error("Refusing to persist an invalid routine occurrence.");
		}
		const highestRoutineRevision = this.highestRoutineRevision();
		if (!Number.isSafeInteger(this.routineRevisionCounter) || this.routineRevisionCounter < highestRoutineRevision)
			throw new Error("Refusing to persist a stale routine revision counter.");
		const data = {
			version: 3,
			routineRevisionCounter: this.routineRevisionCounter,
			bots: Array.from(this.bots.values()),
			teams: Array.from(this.teams.values()),
			teamMessages: Object.fromEntries(this.teamMessages),
			...(this.routines.size > 0 ? { routineSchedules: Array.from(this.routines.values()) } : {}),
			...(this.routineOccurrences.size > 0
				? { routineOccurrences: Array.from(this.routineOccurrences.values()) }
				: {}),
			...(this.routineReplayTombstones.size > 0
				? { routineManualTombstones: Array.from(this.routineReplayTombstones) }
				: {}),
		};
		writeFileAtomicSync(this.filePath, JSON.stringify(data, null, 2));
		this._cachedTeamList = undefined;
		this.mutationChanged = true;
	}

	private mutate<T>(action: () => T): T {
		mkdirSync(dirname(this.filePath), { recursive: true });
		this.mutationChanged = false;
		try {
			return withFileLockSync(
				this.filePath,
				() => {
					this.reload();
					try {
						return action();
					} finally {
						this.reload();
					}
				},
				{ retries: 0 },
			);
		} finally {
			if (this.mutationChanged) this.notify();
		}
	}

	private _cachedTeamList?: PersistentTeamRecord[];

	/** Re-reads the shared store file. Every mutation starts here so another session's changes are not overwritten. */
	reload(observeOnly = false): boolean {
		let parsed: unknown;
		let raw: string | undefined;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const digest = raw === undefined ? undefined : createHash("sha256").update(raw).digest("hex");
		if (observeOnly && digest === this.loadedDigest) return false;
		if (raw !== undefined) {
			parsed = JSON.parse(raw);
		}
		let storeVersion: number | undefined;
		if (raw !== undefined) {
			if (!isRecordObject(parsed)) throw new Error("Bot and team store is not an object.");
			if (
				typeof parsed.version !== "number" ||
				![1, 2, 3].includes(parsed.version) ||
				!Array.isArray(parsed.bots) ||
				!Array.isArray(parsed.teams) ||
				!isRecordObject(parsed.teamMessages)
			)
				throw new Error("Bot and team store has an invalid envelope.");
			storeVersion = parsed.version;
		}
		const previousState = {
			bots: new Map(this.bots),
			teams: new Map(this.teams),
			teamMessages: new Map(this.teamMessages),
			routines: new Map(this.routines),
			occurrences: new Map(this.routineOccurrences),
			replayTombstones: new Set(this.routineReplayTombstones),
			revisionCounter: this.routineRevisionCounter,
			loadedDigest: this.loadedDigest,
			legacyRoutinesExposed: this.legacyRoutinesExposed,
			cachedTeamList: this._cachedTeamList,
		};
		this._cachedTeamList = undefined;
		this.bots.clear();
		this.teams.clear();
		this.teamMessages.clear();
		this.routines.clear();
		this.routineOccurrences.clear();
		this.routineReplayTombstones.clear();
		this.routineRevisionCounter = 0;
		this.loadedDigest = digest;
		this.legacyRoutinesExposed = isRecordObject(parsed) && Array.isArray(parsed.routines);
		if (!isRecordObject(parsed)) return true;

		if (Array.isArray(parsed.bots)) {
			for (const rawBot of parsed.bots) {
				const bot = parseBotRecord(rawBot);
				if (bot) {
					this.bots.set(bot.agentId, bot);
				}
			}
		}

		if (Array.isArray(parsed.teams)) {
			for (const rawTeam of parsed.teams) {
				const team = parseTeamRecord(rawTeam);
				if (team) {
					this.teams.set(team.teamId, team);
				}
			}
		}

		if (isRecordObject(parsed.teamMessages)) {
			for (const [teamId, rawMessages] of Object.entries(parsed.teamMessages)) {
				if (BOT_OR_TEAM_ID_REGEX.test(teamId) && Array.isArray(rawMessages)) {
					const validMessages: PersistentTeamMessage[] = [];
					for (const rawMsg of rawMessages) {
						const msg = parseTeamMessage(rawMsg);
						if (msg && msg.teamId === teamId) {
							validMessages.push(msg);
						}
					}
					if (validMessages.length > 0) {
						this.teamMessages.set(teamId, validMessages.slice(-MAX_TEAM_MESSAGES_PER_TEAM));
					}
				}
			}
		}

		// A version-1 store (or one an older build rewrote) keeps routines under `routines`.
		const rawRoutines = Array.isArray(parsed.routineSchedules) ? parsed.routineSchedules : parsed.routines;
		try {
			if (Array.isArray(rawRoutines)) {
				for (const rawRoutine of rawRoutines) {
					const routine =
						parseRoutineDefinitionView(rawRoutine) ??
						(storeVersion !== undefined && storeVersion < 3
							? this.migrateLegacyRoutineView(rawRoutine)
							: undefined);
					if (!routine) {
						if (storeVersion === 3)
							throw new Error(
								"Routine definition or cursor is malformed; refusing to drop durable schedule state.",
							);
						continue;
					}
					if (this.routines.has(routine.routineId))
						throw new Error("Routine store contains duplicate routine identities.");
					this.routines.set(routine.routineId, routine);
				}
			} else if (storeVersion === 3 && parsed.routineSchedules !== undefined) {
				throw new Error("Routine schedule registry is malformed.");
			}
			if (parsed.routineOccurrences !== undefined) {
				if (!Array.isArray(parsed.routineOccurrences) || parsed.routineOccurrences.length > MAX_ROUTINE_OCCURRENCES)
					throw new Error("Routine occurrence journal has an invalid size.");
				for (const raw of parsed.routineOccurrences) {
					const occurrence = parseRoutineOccurrence(raw);
					if (!occurrence || this.routineOccurrences.has(occurrence.occurrenceId))
						throw new Error("Routine occurrence journal contains an invalid or duplicate entry.");
					this.routineOccurrences.set(occurrence.occurrenceId, occurrence);
				}
			}
			if (parsed.routineManualTombstones !== undefined) {
				if (
					!Array.isArray(parsed.routineManualTombstones) ||
					parsed.routineManualTombstones.length > MAX_ROUTINE_REPLAY_TOMBSTONES ||
					parsed.routineManualTombstones.some(
						(id) =>
							typeof id !== "string" ||
							id.length > 256 ||
							!/^[A-Za-z0-9-]+:[0-9]+:(?:manual|event):[a-f0-9]{64}$/u.test(id),
					)
				)
					throw new Error("Routine replay journal has an invalid shape.");
				for (const id of parsed.routineManualTombstones as string[]) {
					if (this.routineReplayTombstones.has(id))
						throw new Error("Routine replay journal contains duplicate entries.");
					this.routineReplayTombstones.add(id);
				}
			}
			const highestRoutineRevision = this.highestRoutineRevision();
			const storedRevisionCounter = parsed.routineRevisionCounter;
			if (storeVersion === 3 && storedRevisionCounter === undefined)
				throw new Error("Routine revision counter is required in the current store format.");
			if (
				storedRevisionCounter !== undefined &&
				(!Number.isSafeInteger(storedRevisionCounter) || (storedRevisionCounter as number) < highestRoutineRevision)
			)
				throw new Error("Routine revision counter is malformed or behind persisted routine identity.");
			this.routineRevisionCounter =
				storedRevisionCounter === undefined ? highestRoutineRevision : (storedRevisionCounter as number);
		} catch (error) {
			this.bots.clear();
			for (const [id, value] of previousState.bots) this.bots.set(id, value);
			this.teams.clear();
			for (const [id, value] of previousState.teams) this.teams.set(id, value);
			this.teamMessages.clear();
			for (const [id, value] of previousState.teamMessages) this.teamMessages.set(id, value);
			this.routines.clear();
			for (const [id, value] of previousState.routines) this.routines.set(id, value);
			this.routineOccurrences.clear();
			for (const [id, value] of previousState.occurrences) this.routineOccurrences.set(id, value);
			this.routineReplayTombstones.clear();
			for (const value of previousState.replayTombstones) this.routineReplayTombstones.add(value);
			this.routineRevisionCounter = previousState.revisionCounter;
			this.loadedDigest = previousState.loadedDigest;
			this.legacyRoutinesExposed = previousState.legacyRoutinesExposed;
			this._cachedTeamList = previousState.cachedTeamList;
			throw error;
		}
		return true;
	}

	listBots(options?: { includeRetired?: boolean }): PersistentBotRecord[] {
		const all = Array.from(this.bots.values(), (bot) => ({ ...bot }));
		if (options?.includeRetired) {
			return all;
		}
		return all.filter((b) => !b.retired);
	}

	getBot(agentId: string): PersistentBotRecord | undefined {
		const bot = this.bots.get(agentId.trim());
		return bot ? { ...bot } : undefined;
	}

	upsertBot(input: UpsertPersistentBotInput, nowIso?: string): PersistentBotRecord {
		return this.mutate(() => this.writeBot(input, nowIso));
	}

	/** Select creation defaults only after the shared record has been reloaded under its lock. */
	ensureBotForDispatch(
		agentId: string,
		defaults: () => Pick<UpsertPersistentBotInput, "provider" | "modelId" | "thinkingLevel">,
	): PersistentBotRecord {
		return this.mutate(() => {
			const normalizedId = normalizeBotOrTeamId(agentId, "agentId");
			return this.writeBot({
				...(this.bots.has(normalizedId) ? {} : defaults()),
				agentId: normalizedId,
				lastMessageAt: Date.now(),
			});
		});
	}

	/** Update loaded state; callers own the single mutation transaction. */
	private writeBot(input: UpsertPersistentBotInput, nowIso?: string): PersistentBotRecord {
		const agentId = normalizeBotOrTeamId(input.agentId, "agentId");
		const existing = this.bots.get(agentId);
		const provider = (input.provider !== undefined ? input.provider.trim() : existing?.provider) || "anthropic";
		const modelId = (input.modelId !== undefined ? input.modelId.trim() : existing?.modelId) || "claude-haiku-5-5";

		const now = nowIso ?? new Date().toISOString();

		const record: PersistentBotRecord = {
			agentId,
			displayName: input.displayName?.trim() || existing?.displayName || agentId,
			description: input.description !== undefined ? input.description.trim() || undefined : existing?.description,
			provider,
			modelId,
			thinkingLevel:
				input.thinkingLevel !== undefined ? input.thinkingLevel.trim() || undefined : existing?.thinkingLevel,
			soul: input.soul !== undefined ? normalizeBotSoul(input.soul) || undefined : existing?.soul,
			profileId: input.profileId !== undefined ? input.profileId.trim() || undefined : existing?.profileId,
			canWrite: input.canWrite ?? existing?.canWrite,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			retired: input.retired ?? existing?.retired ?? false,
			lastTranscriptRef:
				input.lastTranscriptRef !== undefined
					? input.lastTranscriptRef.trim() || undefined
					: existing?.lastTranscriptRef,
			lastSummary:
				input.lastSummary !== undefined
					? input.lastSummary.trim().slice(0, 500) || undefined
					: existing?.lastSummary,
			lastMessageAt:
				input.lastMessageAt !== undefined && Number.isFinite(input.lastMessageAt)
					? input.lastMessageAt
					: existing?.lastMessageAt,
			lastReadAt:
				input.lastReadAt !== undefined && Number.isFinite(input.lastReadAt)
					? input.lastReadAt
					: existing?.lastReadAt,
		};

		this.bots.set(agentId, record);
		this.ensureBotMemoryFile(agentId);
		this.save();
		return record;
	}

	retireBot(agentId: string, nowIso?: string): PersistentBotRecord | undefined {
		return this.mutate(() => {
			const normalizedId = normalizeBotOrTeamId(agentId, "agentId");
			const existing = this.bots.get(normalizedId);
			if (!existing) {
				return undefined;
			}
			const now = nowIso ?? new Date().toISOString();
			const updated: PersistentBotRecord = {
				...existing,
				retired: true,
				updatedAt: now,
				lastTranscriptRef: existing.lastTranscriptRef,
				lastSummary: existing.lastSummary,
				lastMessageAt: existing.lastMessageAt,
			};
			this.bots.set(normalizedId, updated);
			this.save();
			return updated;
		});
	}

	deleteBot(agentId: string): boolean {
		return this.mutate(() => {
			const normalizedId = normalizeBotOrTeamId(agentId, "agentId");
			if (!this.bots.has(normalizedId)) {
				return false;
			}
			this.bots.delete(normalizedId);

			const now = new Date().toISOString();
			for (const [teamId, team] of this.teams.entries()) {
				if (team.memberAgentIds.includes(normalizedId)) {
					const filteredMembers = team.memberAgentIds.filter((id) => id !== normalizedId);
					this.teams.set(teamId, {
						...team,
						memberAgentIds: filteredMembers,
						updatedAt: now,
					});
				}
			}

			for (const [routineId, routine] of this.routines.entries()) {
				if (routine.target.kind === "bot" && routine.target.agentId === normalizedId) {
					this.cancelUndispatchedRoutineOccurrences(routineId, Date.now());
					this.routines.delete(routineId);
				}
			}

			this.save();
			return true;
		});
	}

	private computeTeamUnreadCount(team: PersistentTeamRecord): number {
		const readAt = team.lastReadAt ?? 0;
		const msgs = this.teamMessages.get(team.teamId) ?? [];
		const currentIncarnation = teamIncarnation(team);
		return msgs.filter(
			(m) =>
				(!m.teamIncarnationId || m.teamIncarnationId === currentIncarnation) &&
				m.timestamp > readAt &&
				m.sender.kind !== "operator",
		).length;
	}

	listTeams(): PersistentTeamRecord[] {
		if (this._cachedTeamList === undefined) {
			this._cachedTeamList = Array.from(this.teams.values()).map((team) => ({
				...team,
				memberAgentIds: [...team.memberAgentIds],
				unreadCount: this.computeTeamUnreadCount(team),
				memoryFilePath: this.getTeamMemoryFilePath(team.teamId),
			}));
		}
		return this._cachedTeamList.map((team) => ({
			...team,
			memberAgentIds: [...team.memberAgentIds],
		}));
	}

	getTeam(teamId: string): PersistentTeamRecord | undefined {
		const team = this.teams.get(teamId.trim());
		if (!team) return undefined;
		return {
			...team,
			memberAgentIds: [...team.memberAgentIds],
			unreadCount: this.computeTeamUnreadCount(team),
			memoryFilePath: this.getTeamMemoryFilePath(team.teamId),
		};
	}

	upsertTeam(input: UpsertPersistentTeamInput, nowIso?: string): PersistentTeamRecord {
		return this.mutate(() => {
			const teamId = normalizeBotOrTeamId(input.teamId, "teamId");
			const now = nowIso ?? new Date().toISOString();
			const existing = this.teams.get(teamId);

			const memberSet = new Set<string>();
			for (const id of input.memberAgentIds) {
				const trimmed = id.trim();
				if (trimmed) {
					memberSet.add(normalizeBotOrTeamId(trimmed, "memberAgentId"));
				}
			}
			const memberAgentIds = Array.from(memberSet);

			const record: PersistentTeamRecord = {
				teamId,
				incarnationId: existing ? teamIncarnation(existing) : randomUUID(),
				name: input.name?.trim() || existing?.name || teamId,
				description:
					input.description !== undefined ? input.description.trim() || undefined : existing?.description,
				memberAgentIds,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				lastMessageAt: existing?.lastMessageAt,
				lastReadAt:
					input.lastReadAt !== undefined && Number.isFinite(input.lastReadAt)
						? input.lastReadAt
						: existing?.lastReadAt,
			};

			this.teams.set(teamId, record);
			this.ensureTeamMemoryFile(teamId);
			this.save();
			return {
				...record,
				unreadCount: this.computeTeamUnreadCount(record),
				memoryFilePath: this.getTeamMemoryFilePath(teamId),
			};
		});
	}

	setTeamMembers(teamId: string, memberAgentIds: readonly string[], nowIso?: string): PersistentTeamRecord {
		return this.mutate(() => {
			const normalizedId = normalizeBotOrTeamId(teamId, "teamId");
			const existing = this.teams.get(normalizedId);
			if (!existing) {
				throw new Error(`Team not found: "${teamId}".`);
			}

			const memberSet = new Set<string>();
			for (const id of memberAgentIds) {
				const trimmed = id.trim();
				if (trimmed) {
					memberSet.add(normalizeBotOrTeamId(trimmed, "memberAgentId"));
				}
			}

			const now = nowIso ?? new Date().toISOString();
			const updated: PersistentTeamRecord = {
				...existing,
				memberAgentIds: Array.from(memberSet),
				updatedAt: now,
				memoryFilePath: this.getTeamMemoryFilePath(normalizedId),
			};

			this.teams.set(normalizedId, updated);
			this.ensureTeamMemoryFile(normalizedId);
			this.save();
			return updated;
		});
	}

	deleteTeam(teamId: string): boolean {
		return this.mutate(() => {
			const normalizedId = normalizeBotOrTeamId(teamId, "teamId");
			if (!this.teams.has(normalizedId)) {
				return false;
			}
			this.teams.delete(normalizedId);
			this.teamMessages.delete(normalizedId);
			for (const [routineId, routine] of this.routines.entries()) {
				if (routine.target.kind === "team" && routine.target.teamId === normalizedId) {
					this.cancelUndispatchedRoutineOccurrences(routineId, Date.now());
					this.routines.delete(routineId);
				}
			}
			this.save();
			return true;
		});
	}

	listRoutines(): RoutineDefinitionView[] {
		return Array.from(this.routines.values(), (r) => structuredClone(r)).sort((a, b) => a.nextRunAt - b.nextRunAt);
	}

	getRoutine(routineId: string): RoutineDefinitionView | undefined {
		const routine = this.routines.get(routineId.trim());
		return routine ? structuredClone(routine) : undefined;
	}

	upsertRoutine(input: UpsertPersistentRoutineInput): RoutineDefinitionView {
		return this.mutate(() => {
			const normalizedId = normalizeBotOrTeamId(input.routineId, "routineId");
			const existing = this.routines.get(normalizedId);
			if (input.expectedRevision !== undefined && existing?.revision !== input.expectedRevision)
				throw new Error("Routine revision changed; read current state before retrying.");
			if (input.createOnly && existing) throw new Error("Routine already exists.");
			const scheduleInput = parseRoutineScheduleInput(input.schedule);
			const session = input.target.kind === "session";
			if (session !== (input.executionSnapshot !== undefined))
				throw new Error("Session routines require a host-admitted execution snapshot.");
			// The stored side is re-canonicalized: a runtime may spell a stored zone differently than when it was saved.
			const scheduleChanged =
				!existing ||
				!isDeepStrictEqual(
					routineSlotRule(parseRoutineScheduleInput(routineScheduleInputOf(existing.schedule))),
					routineSlotRule(scheduleInput),
				);
			const anchorAt =
				!scheduleChanged && existing && "anchorAt" in existing.schedule
					? existing.schedule.anchorAt
					: (input.nowMs ?? Date.now());
			let schedule: RoutineSchedule;
			if (scheduleInput.kind === "interval")
				schedule = { kind: "interval", intervalMs: scheduleInput.intervalMs, anchorAt };
			else if (scheduleInput.kind === "once") schedule = scheduleInput;
			else if (scheduleInput.kind === "event") {
				// Host events are decided by the session that owns their ledger; a bot or team has none.
				if (!session) throw new Error("Event routines run in their owning session only.");
				const kept = !scheduleChanged && existing?.schedule.kind === "event" ? existing.schedule : undefined;
				const anchor = kept
					? { ordinal: kept.anchorOrdinal, replayGaps: kept.anchorReplayGaps }
					: input.eventAnchor;
				if (!anchor) throw new Error("Event routines require the session's host-event ledger position.");
				schedule = {
					kind: "event",
					source: scheduleInput.source,
					conclusions: scheduleInput.conclusions ?? ["failure"],
					...(scheduleInput.workflowPath === undefined ? {} : { workflowPath: scheduleInput.workflowPath }),
					anchorOrdinal: anchor.ordinal,
					anchorReplayGaps: anchor.replayGaps,
				};
			} else if (scheduleInput.timeZone === undefined) throw new Error("Calendar routines require a time zone.");
			else schedule = { ...scheduleInput, timeZone: scheduleInput.timeZone, anchorAt };
			const cursor: RoutineCursor = scheduleChanged || !existing ? initialRoutineCursor(schedule) : existing.cursor;
			if (
				schedule.kind === "once" &&
				schedule.notAfter !== undefined &&
				schedule.notAfter < (input.nowMs ?? Date.now()) &&
				!(existing?.schedule.kind === "once" && existing.schedule.notAfter === schedule.notAfter)
			)
				throw new Error("One-time routine start window has already closed.");
			const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
			if (this.routineRevisionCounter >= Number.MAX_SAFE_INTEGER)
				throw new Error("Routine revision counter is exhausted.");
			const revision = this.routineRevisionCounter + 1;
			this.routineRevisionCounter = revision;
			const definition: PersistentRoutineDefinition = {
				routineId: normalizedId,
				incarnationId: existing?.incarnationId ?? randomUUID(),
				revision,
				target: parseRoutineTarget(input.target),
				prompt: input.prompt.trim(),
				schedule,
				enabled: input.enabled ?? existing?.enabled ?? true,
				...(input.executionSnapshot
					? { executionSnapshot: parseRoutineExecutionSnapshot(input.executionSnapshot) }
					: {}),
				createdAt: existing?.createdAt ?? nowIso,
				updatedAt: nowIso,
			};
			if (!definition.prompt || definition.prompt.length > MAX_ROUTINE_PROMPT_CHARS)
				throw new Error("Routine prompt is invalid.");
			if (
				definition.executionSnapshot &&
				(definition.target.kind !== "session" ||
					definition.executionSnapshot.parentSessionId !== definition.target.parentSessionId)
			)
				throw new Error("Routine snapshot does not match its session target.");
			const plannedRunAt = nextRoutineAt(schedule, cursor);
			if (plannedRunAt === undefined && schedule.kind === "interval")
				throw new Error("Routine interval has no representable future instant.");
			if (plannedRunAt === undefined && schedule.kind === "calendar" && scheduleChanged)
				throw new Error("Calendar rule never matches a date.");
			const nextRunAt = plannedRunAt ?? Number.MAX_SAFE_INTEGER;
			const view: RoutineDefinitionView = {
				...definition,
				cursor,
				nextRunAt,
				...(existing?.lastRunAt === undefined ? {} : { lastRunAt: existing.lastRunAt }),
				...(existing?.lastStatus ? { lastStatus: existing.lastStatus } : {}),
				...(existing?.lastSummary ? { lastSummary: existing.lastSummary } : {}),
			};
			if (!parseRoutineDefinitionView(view)) throw new Error("Routine definition is invalid for durable storage.");
			this.routines.set(normalizedId, view);
			if (!view.enabled) this.cancelUndispatchedRoutineOccurrences(normalizedId, input.nowMs ?? Date.now());
			this.save();
			return structuredClone(view);
		});
	}

	deleteRoutine(routineId: string, expectedRevision?: number, nowMs = Date.now()): boolean {
		return this.mutate(() => {
			const normalizedId = normalizeBotOrTeamId(routineId, "routineId");
			const existing = this.routines.get(normalizedId);
			if (!existing) return false;
			if (expectedRevision !== undefined && existing.revision !== expectedRevision)
				throw new Error("Routine revision changed; read current state before retrying.");
			this.cancelUndispatchedRoutineOccurrences(normalizedId, nowMs);
			this.routines.delete(normalizedId);
			this.save();
			return true;
		});
	}

	claimDueRoutineOccurrences(input: RoutineOccurrenceClaimInput): RoutineClaimResult {
		return this.mutate(() => {
			if (
				!Number.isSafeInteger(input.nowMs) ||
				input.nowMs < 0 ||
				!Number.isSafeInteger(input.leaseMs) ||
				input.leaseMs <= 0 ||
				!Number.isSafeInteger(input.nowMs + input.leaseMs) ||
				!Number.isFinite(new Date(input.nowMs + input.leaseMs).getTime()) ||
				!Number.isSafeInteger(input.limit) ||
				input.limit < 1 ||
				!input.owner ||
				input.owner.trim() !== input.owner ||
				input.owner.length > 256 ||
				input.owner.includes("\0")
			)
				throw new Error("Routine claim requires a valid owner, bounded count and positive lease.");
			const output: RoutineOccurrence[] = [];
			let changed = false;
			const limit = Math.min(input.limit, MAX_ROUTINE_OCCURRENCES);
			const eligible = input.eligibleRoutineIds ? new Set(input.eligibleRoutineIds) : undefined;
			const eligibleOccurrences = input.eligibleOccurrenceIds ? new Set(input.eligibleOccurrenceIds) : undefined;
			// Accepted work owns its original definition independently of the schedule cursor.
			// Recover it first, including consumed one-offs and manual occurrences.
			for (const [occurrenceId, occurrence] of this.routineOccurrences) {
				if (output.length >= limit) break;
				if (occurrence.phase !== "pending" && occurrence.phase !== "claimed") continue;
				if (input.nowMs < occurrence.updatedAt) continue;
				if (occurrence.claim && occurrence.claim.leaseUntil > input.nowMs) continue;
				if (input.routineId && occurrence.routineId !== input.routineId) continue;
				if (
					eligibleOccurrences
						? !eligibleOccurrences.has(occurrenceId)
						: eligible && !eligible.has(occurrence.routineId)
				)
					continue;
				if (occurrence.target.kind === "session" && occurrence.target.parentSessionId !== input.parentSessionId)
					continue;
				if (input.parentSessionId && occurrence.parentOrigin.sessionId !== input.parentSessionId) continue;
				const definition = this.routines.get(occurrence.routineId);
				if (
					!definition ||
					definition.incarnationId !== occurrence.definition.incarnationId ||
					(!definition.enabled && occurrence.trigger.kind !== "manual")
				)
					continue;
				if (occurrence.dispatchKey || occurrence.executionRef || occurrence.result)
					throw new Error("An undispatched routine occurrence contains execution state.");
				const deadline =
					occurrence.trigger.kind === "schedule"
						? routineStartDeadline(occurrence.definition.schedule, occurrence.trigger.scheduledAt)
						: undefined;
				if (deadline !== undefined && input.nowMs > deadline) {
					this.routineOccurrences.set(
						occurrenceId,
						this.withResult(
							{ ...occurrence, phase: "terminal", updatedAt: input.nowMs },
							"cancelled",
							"Routine start window closed before dispatch; it was not run.",
							occurrence.parentOrigin.sessionId,
						),
					);
					changed = true;
					continue;
				}
				const reclaimed: RoutineOccurrence = {
					...occurrence,
					phase: "claimed",
					updatedAt: input.nowMs,
					claim: { token: randomUUID(), owner: input.owner, leaseUntil: input.nowMs + input.leaseMs },
				};
				this.routineOccurrences.set(occurrenceId, reclaimed);
				output.push(reclaimed);
			}
			let journalFull = false;
			for (const [id, stored] of this.routines) {
				if (output.length >= limit) break;
				if (!stored.enabled || (input.routineId && input.routineId !== id)) continue;
				if (eligible && !eligible.has(id)) continue;
				if (stored.target.kind === "session" && stored.target.parentSessionId !== input.parentSessionId) continue;
				// An occurrence is never older than its definition: with the clock behind the last edit, wait for it.
				if (input.nowMs < Date.parse(stored.updatedAt)) continue;
				if (stored.schedule.kind === "event") {
					const decided = input.hostEvents
						? this.decideEventRoutine(stored, input, input.hostEvents, output)
						: "unchanged";
					if (decided === "changed") changed = true;
					else if (decided === "journal-full") journalFull = true;
					continue;
				}
				const schedule = stored.schedule;
				let routine = stored;
				const rebased = rebasedRoutineCursor(
					schedule,
					stored.cursor,
					input.nowMs,
					routinePreviousSlot(schedule, stored.cursor),
				);
				if (rebased) {
					routine = {
						...stored,
						cursor: rebased,
						nextRunAt: nextRoutineAt(schedule, rebased) ?? Number.MAX_SAFE_INTEGER,
					};
					this.routines.set(id, routine);
					changed = true;
				}
				const dueAt = nextRoutineAt(schedule, routine.cursor);
				if (dueAt === undefined || dueAt > input.nowMs) continue;
				const trigger = this.latestDueTrigger(routine, dueAt, input.nowMs);
				const occurrenceId = routineOccurrenceId(routine, trigger);
				if (this.routineOccurrences.has(occurrenceId)) {
					// A restarted cursor reached a slot that already has its occurrence: that slot is consumed, never repeated.
					const cursor = routineCursorAfter(schedule, trigger.scheduledAt);
					this.routines.set(id, {
						...routine,
						cursor,
						nextRunAt: nextRoutineAt(schedule, cursor) ?? Number.MAX_SAFE_INTEGER,
					});
					changed = true;
					continue;
				}
				const parentOrigin =
					routine.target.kind === "session"
						? routine.executionSnapshot?.savedIntent.receiptOrigin
						: input.receiptOrigin;
				if (!parentOrigin || (input.parentSessionId && parentOrigin.sessionId !== input.parentSessionId)) continue;
				const deadline = routineStartDeadline(schedule, trigger.scheduledAt);
				const late = deadline !== undefined && input.nowMs > deadline;
				if (late && schedule.kind === "calendar") {
					// A slot past its lateness bound is passed over; the next run's missed count carries it.
					const cursor: RoutineCursor = {
						kind: "calendar",
						nextAt: nextCalendarSlotAfter(schedule, trigger.scheduledAt) ?? null,
						skipped: Math.min(MAX_CALENDAR_MISSED_COUNT, trigger.missedCount + 1),
					};
					const nextRunAt = nextRoutineAt(schedule, cursor) ?? Number.MAX_SAFE_INTEGER;
					this.routines.set(id, { ...routine, cursor, nextRunAt });
					changed = true;
					continue;
				}
				// Nothing is consumed without its occurrence: a full journal leaves the slot due until results are delivered.
				if (!this.routineJournalHasRoom()) {
					journalFull = true;
					continue;
				}
				const claimed = this.createClaimedOccurrence(
					routine,
					occurrenceId,
					trigger,
					input.owner,
					input.leaseMs,
					input.nowMs,
					parentOrigin,
				);
				// A one-off whose start window closed is reported once instead of run late.
				const occurrence = late
					? this.withResult(
							{ ...claimed, phase: "terminal" },
							"cancelled",
							"Routine start window closed before it could start; it was not run.",
							parentOrigin.sessionId,
						)
					: claimed;
				this.routineOccurrences.set(occurrenceId, occurrence);
				const cursor = routineCursorAfter(schedule, trigger.scheduledAt);
				const nextRunAt = nextRoutineAt(schedule, cursor) ?? Number.MAX_SAFE_INTEGER;
				this.routines.set(id, { ...withRoutineRunState(routine, occurrence), cursor, nextRunAt });
				if (late) changed = true;
				else output.push(occurrence);
			}
			if (output.length || changed) this.save();
			return { claimed: output.map((item) => structuredClone(item)), journalFull };
		});
	}

	/**
	 * Decides one event routine against its session's retained host events. At most one undispatched run exists per
	 * routine: the latest new attempt runs, older new attempts and superseded ones become its missed count. Returns
	 * whether the cursor or the journal changed, or that a new attempt stays undecided because the journal is full; a
	 * new occurrence is appended to `output`.
	 */
	private decideEventRoutine(
		routine: RoutineDefinitionView,
		input: RoutineOccurrenceClaimInput,
		feed: RoutineHostEventFeed,
		output: RoutineOccurrence[],
	): "changed" | "unchanged" | "journal-full" {
		if (routine.schedule.kind !== "event" || routine.cursor.kind !== "event") return "unchanged";
		for (const occurrence of this.routineOccurrences.values())
			if (
				occurrence.routineId === routine.routineId &&
				(occurrence.phase === "pending" || occurrence.phase === "claimed")
			)
				return "unchanged";
		const decision = decideRoutineEvents(routine.schedule, routine.cursor, feed);
		const eventTrigger = (fact: RoutineHostEventFact, missedCount: number): RoutineOccurrence["trigger"] => ({
			kind: "event",
			triggeredAt: input.nowMs,
			acceptedOrdinal: fact.acceptedOrdinal,
			missedCount,
			...(decision.cursor.historyGap ? { historyGap: true as const } : {}),
			event: fact.event,
		});
		// The same attempt is the same occurrence: journaled or tombstoned attempts never run again.
		const fresh = decision.candidates.filter((fact) => {
			const id = routineOccurrenceId(routine, eventTrigger(fact, 0));
			return !this.routineOccurrences.has(id) && !this.routineReplayTombstones.has(id);
		});
		const latest = fresh.at(-1);
		if (latest) {
			const parentOrigin = routine.executionSnapshot?.savedIntent.receiptOrigin;
			if (!parentOrigin || (input.parentSessionId && parentOrigin.sessionId !== input.parentSessionId))
				return "unchanged";
			// Without journal room the attempt stays undecided until delivered results make room.
			if (!this.routineJournalHasRoom()) return "journal-full";
			const coalesced = fresh
				.slice(0, -1)
				.filter((fact) => fact.acceptedOrdinal <= decision.cursor.throughOrdinal).length;
			const trigger = eventTrigger(
				latest,
				Math.min(MAX_ROUTINE_EVENT_MISSED_COUNT, (decision.cursor.skipped ?? 0) + coalesced),
			);
			const occurrenceId = routineOccurrenceId(routine, trigger);
			const occurrence = this.createClaimedOccurrence(
				routine,
				occurrenceId,
				trigger,
				input.owner,
				input.leaseMs,
				input.nowMs,
				parentOrigin,
			);
			this.routineOccurrences.set(occurrenceId, occurrence);
			const cursor: RoutineCursor = {
				kind: "event",
				throughOrdinal: decision.cursor.throughOrdinal,
				replayGaps: decision.cursor.replayGaps,
			};
			this.routines.set(routine.routineId, { ...withRoutineRunState(routine, occurrence), cursor });
			output.push(occurrence);
			return "changed";
		}
		if (isDeepStrictEqual(decision.cursor, routine.cursor)) return "unchanged";
		this.routines.set(routine.routineId, { ...routine, cursor: decision.cursor });
		return "changed";
	}

	claimManualRoutineOccurrence(input: {
		routineId: string;
		expectedRevision?: number;
		parentSessionId?: string;
		receiptOrigin?: WorkerReceiptOrigin;
		commandId: string;
		nowMs: number;
		owner: string;
		leaseMs: number;
	}): RoutineOccurrence {
		return this.mutate(() => {
			if (
				!Number.isSafeInteger(input.nowMs) ||
				input.nowMs < 0 ||
				input.nowMs > 8_640_000_000_000_000 ||
				!Number.isSafeInteger(input.leaseMs) ||
				input.leaseMs <= 0 ||
				!Number.isSafeInteger(input.nowMs + input.leaseMs) ||
				input.nowMs + input.leaseMs > 8_640_000_000_000_000 ||
				!input.owner ||
				input.owner.trim() !== input.owner ||
				input.owner.length > 256 ||
				input.owner.includes("\0")
			)
				throw new Error("Routine manual claim requires a valid owner, clock and lease.");
			const routine = this.routines.get(input.routineId);
			if (!routine) throw new Error("Routine does not exist.");
			if (input.expectedRevision !== undefined && input.expectedRevision !== routine.revision)
				throw new Error("Routine revision changed; read current state before retrying.");
			if (routine.target.kind === "session" && routine.target.parentSessionId !== input.parentSessionId)
				throw new Error("Routine belongs to another parent session.");
			if (input.nowMs < Date.parse(routine.updatedAt))
				throw new Error(
					`This host's clock reads earlier than the routine's last edit (${routine.updatedAt}); run it once the clock has passed that time.`,
				);
			if (
				!input.commandId ||
				input.commandId.length > MAX_ROUTINE_COMMAND_ID_CHARS ||
				input.commandId.trim() !== input.commandId ||
				input.commandId.includes("\0")
			)
				throw new Error("Routine manual command identity is invalid.");
			const trigger = { kind: "manual" as const, commandId: input.commandId, requestedAt: input.nowMs };
			const id = routineOccurrenceId(routine, trigger);
			const existing = this.routineOccurrences.get(id);
			if (existing) return structuredClone(existing);
			if (this.routineReplayTombstones.has(id))
				throw new Error(
					"This manual request was already consumed and has expired from the bounded replay journal.",
				);
			const origin =
				routine.target.kind === "session"
					? routine.executionSnapshot?.savedIntent.receiptOrigin
					: input.receiptOrigin;
			if (!origin || (input.parentSessionId && origin.sessionId !== input.parentSessionId))
				throw new Error("Routine parent receipt origin is unavailable.");
			const occurrence = this.createClaimedOccurrence(
				routine,
				id,
				trigger,
				input.owner,
				input.leaseMs,
				input.nowMs,
				origin,
			);
			this.routineOccurrences.set(id, occurrence);
			this.routines.set(routine.routineId, withRoutineRunState(routine, occurrence));
			this.save();
			return structuredClone(occurrence);
		});
	}

	listRoutineOccurrences(filter: RoutineOccurrenceListFilter = {}): RoutineOccurrence[] {
		return Array.from(this.routineOccurrences.values())
			.filter(
				(item) =>
					(!filter.routineId || item.routineId === filter.routineId) &&
					(!filter.parentSessionId || item.parentOrigin.sessionId === filter.parentSessionId) &&
					(!filter.phases || filter.phases.includes(item.phase)),
			)
			.sort((a, b) => a.createdAt - b.createdAt)
			.slice(-Math.max(1, Math.min(filter.limit ?? MAX_ROUTINE_OCCURRENCES, MAX_ROUTINE_OCCURRENCES)))
			.map((item) => structuredClone(item));
	}

	markRoutineDispatching(input: {
		occurrenceId: string;
		claimToken: string;
		dispatchKey: string;
		nowMs: number;
	}): void {
		this.updateClaimedOccurrence(input, (item) => ({
			...item,
			phase: "dispatching",
			dispatchKey: input.dispatchKey,
			updatedAt: input.nowMs,
		}));
	}
	/** Release only a dispatch that the native executor explicitly declined before admission. */
	deferRoutineOccurrence(input: { occurrenceId: string; claimToken: string; nowMs: number }): void {
		this.updateClaimedOccurrence(input, (item) => {
			if (item.phase !== "dispatching" || item.executionRef || item.result)
				throw new Error("Only an unadmitted routine dispatch can return to pending.");
			const definition = this.routines.get(item.routineId);
			if (
				!definition ||
				definition.incarnationId !== item.definition.incarnationId ||
				(!definition.enabled && item.definition.enabled)
			)
				return this.withResult(
					{ ...item, phase: "terminal", updatedAt: input.nowMs },
					"cancelled",
					"Routine was paused or deleted before dispatch.",
					item.parentOrigin.sessionId,
				);
			const { claim: _claim, dispatchKey: _dispatchKey, ...pending } = item;
			return { ...pending, phase: "pending", updatedAt: input.nowMs };
		});
	}

	markRoutineRunning(input: {
		occurrenceId: string;
		claimToken: string;
		dispatchKey: string;
		nowMs: number;
		executionRef?: { taskId: string; attemptId: string };
	}): void {
		this.updateClaimedOccurrence(input, (item) => {
			if ((item.phase !== "dispatching" && item.phase !== "running") || item.dispatchKey !== input.dispatchKey)
				throw new Error("Routine dispatch transition is stale.");
			return {
				...item,
				phase: "running",
				...(input.executionRef ? { executionRef: input.executionRef } : {}),
				updatedAt: input.nowMs,
			};
		});
	}
	markRoutineUncertain(input: {
		occurrenceId: string;
		claimToken: string;
		reason: string;
		recipient: string;
		nowMs: number;
	}): void {
		const reason = input.reason.trim().slice(0, MAX_ROUTINE_SUMMARY_CHARS);
		if (!reason) throw new Error("Routine uncertainty requires a bounded reason.");
		this.updateClaimedOccurrence(input, (item) =>
			this.withResult(
				{ ...item, phase: "uncertain", uncertainty: reason, updatedAt: input.nowMs },
				"uncertain",
				reason,
				input.recipient,
			),
		);
	}
	finishRoutineOccurrence(input: {
		occurrenceId: string;
		claimToken: string;
		outcome: RoutineTerminalOutcome;
		summary: string;
		recipient: string;
		nowMs: number;
		ownerUpdate?: "none";
	}): void {
		const summary = input.summary.trim().slice(0, MAX_ROUTINE_SUMMARY_CHARS) || "No summary was provided.";
		this.updateClaimedOccurrence(input, (item) =>
			this.withResult(
				{
					...item,
					phase: input.outcome === "uncertain" ? "uncertain" : "terminal",
					...(input.outcome === "uncertain" ? { uncertainty: summary } : {}),
					updatedAt: input.nowMs,
				},
				input.outcome,
				summary,
				input.recipient,
				input.ownerUpdate,
			),
		);
	}

	resolveUncertainRoutineOccurrence(input: {
		occurrenceId: string;
		claimToken: string;
		dispatchKey: string;
		executionRef: { taskId: string; attemptId: string };
		outcome: Exclude<RoutineTerminalOutcome, "uncertain">;
		summary: string;
		recipient: string;
		nowMs: number;
	}): void {
		this.mutate(() => {
			const current = this.routineOccurrences.get(input.occurrenceId);
			const summary = input.summary.trim().slice(0, MAX_ROUTINE_SUMMARY_CHARS) || "No summary was provided.";
			const resolutionDigest = routineResultDigest(input.outcome, summary, input.recipient);
			if (
				current?.phase === "terminal" &&
				current.claim?.token === input.claimToken &&
				current.dispatchKey === input.dispatchKey &&
				current.result?.outcome === input.outcome &&
				current.result.digest === resolutionDigest &&
				current.result.summary === summary &&
				current.result.recipient === input.recipient &&
				current.executionRef?.taskId === input.executionRef.taskId &&
				current.executionRef.attemptId === input.executionRef.attemptId
			)
				return;
			if (
				current?.phase !== "uncertain" ||
				current.claim?.token !== input.claimToken ||
				current.dispatchKey !== input.dispatchKey ||
				current.result?.outcome !== "uncertain" ||
				input.recipient !== current.parentOrigin.sessionId ||
				!Number.isSafeInteger(input.nowMs) ||
				input.nowMs < current.updatedAt ||
				(current.executionRef && current.executionRef.taskId !== input.executionRef.taskId)
			)
				throw new Error("Routine uncertainty resolution is stale or does not match the admitted worker attempt.");
			if (current.priorUncertaintyResult) throw new Error("Routine uncertainty already has a retained resolution.");
			const resolution = {
				outcome: input.outcome,
				summary,
				digest: resolutionDigest,
				delivery: "pending" as const,
				recipient: input.recipient,
			};
			const { uncertainty: _uncertainty, ...resolvedBase } = current;
			const next: RoutineOccurrence = {
				...resolvedBase,
				phase: "terminal",
				executionRef: input.executionRef,
				priorUncertaintyResult: current.result,
				result: resolution,
				updatedAt: input.nowMs,
			};
			if (!parseRoutineOccurrence(next))
				throw new Error("Routine uncertainty resolution would produce invalid durable state.");
			this.routineOccurrences.set(next.occurrenceId, next);
			this.save();
		});
	}

	listPendingRoutineDeliveries(parentSessionId: string, limit: number): RoutineDelivery[] {
		const deliveries: RoutineDelivery[] = [];
		for (const occurrence of this.routineOccurrences.values()) {
			if (
				occurrence.priorUncertaintyResult?.delivery === "pending" &&
				occurrence.priorUncertaintyResult.recipient === parentSessionId
			)
				deliveries.push({
					occurrence: structuredClone(occurrence),
					result: structuredClone(occurrence.priorUncertaintyResult),
				});
			if (occurrence.result?.delivery === "pending" && occurrence.result.recipient === parentSessionId)
				deliveries.push({ occurrence: structuredClone(occurrence), result: structuredClone(occurrence.result) });
		}
		return deliveries
			.sort((a, b) => a.occurrence.createdAt - b.occurrence.createdAt)
			.slice(0, Math.max(1, Math.min(limit, MAX_ROUTINE_OCCURRENCES * 2)));
	}
	acknowledgeRoutineDelivery(input: {
		occurrenceId: string;
		recipient: string;
		resultDigest: string;
		deliveryMarker: string;
		nowMs: number;
	}): void {
		this.mutate(() => {
			const item = this.routineOccurrences.get(input.occurrenceId);
			if (!item || item.parentOrigin.sessionId !== input.recipient)
				throw new Error("Routine delivery acknowledgement is stale.");
			if (
				!input.deliveryMarker ||
				input.deliveryMarker.trim() !== input.deliveryMarker ||
				input.deliveryMarker.length > 256 ||
				input.deliveryMarker.includes("\0")
			)
				throw new Error("Routine delivery marker is invalid.");
			if (
				(item.result?.delivery === "acknowledged" &&
					item.result.digest === input.resultDigest &&
					item.result.recipient === input.recipient &&
					item.result.deliveryMarker === input.deliveryMarker) ||
				(item.priorUncertaintyResult?.delivery === "acknowledged" &&
					item.priorUncertaintyResult.digest === input.resultDigest &&
					item.priorUncertaintyResult.recipient === input.recipient &&
					item.priorUncertaintyResult.deliveryMarker === input.deliveryMarker)
			)
				return;
			if (!Number.isSafeInteger(input.nowMs) || input.nowMs < item.updatedAt || input.nowMs > 8_640_000_000_000_000)
				throw new Error("Routine delivery acknowledgement time is invalid.");
			const acknowledge = (result: NonNullable<RoutineOccurrence["result"]>) =>
				result.delivery === "pending" &&
				result.recipient === input.recipient &&
				result.digest === input.resultDigest
					? { ...result, delivery: "acknowledged" as const, deliveryMarker: input.deliveryMarker }
					: result;
			const latest = item.result ? acknowledge(item.result) : undefined;
			const prior = item.priorUncertaintyResult ? acknowledge(item.priorUncertaintyResult) : undefined;
			if (latest === item.result && prior === item.priorUncertaintyResult)
				throw new Error("Routine delivery acknowledgement is stale.");
			const updated: RoutineOccurrence = {
				...item,
				...(latest ? { result: latest } : {}),
				...(prior ? { priorUncertaintyResult: prior } : {}),
				updatedAt: input.nowMs,
			};
			if (!parseRoutineOccurrence(updated))
				throw new Error("Routine delivery acknowledgement would produce invalid durable state.");
			this.routineOccurrences.set(item.occurrenceId, updated);
			this.save();
		});
	}

	acknowledgeBotInbox(agentId: string, readAt = Date.now()): PersistentBotRecord | undefined {
		const normId = normalizeBotOrTeamId(agentId, "agentId");
		const current = this.bots.get(normId);
		if (!current) return undefined;
		if ((current.lastReadAt ?? 0) >= (current.lastMessageAt ?? 0)) return { ...current };
		return this.mutate(() => {
			const bot = this.bots.get(normId);
			if (!bot) return undefined;
			const updated: PersistentBotRecord = {
				...bot,
				lastReadAt: Math.max(readAt, bot.lastMessageAt ?? 0),
			};
			this.bots.set(normId, updated);
			this.save();
			return { ...updated };
		});
	}

	acknowledgeTeamInbox(teamId: string, readAt = Date.now()): PersistentTeamRecord | undefined {
		const normId = normalizeBotOrTeamId(teamId, "teamId");
		const current = this.teams.get(normId);
		if (!current) return undefined;
		if (this.computeTeamUnreadCount(current) === 0) {
			return {
				...current,
				memberAgentIds: [...current.memberAgentIds],
				unreadCount: 0,
				memoryFilePath: this.getTeamMemoryFilePath(normId),
			};
		}
		return this.mutate(() => {
			const team = this.teams.get(normId);
			if (!team) return undefined;
			const updated: PersistentTeamRecord = {
				...team,
				lastReadAt: Math.max(readAt, team.lastMessageAt ?? 0),
			};
			this.teams.set(normId, updated);
			this.save();
			return {
				...updated,
				memberAgentIds: [...updated.memberAgentIds],
				unreadCount: 0,
				memoryFilePath: this.getTeamMemoryFilePath(normId),
			};
		});
	}

	acknowledgeAllInboxes(readAt = Date.now()): number {
		return this.mutate(() => {
			let cleared = 0;
			for (const [id, bot] of this.bots.entries()) {
				if ((bot.lastMessageAt ?? 0) > (bot.lastReadAt ?? 0)) {
					this.bots.set(id, { ...bot, lastReadAt: Math.max(readAt, bot.lastMessageAt ?? 0) });
					cleared++;
				}
			}
			for (const [id, team] of this.teams.entries()) {
				if (this.computeTeamUnreadCount(team) > 0) {
					this.teams.set(id, { ...team, lastReadAt: Math.max(readAt, team.lastMessageAt ?? 0) });
					cleared++;
				}
			}
			if (cleared > 0) this.save();
			return cleared;
		});
	}

	listBotInbox(agentId: string, limit = 20): PersistentBotInboxEntry[] {
		const normId = normalizeBotOrTeamId(agentId, "agentId");
		return collectBotInboxEntries(normId, this.bots.get(normId), this.teams.values(), this.teamMessages, limit);
	}

	listTeamInbox(teamId: string, limit = 20): PersistentBotInboxEntry[] {
		const normId = normalizeBotOrTeamId(teamId, "teamId");
		const team = this.teams.get(normId);
		if (!team) return [];
		const entries = collectTeamInboxEntries(team, this.teamMessages.get(normId) ?? [], team.lastReadAt ?? 0);
		entries.sort((a, b) => b.timestamp - a.timestamp);
		return entries.slice(0, Math.max(1, limit));
	}

	getStoreFilePath(): string {
		return this.filePath;
	}

	getDaemonStatus(nowMs = Date.now()): PersistentBotDaemonStatus {
		return readDaemonLeaseStatus(this.filePath, this.routines.values(), nowMs);
	}

	/** Takes the detached daemon's lease for a daemon about to start with `token`; false while another holds it. */
	claimDaemonLease(token: string, nowMs = Date.now()): boolean {
		return claimDaemonLeaseFile(this.filePath, token, nowMs);
	}

	/** Records the pid of the process spawned for `token`; display only (it may be a launcher wrapper, never probed). */
	recordDaemonLaunchPid(token: string, launcherPid: number): void {
		recordDaemonLaunchPidFile(this.filePath, token, launcherPid);
	}

	/** The daemon's renewal with its own process identity; false once its lease was released or taken. */
	renewDaemonLease(token: string, owner: ProcessOwner, nowMs = Date.now()): boolean {
		return renewDaemonLeaseFile(this.filePath, token, owner, nowMs);
	}

	daemonLeaseBelongsTo(token: string): boolean {
		return daemonLeaseBelongsTo(this.filePath, token);
	}

	/** Releases the daemon's lease (only `token`'s, when given); its daemon exits on observing the release. */
	releaseDaemonLease(token?: string, nowMs = Date.now()): DaemonLeaseRelease {
		return releaseDaemonLeaseFile(this.filePath, token, nowMs);
	}

	/** Releases a first-generation `pi --bot-daemon` lease in the old lease file; that daemon exits on observing it. */
	releaseLegacyTokenDaemonLease(nowMs = Date.now()): DaemonLeaseRelease {
		return releaseLegacyTokenDaemonLeaseFile(this.filePath, nowMs);
	}

	/**
	 * Rewrites the store in the current shape when the file still exposes the version-1 `routines` key, which is the
	 * only shape an inline-script daemon of an earlier build writes to. True when a rewrite was needed. A store already
	 * loaded in the current shape takes no lock; every save and every daemon tick reseal it anyway.
	 */
	sealRoutinesAgainstLegacyWriters(): boolean {
		if (!this.legacyRoutinesExposed) return false;
		return this.mutate(() => {
			if (!this.legacyRoutinesExposed) return false;
			this.save();
			return true;
		});
	}

	/**
	 * The detached daemon's tick for bot and team routines: every enabled due one not yet marked queued is marked
	 * queued, its bot's summary updated or its team handed the routine prompt as a brain message, all in one locked
	 * transaction over the shared store. The daemon runs no model, so it never consumes a due routine: `nextRunAt` stays
	 * put and the next session's scheduler claims it (`claimDueRoutinesInMap`), which dispatches it and moves `nextRunAt`
	 * forward. Advancing it here made that claim skip the routine, so a routine queued by the daemon was never
	 * dispatched. Session routines are never marked: their occurrence journal is their only run state, and the session
	 * scheduler that owns them claims them through it. Only run state changes; the admitted definition (`updatedAt`
	 * included) is the revision's and every occurrence copies it. A store an older build rewrote in the version-1 shape
	 * is resealed in the same transaction.
	 */
	queueDueRoutinesForDaemon(nowMs = Date.now()): number {
		return this.mutate(() => {
			const nowIso = new Date(nowMs).toISOString();
			let queued = 0;
			for (const routine of [...this.routines.values()]) {
				if (
					routine.target.kind === "session" ||
					!routine.enabled ||
					routine.nextRunAt > nowMs ||
					routine.lastStatus === "queued"
				)
					continue;
				const summary = `[Daemon ${nowIso}] Routine queued across TUI session: ${routine.prompt.slice(0, 160)}`;
				this.routines.set(routine.routineId, { ...routine, lastStatus: "queued", lastSummary: summary });
				queued++;
				if (routine.target.kind === "bot") {
					const bot = this.bots.get(routine.target.agentId);
					if (bot)
						this.bots.set(bot.agentId, { ...bot, lastMessageAt: nowMs, lastSummary: summary, updatedAt: nowIso });
				} else if (routine.target.kind === "team") {
					this.recordTeamMessage({
						messageId: `daemon-${routine.routineId}-${nowMs}`,
						teamId: routine.target.teamId,
						sender: { kind: "brain" },
						text: `[Scheduled routine ${routine.routineId}]: ${routine.prompt}`,
						timestamp: nowMs,
						targetAgentIds: [],
						deliveries: [],
					});
				}
			}
			if (queued > 0 || this.legacyRoutinesExposed) this.save();
			return queued;
		});
	}

	appendTeamMessage(message: PersistentTeamMessage): void {
		this.mutate(() => {
			this.recordTeamMessage(message);
		});
	}

	appendScopedTeamMessage(message: PersistentTeamMessage, incarnationId: string): void {
		this.mutate(() => {
			const team = this.teams.get(message.teamId);
			if (!team || teamIncarnation(team) !== incarnationId)
				throw new Error("Group was deleted or replaced before message publication.");
			this.recordTeamMessage(message);
		});
	}

	/** Adds a message to the loaded state and saves. The caller has re-read the file: re-reading here would reset what it is iterating. */
	private recordTeamMessage(message: PersistentTeamMessage): void {
		const teamId = normalizeBotOrTeamId(message.teamId, "teamId");
		const messages = this.teamMessages.get(teamId) ?? [];
		const existing = messages.find((entry) => entry.messageId === message.messageId);
		if (existing) {
			if (
				JSON.stringify([existing.sender, existing.text, existing.targetAgentIds]) !==
				JSON.stringify([message.sender, message.text, message.targetAgentIds])
			)
				throw new Error("Group message identity conflicts with its recorded content.");
			return;
		}
		const team = this.teams.get(teamId);
		messages.push(structuredClone({ ...message, ...(team ? { teamIncarnationId: teamIncarnation(team) } : {}) }));
		if (messages.length > MAX_TEAM_MESSAGES_PER_TEAM) {
			this.teamMessages.set(teamId, messages.slice(-MAX_TEAM_MESSAGES_PER_TEAM));
		} else {
			this.teamMessages.set(teamId, messages);
		}
		if (team) {
			this.teams.set(teamId, {
				...team,
				lastMessageAt: message.timestamp,
				updatedAt: new Date(message.timestamp).toISOString(),
			});
		}
		this.save();
	}

	getBotMemoryFilePath(agentId: string): string {
		return join(this.agentDir, "memory", "bots", `${normalizeBotOrTeamId(agentId, "agentId")}.md`);
	}

	getTeamMemoryFilePath(teamId: string): string {
		const id = normalizeBotOrTeamId(teamId, "teamId");
		const team = this.teams.get(id);
		const incarnation = team ? teamIncarnation(team) : undefined;
		const suffix = incarnation ? `--${incarnation}` : "";
		return join(this.agentDir, "memory", "teams", `${id}${suffix}.md`);
	}

	ensureBotMemoryFile(agentId: string): string {
		const normId = normalizeBotOrTeamId(agentId, "agentId");
		const filePath = this.getBotMemoryFilePath(normId);
		if (!existsSync(filePath)) {
			mkdirSync(dirname(filePath), { recursive: true });
			const bot = this.bots.get(normId);
			const displayName = bot?.displayName ?? normId;
			const model = bot ? `${bot.provider}/${bot.modelId}` : "anthropic/claude-haiku-5-5";
			const header = `# Bot Memory: ${displayName} (${normId})\n\n- Model: ${model}\n\n## Continuity & Notes\n`;
			createMemoryHeader(filePath, header);
		}
		return filePath;
	}

	ensureTeamMemoryFile(teamId: string): string {
		const normId = normalizeBotOrTeamId(teamId, "teamId");
		const filePath = this.getTeamMemoryFilePath(normId);
		if (!existsSync(filePath)) {
			mkdirSync(dirname(filePath), { recursive: true });
			const team = this.teams.get(normId);
			const name = team?.name ?? normId;
			const members = team?.memberAgentIds.join(", ") || "none";
			const mission = team?.description || "collaborative agent team";
			const header = `# Team Blackboard: ${name} (${normId})\n\n- Members: ${members}\n- Mission: ${mission}\n\n## Shared Findings & Decisions\n`;
			createMemoryHeader(filePath, header);
		}
		return filePath;
	}

	recordBotTurnOutcome(input: {
		agentId: string;
		summary: string;
		transcriptRef?: string;
		timestamp?: number;
		teamId?: string;
		teamIncarnationId?: string;
	}): void {
		this.mutate(() => {
			const normId = normalizeBotOrTeamId(input.agentId, "agentId");
			const bot = this.bots.get(normId);
			const team = input.teamId ? this.teams.get(input.teamId) : undefined;
			if (input.teamId && (!team || teamIncarnation(team) !== input.teamIncarnationId)) return;
			if (!bot && !team) {
				return;
			}

			const timestamp = input.timestamp ?? Date.now();
			const iso = new Date(timestamp).toISOString();
			const oneLineSummary = input.summary
				.trim()
				.replace(/\r?\n+/g, " ")
				.slice(0, 300);

			if (bot && !input.teamId) {
				const updatedBot: PersistentBotRecord = {
					...bot,
					lastSummary: input.summary.trim().slice(0, 400),
					lastTranscriptRef: input.transcriptRef ?? bot.lastTranscriptRef,
					lastMessageAt: timestamp,
					updatedAt: iso,
				};
				this.bots.set(normId, updatedBot);
				this.save();
			}

			if (!input.teamId) {
				this.ensureBotMemoryFile(normId);
				const botFile = this.getBotMemoryFilePath(normId);
				const refSuffix = input.transcriptRef ? ` (${input.transcriptRef})` : "";
				appendBoundedFile(botFile, `- [${iso}] ${oneLineSummary}${refSuffix}`, 80);
			}

			if (team) {
				const teamMsg: PersistentTeamMessage = {
					messageId: `team-msg-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
					teamId: team.teamId,
					sender: { kind: "bot", agentId: normId },
					text: input.summary.slice(0, 600),
					timestamp,
					targetAgentIds: [],
					deliveries: [],
				};
				this.recordTeamMessage(teamMsg);
				this.ensureTeamMemoryFile(team.teamId);
				const teamFile = this.getTeamMemoryFilePath(team.teamId);
				appendBoundedFile(teamFile, `- [${iso}] **${normId}**: ${oneLineSummary}`, 80);
			}
		});
	}

	composeBotUnifiedMemoryContext(
		agentId: string,
		teamId?: string,
		teamIncarnationId?: string,
	): {
		promptBlock: string;
		memoryDir: string;
		memoryFiles: string[];
	} {
		const normId = normalizeBotOrTeamId(agentId, "agentId");
		const memoryDir = join(this.agentDir, "memory");
		const memoryFiles: string[] = [];

		const botMemoryPath = this.getBotMemoryFilePath(normId);
		if (!teamId) memoryFiles.push(botMemoryPath);

		let botExcerpt = "";
		if (!teamId && existsSync(botMemoryPath)) {
			try {
				const content = readFileSync(botMemoryPath, "utf8").trim();
				botExcerpt = content.length > 1200 ? content.slice(-1200) : content;
			} catch {
				botExcerpt = "";
			}
		}

		const bot = this.bots.get(normId);
		const selectedTeam = teamId ? this.teams.get(teamId) : undefined;
		if (
			teamId &&
			(!selectedTeam ||
				teamIncarnation(selectedTeam) !== teamIncarnationId ||
				!selectedTeam.memberAgentIds.includes(normId))
		)
			throw new Error("Bot is not a member of this group generation.");
		const memberTeams: PersistentTeamRecord[] = [];
		const teamMemoryExcerpts: string[] = [];
		const allRecentTeamMessages: PersistentTeamMessage[] = [];

		for (const team of this.teams.values()) {
			if (team.teamId === teamId) {
				memberTeams.push(team);
				const teamPath = this.getTeamMemoryFilePath(team.teamId);
				memoryFiles.push(teamPath);
				if (existsSync(teamPath)) {
					try {
						const teamContent = readFileSync(teamPath, "utf8").trim();
						const excerpt = teamContent.length > 1200 ? teamContent.slice(-1200) : teamContent;
						teamMemoryExcerpts.push(`### Team Blackboard [${team.teamId}]:\n${excerpt}`);
					} catch {
						// Ignore unreadable team memory file
					}
				}
				const msgs = this.listTeamMessages(team.teamId)
					.filter((message) => message.teamIncarnationId === teamIncarnation(team))
					.slice(-5);
				allRecentTeamMessages.push(...msgs);
			}
		}

		allRecentTeamMessages.sort((a, b) => a.timestamp - b.timestamp);
		const recent5TeamMsgs = allRecentTeamMessages.slice(-5);

		const lines: string[] = [
			BOT_MEMORY_BLOCK_HEADER,
			`You are persistent bot "${normId}". You have persistent memory files you can read; the host appends a line to them from each report you finish.`,
			...(teamId
				? [`- Group: ${teamId}. This conversation and its messages belong only to this group.`]
				: [`- Bot memory file: ${botMemoryPath}`]),
		];

		if (memberTeams.length > 0) {
			lines.push(
				`- Member of teams: ${memberTeams.map((t) => `${t.name ?? t.teamId} (${this.getTeamMemoryFilePath(t.teamId)})`).join(", ")}`,
			);
		}
		if (!teamId && bot?.lastTranscriptRef) {
			lines.push(`- Prior transcript reference: ${bot.lastTranscriptRef}`);
		}
		if (!teamId && bot?.lastSummary) {
			lines.push(`- Prior turn summary: ${bot.lastSummary}`);
		}

		if (botExcerpt.length > 0) {
			lines.push(`\n#### Your Memory Blackboard Excerpt:\n${botExcerpt}`);
		}

		if (teamMemoryExcerpts.length > 0) {
			lines.push(`\n#### Team Blackboards:\n${teamMemoryExcerpts.join("\n\n")}`);
		}

		if (recent5TeamMsgs.length > 0) {
			lines.push(
				"\n#### Recent Team Activity:\n" +
					recent5TeamMsgs
						.map((m) => {
							const sender = m.sender.kind === "bot" ? m.sender.agentId : m.sender.kind;
							return `- [${new Date(m.timestamp).toISOString()}] **${sender}**: ${m.text}`;
						})
						.join("\n"),
			);
		}

		lines.push(
			"\nRead your memory blackboard and your team blackboards for continuity; they are outside your workspace, so you cannot edit them. Put what should be remembered in your final report. You can also use `zoom` to inspect root <chat> message IDs if needed.",
		);

		return {
			promptBlock: lines.join("\n"),
			memoryDir,
			memoryFiles,
		};
	}

	listTeamMessages(teamId: string, limit?: number): PersistentTeamMessage[] {
		const messages = this.teamMessages.get(teamId.trim()) ?? [];
		if (limit !== undefined && limit > 0) {
			return structuredClone(messages.slice(-limit));
		}
		return structuredClone(messages);
	}

	projectBotViews(
		liveAgents: readonly WorkerAgentView[],
		laneRecords: readonly LaneRecord[],
		defaultModelRef: string,
		includeDirectContinuity = true,
	): PersistentBotView[] {
		const workerLanes = laneRecords.filter((lane) => lane.type === "worker" || lane.type === "managed-worker");

		const laneByAgentId = new Map<string, LaneRecord>();
		for (const lane of workerLanes) {
			const id = lane.agentId ?? lane.laneId;
			const existing = laneByAgentId.get(id);
			if (!existing) {
				laneByAgentId.set(id, lane);
			} else if (lane.status === "running") {
				laneByAgentId.set(id, lane);
			} else if (lane.status === "queued" && existing.status !== "running") {
				laneByAgentId.set(id, lane);
			} else if (existing.status !== "running" && existing.status !== "queued") {
				const existingTs = existing.completedAt ?? existing.startedAt ?? existing.queuedAt ?? "";
				const laneTs = lane.completedAt ?? lane.startedAt ?? lane.queuedAt ?? "";
				if (laneTs >= existingTs) {
					laneByAgentId.set(id, lane);
				}
			}
		}

		const liveAgentById = new Map<string, WorkerAgentView>();
		for (const agent of liveAgents) {
			liveAgentById.set(agent.agentId, agent);
		}

		const allAgentIds = new Set<string>();
		for (const botId of this.bots.keys()) {
			allAgentIds.add(botId);
		}
		for (const agentId of liveAgentById.keys()) {
			allAgentIds.add(agentId);
		}
		for (const agentId of laneByAgentId.keys()) {
			allAgentIds.add(agentId);
		}

		const views: PersistentBotView[] = [];

		for (const agentId of allAgentIds) {
			const storedBot = this.bots.get(agentId);
			const botRecord =
				storedBot && !includeDirectContinuity
					? { ...storedBot, lastSummary: undefined, lastTranscriptRef: undefined }
					: storedBot;
			const liveAgent = liveAgentById.get(agentId);
			const lane = laneByAgentId.get(agentId);

			let state: PersistentBotLiveState;
			if (
				liveAgent?.dispatch === "running" ||
				lane?.status === "running" ||
				(liveAgent?.activity === "active" && liveAgent.dispatch !== "queued")
			) {
				state = "running";
			} else if (liveAgent?.dispatch === "queued" || lane?.status === "queued") {
				state = "queued";
			} else if (botRecord?.retired || liveAgent?.status === "retired") {
				state = "retired";
			} else if (liveAgent?.awaitingParent) {
				state = "awaiting_parent";
			} else if (liveAgent?.lastResult?.status === "failed" || lane?.status === "failed") {
				state = "failed";
			} else {
				state = "idle";
			}

			const modelRef =
				liveAgent?.modelRef ??
				lane?.modelRef ??
				(botRecord ? `${botRecord.provider}/${botRecord.modelId}` : defaultModelRef);
			const { provider, modelId } = parseModelRef(modelRef);

			const displayName = botRecord?.displayName ?? lane?.label ?? liveAgent?.agentId ?? agentId;
			const description = botRecord?.description;
			const thinkingLevel =
				lane?.thinkingLevel !== undefined ? String(lane.thinkingLevel) : botRecord?.thinkingLevel;
			const soul = botRecord?.soul;
			const profileId = botRecord?.profileId ?? lane?.profileId;

			const currentTaskId = liveAgent?.attemptId ?? lane?.attemptId ?? lane?.laneId;
			const currentSummary =
				liveAgent?.waitReason ??
				lane?.label ??
				lane?.reasonCode ??
				liveAgent?.lastResult?.reasonCode ??
				botRecord?.lastSummary;

			const teamIds: string[] = [];
			for (const team of this.teams.values()) {
				if (team.memberAgentIds.includes(agentId)) {
					teamIds.push(team.teamId);
				}
			}

			const persistent = botRecord !== undefined;
			const controllable = liveAgent?.controllable ?? !botRecord?.retired;

			const updatedAt =
				liveAgent?.updatedAt ??
				lane?.completedAt ??
				lane?.startedAt ??
				lane?.queuedAt ??
				botRecord?.updatedAt ??
				new Date().toISOString();

			const unreadCount =
				(botRecord?.lastMessageAt ?? 0) > (botRecord?.lastReadAt ?? 0) && Boolean(botRecord?.lastSummary) ? 1 : 0;
			const routineCount = Array.from(this.routines.values()).filter(
				(r) =>
					r.enabled &&
					((r.target.kind === "bot" && r.target.agentId === agentId) ||
						(r.target.kind === "team" && teamIds.includes(r.target.teamId))),
			).length;

			views.push({
				agentId,
				displayName,
				description,
				provider,
				modelId,
				modelRef,
				thinkingLevel,
				soul,
				profileId,
				state,
				currentTaskId,
				currentSummary,
				teamIds,
				persistent,
				controllable,
				updatedAt,
				lastTranscriptRef: botRecord?.lastTranscriptRef,
				lastSummary: botRecord?.lastSummary,
				lastMessageAt: botRecord?.lastMessageAt,
				lastReadAt: botRecord?.lastReadAt,
				unreadCount,
				routineCount,
				memoryFilePath: this.getBotMemoryFilePath(agentId),
			});
		}

		views.sort((a, b) => {
			const aActive = a.state === "running" || a.state === "queued";
			const bActive = b.state === "running" || b.state === "queued";
			if (aActive !== bActive) {
				return aActive ? -1 : 1;
			}
			if (a.persistent !== b.persistent) {
				return a.persistent ? -1 : 1;
			}
			return b.updatedAt.localeCompare(a.updatedAt);
		});

		return views;
	}
}
