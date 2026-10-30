import { createHash, randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { botTeamStoreFile } from "../agent-paths.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isRecordObject } from "../util/value-guards.ts";
import type { WorkerAgentView } from "./worker-agent-control.ts";

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
	readonly instructions?: string;
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
	readonly agentId: string;
	readonly displayName: string;
	readonly description?: string;
	readonly provider: string;
	readonly modelId: string;
	readonly modelRef: string;
	readonly thinkingLevel?: string;
	readonly instructions?: string;
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
	readonly instructions?: string;
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

export type PersistentRoutineTarget =
	| { readonly kind: "bot"; readonly agentId: string }
	| { readonly kind: "team"; readonly teamId: string };

export interface PersistentRoutineScheduleRecord {
	readonly routineId: string;
	readonly target: PersistentRoutineTarget;
	readonly prompt: string;
	readonly intervalMs: number;
	readonly enabled: boolean;
	readonly nextRunAt: number;
	readonly lastRunAt?: number;
	readonly lastStatus?: "queued" | "running" | "succeeded" | "failed";
	readonly lastSummary?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface UpsertPersistentRoutineInput {
	readonly routineId: string;
	readonly target: PersistentRoutineTarget;
	readonly prompt: string;
	readonly intervalMs: number;
	readonly enabled?: boolean;
	readonly nextRunAt?: number;
}

export interface PersistentBotInboxEntry {
	readonly id: string;
	readonly kind: "bot" | "team";
	readonly targetId: string;
	readonly sender: string;
	readonly text: string;
	readonly timestamp: number;
	readonly unread: boolean;
}

export interface PersistentBotDaemonStatus {
	readonly running: boolean;
	readonly pid?: number;
	readonly startedAt?: string;
	readonly lastHeartbeatAt?: number;
	readonly lastTickAt?: number;
	readonly activeRoutines: number;
	readonly dueRoutines: number;
}

const MIN_ROUTINE_INTERVAL_MS = 10_000;
const DAEMON_STALE_MS = 60_000;

export function parseDurationIntervalMs(raw: string): number {
	const trimmed = raw.trim().toLowerCase();
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/u.exec(trimmed);
	if (!match) {
		throw new Error(`Invalid schedule interval "${raw}". Expected e.g. 30s, 5m, 1h, 1d.`);
	}
	const amount = Number.parseFloat(match[1]!);
	const unit = match[2] ?? "s";
	const multiplier =
		unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
	const ms = Math.round(amount * multiplier);
	if (!Number.isFinite(ms) || ms < MIN_ROUTINE_INTERVAL_MS) {
		throw new Error(`Schedule interval must be at least ${MIN_ROUTINE_INTERVAL_MS / 1000}s.`);
	}
	return ms;
}

export function formatDurationIntervalMs(intervalMs: number): string {
	if (intervalMs % 86_400_000 === 0) return `${intervalMs / 86_400_000}d`;
	if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
	if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
	if (intervalMs % 1000 === 0) return `${intervalMs / 1000}s`;
	return `${intervalMs}ms`;
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
	const at = text.indexOf(`${BOT_MEMORY_BLOCK_SEPARATOR}${BOT_MEMORY_BLOCK_HEADER}`);
	return at < 0 ? text : text.slice(0, at);
}

/** What the operator typed, from a user message of a bot's conversation: without the host's task wrapper, control header and memory block. */
export function operatorTextOf(text: string): string {
	let shown = withoutBotMemoryBlock(text);
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
		instructions,
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
		instructions: typeof instructions === "string" ? instructions : undefined,
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

function parseRoutineRecord(value: unknown): PersistentRoutineScheduleRecord | undefined {
	if (!isRecordObject(value)) return undefined;
	const {
		routineId,
		target,
		prompt,
		intervalMs,
		enabled,
		nextRunAt,
		lastRunAt,
		lastStatus,
		lastSummary,
		createdAt,
		updatedAt,
	} = value;
	if (
		typeof routineId !== "string" ||
		!BOT_OR_TEAM_ID_REGEX.test(routineId) ||
		typeof prompt !== "string" ||
		prompt.trim().length === 0 ||
		typeof intervalMs !== "number" ||
		!Number.isFinite(intervalMs) ||
		intervalMs < MIN_ROUTINE_INTERVAL_MS ||
		typeof nextRunAt !== "number" ||
		!Number.isFinite(nextRunAt) ||
		typeof createdAt !== "string" ||
		typeof updatedAt !== "string" ||
		!isRecordObject(target)
	) {
		return undefined;
	}
	let parsedTarget: PersistentRoutineTarget | undefined;
	if (target.kind === "bot" && typeof target.agentId === "string" && BOT_OR_TEAM_ID_REGEX.test(target.agentId)) {
		parsedTarget = { kind: "bot", agentId: target.agentId };
	} else if (target.kind === "team" && typeof target.teamId === "string" && BOT_OR_TEAM_ID_REGEX.test(target.teamId)) {
		parsedTarget = { kind: "team", teamId: target.teamId };
	}
	if (!parsedTarget) return undefined;
	const validStatus =
		lastStatus === "queued" || lastStatus === "running" || lastStatus === "succeeded" || lastStatus === "failed"
			? lastStatus
			: undefined;
	return {
		routineId,
		target: parsedTarget,
		prompt: prompt.trim(),
		intervalMs: Math.round(intervalMs),
		enabled: typeof enabled === "boolean" ? enabled : true,
		nextRunAt,
		lastRunAt: typeof lastRunAt === "number" && Number.isFinite(lastRunAt) ? lastRunAt : undefined,
		lastStatus: validStatus,
		lastSummary: typeof lastSummary === "string" ? lastSummary : undefined,
		createdAt,
		updatedAt,
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

export class PersistentBotTeamStore {
	private readonly agentDir: string;
	private readonly filePath: string;
	private readonly bots = new Map<string, PersistentBotRecord>();
	private readonly teams = new Map<string, PersistentTeamRecord>();
	private readonly teamMessages = new Map<string, PersistentTeamMessage[]>();
	private readonly routines = new Map<string, PersistentRoutineScheduleRecord>();
	private readonly listeners = new Set<() => void>();
	private mutationChanged = false;
	private watcher: FSWatcher | undefined;
	private refreshQueued = false;
	private watchGeneration = 0;
	private loadedDigest: string | undefined;
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

	private save(): void {
		const data = {
			version: 1,
			bots: Array.from(this.bots.values()),
			teams: Array.from(this.teams.values()),
			teamMessages: Object.fromEntries(this.teamMessages),
			...(this.routines.size > 0 ? { routines: Array.from(this.routines.values()) } : {}),
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
			try {
				parsed = JSON.parse(raw);
			} catch (error) {
				if (observeOnly) throw error;
			}
		}
		if (raw !== undefined && !isRecordObject(parsed)) {
			if (observeOnly) throw new Error("Bot and team store is not an object.");
			// The next save would replace an unreadable store with an empty one and destroy every bot and team:
			// keep the unreadable file beside the store before continuing.
			renameSync(this.filePath, join(dirname(this.filePath), `store.corrupt-${Date.now()}.json`));
			parsed = undefined;
		}
		if (
			observeOnly &&
			raw !== undefined &&
			(!isRecordObject(parsed) ||
				parsed.version !== 1 ||
				!Array.isArray(parsed.bots) ||
				!Array.isArray(parsed.teams) ||
				!isRecordObject(parsed.teamMessages))
		)
			throw new Error("Bot and team store has an invalid envelope.");
		this._cachedTeamList = undefined;
		this.bots.clear();
		this.teams.clear();
		this.teamMessages.clear();
		this.routines.clear();
		this.loadedDigest = digest;
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

		if (Array.isArray(parsed.routines)) {
			for (const rawRoutine of parsed.routines) {
				const routine = parseRoutineRecord(rawRoutine);
				if (routine) {
					this.routines.set(routine.routineId, routine);
				}
			}
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
			instructions:
				input.instructions !== undefined ? input.instructions.trim() || undefined : existing?.instructions,
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
					this.routines.delete(routineId);
				}
			}
			this.save();
			return true;
		});
	}

	listRoutines(): PersistentRoutineScheduleRecord[] {
		return Array.from(this.routines.values(), (r) => structuredClone(r)).sort((a, b) => a.nextRunAt - b.nextRunAt);
	}

	getRoutine(routineId: string): PersistentRoutineScheduleRecord | undefined {
		const routine = this.routines.get(routineId.trim());
		return routine ? structuredClone(routine) : undefined;
	}

	upsertRoutine(input: UpsertPersistentRoutineInput, nowMs = Date.now()): PersistentRoutineScheduleRecord {
		return this.mutate(() => {
			const routineId = normalizeBotOrTeamId(input.routineId, "routineId");
			const prompt = input.prompt.trim();
			if (!prompt) throw new Error("Routine prompt cannot be empty.");
			const intervalMs = Math.max(MIN_ROUTINE_INTERVAL_MS, Math.round(input.intervalMs));
			const target: PersistentRoutineTarget =
				input.target.kind === "bot"
					? { kind: "bot", agentId: normalizeBotOrTeamId(input.target.agentId, "agentId") }
					: { kind: "team", teamId: normalizeBotOrTeamId(input.target.teamId, "teamId") };
			const existing = this.routines.get(routineId);
			const nowIso = new Date(nowMs).toISOString();
			const record: PersistentRoutineScheduleRecord = {
				routineId,
				target,
				prompt,
				intervalMs,
				enabled: input.enabled ?? existing?.enabled ?? true,
				nextRunAt: input.nextRunAt ?? nowMs + intervalMs,
				lastRunAt: existing?.lastRunAt,
				lastStatus: existing?.lastStatus,
				lastSummary: existing?.lastSummary,
				createdAt: existing?.createdAt ?? nowIso,
				updatedAt: nowIso,
			};
			this.routines.set(routineId, record);
			this.save();
			return structuredClone(record);
		});
	}

	deleteRoutine(routineId: string): boolean {
		return this.mutate(() => {
			const normalizedId = normalizeBotOrTeamId(routineId, "routineId");
			if (!this.routines.has(normalizedId)) return false;
			this.routines.delete(normalizedId);
			this.save();
			return true;
		});
	}

	claimDueRoutines(nowMs = Date.now(), routineIdFilter?: string): PersistentRoutineScheduleRecord[] {
		return this.mutate(() => {
			const claimed: PersistentRoutineScheduleRecord[] = [];
			const nowIso = new Date(nowMs).toISOString();
			for (const [id, routine] of this.routines.entries()) {
				if (routineIdFilter && id !== routineIdFilter) continue;
				if (!routineIdFilter && (!routine.enabled || routine.nextRunAt > nowMs)) continue;
				const updated: PersistentRoutineScheduleRecord = {
					...routine,
					lastRunAt: nowMs,
					nextRunAt: nowMs + routine.intervalMs,
					lastStatus: "running",
					updatedAt: nowIso,
				};
				this.routines.set(id, updated);
				claimed.push(structuredClone(updated));
			}
			if (claimed.length > 0) this.save();
			return claimed;
		});
	}

	completeRoutineRun(
		routineId: string,
		status: "queued" | "succeeded" | "failed",
		summary?: string,
		nowMs = Date.now(),
	): PersistentRoutineScheduleRecord | undefined {
		return this.mutate(() => {
			const existing = this.routines.get(routineId.trim());
			if (!existing) return undefined;
			const updated: PersistentRoutineScheduleRecord = {
				...existing,
				lastStatus: status,
				lastSummary: summary?.trim().slice(0, 300) || existing.lastSummary,
				updatedAt: new Date(nowMs).toISOString(),
			};
			this.routines.set(existing.routineId, updated);
			this.save();
			return structuredClone(updated);
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

	private collectTeamInboxEntries(team: PersistentTeamRecord, readAt: number): PersistentBotInboxEntry[] {
		const currentIncarnation = teamIncarnation(team);
		const entries: PersistentBotInboxEntry[] = [];
		for (const msg of this.teamMessages.get(team.teamId) ?? []) {
			if (msg.teamIncarnationId && msg.teamIncarnationId !== currentIncarnation) continue;
			const sender = msg.sender.kind === "bot" ? msg.sender.agentId : msg.sender.kind;
			entries.push({
				id: msg.messageId,
				kind: "team",
				targetId: team.teamId,
				sender,
				text: msg.text,
				timestamp: msg.timestamp,
				unread: msg.sender.kind !== "operator" && msg.timestamp > readAt,
			});
		}
		return entries;
	}

	listBotInbox(agentId: string, limit = 20): PersistentBotInboxEntry[] {
		const normId = normalizeBotOrTeamId(agentId, "agentId");
		const bot = this.bots.get(normId);
		const entries: PersistentBotInboxEntry[] = [];
		const readAt = bot?.lastReadAt ?? 0;
		if (bot?.lastSummary && bot.lastMessageAt) {
			entries.push({
				id: `bot:${normId}:${bot.lastMessageAt}`,
				kind: "bot",
				targetId: normId,
				sender: normId,
				text: bot.lastSummary,
				timestamp: bot.lastMessageAt,
				unread: bot.lastMessageAt > readAt,
			});
		}
		for (const team of this.teams.values()) {
			if (!team.memberAgentIds.includes(normId)) continue;
			entries.push(...this.collectTeamInboxEntries(team, Math.max(readAt, team.lastReadAt ?? 0)));
		}
		entries.sort((a, b) => b.timestamp - a.timestamp);
		return entries.slice(0, Math.max(1, limit));
	}

	listTeamInbox(teamId: string, limit = 20): PersistentBotInboxEntry[] {
		const normId = normalizeBotOrTeamId(teamId, "teamId");
		const team = this.teams.get(normId);
		if (!team) return [];
		const entries = this.collectTeamInboxEntries(team, team.lastReadAt ?? 0);
		entries.sort((a, b) => b.timestamp - a.timestamp);
		return entries.slice(0, Math.max(1, limit));
	}

	getStoreFilePath(): string {
		return this.filePath;
	}

	private getDaemonLeasePath(): string {
		return join(dirname(this.filePath), "bot-daemon-lease.json");
	}

	getDaemonStatus(nowMs = Date.now()): PersistentBotDaemonStatus {
		const activeRoutines = Array.from(this.routines.values()).filter((r) => r.enabled).length;
		const dueRoutines = Array.from(this.routines.values()).filter((r) => r.enabled && r.nextRunAt <= nowMs).length;
		const leasePath = this.getDaemonLeasePath();
		try {
			const raw = readFileSync(leasePath, "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (isRecordObject(parsed) && typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) {
				const lastHeartbeatAt =
					typeof parsed.lastHeartbeatAt === "number" && Number.isFinite(parsed.lastHeartbeatAt)
						? parsed.lastHeartbeatAt
						: 0;
				let alive = false;
				try {
					process.kill(parsed.pid, 0);
					alive = nowMs - lastHeartbeatAt <= DAEMON_STALE_MS;
				} catch {
					alive = false;
				}
				return {
					running: alive,
					pid: alive ? parsed.pid : undefined,
					startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
					lastHeartbeatAt: lastHeartbeatAt || undefined,
					lastTickAt:
						typeof parsed.lastTickAt === "number" && Number.isFinite(parsed.lastTickAt)
							? parsed.lastTickAt
							: undefined,
					activeRoutines,
					dueRoutines,
				};
			}
		} catch {
			// Absent or unreadable lease file means no detached daemon is running.
		}
		return { running: false, activeRoutines, dueRoutines };
	}

	writeDaemonLease(
		input: { pid: number; startedAt?: string; lastTickAt?: number },
		nowMs = Date.now(),
	): PersistentBotDaemonStatus {
		const leasePath = this.getDaemonLeasePath();
		mkdirSync(dirname(leasePath), { recursive: true });
		const payload = {
			pid: input.pid,
			startedAt: input.startedAt ?? new Date(nowMs).toISOString(),
			lastHeartbeatAt: nowMs,
			...(input.lastTickAt !== undefined ? { lastTickAt: input.lastTickAt } : {}),
		};
		writeFileAtomicSync(leasePath, JSON.stringify(payload, null, 2));
		return this.getDaemonStatus(nowMs);
	}

	releaseDaemonLease(pid?: number): boolean {
		const leasePath = this.getDaemonLeasePath();
		try {
			if (!existsSync(leasePath)) return false;
			if (pid !== undefined) {
				const raw = readFileSync(leasePath, "utf8");
				const parsed: unknown = JSON.parse(raw);
				if (isRecordObject(parsed) && typeof parsed.pid === "number" && parsed.pid !== pid) {
					return false;
				}
			}
			writeFileAtomicSync(leasePath, JSON.stringify({ releasedAt: Date.now() }));
			return true;
		} catch {
			return false;
		}
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
			const role = bot?.instructions || "general specialist";
			const header = `# Bot Memory: ${displayName} (${normId})\n\n- Model: ${model}\n- Role: ${role}\n\n## Continuity & Notes\n`;
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
		const workerLanes = laneRecords.filter((lane) => lane.type === "worker" || lane.type === "tmux-worker");

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
			const instructions = botRecord?.instructions;
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
				instructions,
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
