import { createHash } from "node:crypto";
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
	readonly memoryFilePath?: string;
}

export interface PersistentTeamRecord {
	readonly teamId: string;
	readonly name: string;
	readonly description?: string;
	readonly memberAgentIds: readonly string[];
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastMessageAt?: number;
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
}

export interface UpsertPersistentTeamInput {
	readonly teamId: string;
	readonly name?: string;
	readonly description?: string;
	readonly memberAgentIds: readonly string[];
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
	};
}

function parseTeamRecord(value: unknown): PersistentTeamRecord | undefined {
	if (!isRecordObject(value)) {
		return undefined;
	}
	const { teamId, name, description, memberAgentIds, createdAt, updatedAt, lastMessageAt, memoryFilePath } = value;

	if (
		typeof teamId !== "string" ||
		!BOT_OR_TEAM_ID_REGEX.test(teamId) ||
		typeof createdAt !== "string" ||
		typeof updatedAt !== "string" ||
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
		name: typeof name === "string" ? name : teamId,
		description: typeof description === "string" ? description : undefined,
		memberAgentIds: validMembers,
		createdAt,
		updatedAt,
		lastMessageAt: typeof lastMessageAt === "number" && Number.isFinite(lastMessageAt) ? lastMessageAt : undefined,
		memoryFilePath: typeof memoryFilePath === "string" ? memoryFilePath : undefined,
	};
}

function parseTeamMessage(value: unknown): PersistentTeamMessage | undefined {
	if (!isRecordObject(value)) {
		return undefined;
	}
	const { messageId, teamId, sender, text, timestamp, targetAgentIds, deliveries } = value;

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
		return this.mutate(() => {
			const agentId = normalizeBotOrTeamId(input.agentId, "agentId");
			const existing = this.bots.get(agentId);
			const provider = (input.provider !== undefined ? input.provider.trim() : existing?.provider) || "anthropic";
			const modelId = (input.modelId !== undefined ? input.modelId.trim() : existing?.modelId) || "claude-haiku-5-5";

			const now = nowIso ?? new Date().toISOString();

			const record: PersistentBotRecord = {
				agentId,
				displayName: input.displayName?.trim() || existing?.displayName || agentId,
				description:
					input.description !== undefined ? input.description.trim() || undefined : existing?.description,
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
			};

			this.bots.set(agentId, record);
			this.ensureBotMemoryFile(agentId);
			this.save();
			return record;
		});
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

			this.save();
			return true;
		});
	}

	listTeams(): PersistentTeamRecord[] {
		if (this._cachedTeamList === undefined) {
			this._cachedTeamList = Array.from(this.teams.values()).map((team) => ({
				...team,
				memberAgentIds: [...team.memberAgentIds],
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
				name: input.name?.trim() || existing?.name || teamId,
				description:
					input.description !== undefined ? input.description.trim() || undefined : existing?.description,
				memberAgentIds,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				lastMessageAt: existing?.lastMessageAt,
				memoryFilePath: this.getTeamMemoryFilePath(teamId),
			};

			this.teams.set(teamId, record);
			this.ensureTeamMemoryFile(teamId);
			this.save();
			return record;
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
			this.save();
			return true;
		});
	}

	appendTeamMessage(message: PersistentTeamMessage): void {
		this.mutate(() => {
			this.recordTeamMessage(message);
		});
	}

	/** Adds a message to the loaded state and saves. The caller has re-read the file: re-reading here would reset what it is iterating. */
	private recordTeamMessage(message: PersistentTeamMessage): void {
		const teamId = normalizeBotOrTeamId(message.teamId, "teamId");
		const messages = this.teamMessages.get(teamId) ?? [];
		messages.push(structuredClone(message));
		if (messages.length > MAX_TEAM_MESSAGES_PER_TEAM) {
			this.teamMessages.set(teamId, messages.slice(-MAX_TEAM_MESSAGES_PER_TEAM));
		} else {
			this.teamMessages.set(teamId, messages);
		}
		const team = this.teams.get(teamId);
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
		return join(this.agentDir, "memory", "teams", `${normalizeBotOrTeamId(teamId, "teamId")}.md`);
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

	recordBotTurnOutcome(input: { agentId: string; summary: string; transcriptRef?: string; timestamp?: number }): void {
		this.mutate(() => {
			const normId = normalizeBotOrTeamId(input.agentId, "agentId");
			const bot = this.bots.get(normId);
			const belongsToAnyTeam = Array.from(this.teams.values()).some((t) => t.memberAgentIds.includes(normId));

			if (!bot && !belongsToAnyTeam) {
				return;
			}

			const timestamp = input.timestamp ?? Date.now();
			const iso = new Date(timestamp).toISOString();
			const oneLineSummary = input.summary
				.trim()
				.replace(/\r?\n+/g, " ")
				.slice(0, 300);

			if (bot) {
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

			this.ensureBotMemoryFile(normId);
			const botFile = this.getBotMemoryFilePath(normId);
			const refSuffix = input.transcriptRef ? ` (${input.transcriptRef})` : "";
			appendBoundedFile(botFile, `- [${iso}] ${oneLineSummary}${refSuffix}`, 80);

			for (const team of [...this.teams.values()]) {
				if (team.memberAgentIds.includes(normId)) {
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
			}
		});
	}

	composeBotUnifiedMemoryContext(agentId: string): {
		promptBlock: string;
		memoryDir: string;
		memoryFiles: string[];
	} {
		const normId = normalizeBotOrTeamId(agentId, "agentId");
		const memoryDir = join(this.agentDir, "memory");
		const memoryFiles: string[] = [];

		const botMemoryPath = this.getBotMemoryFilePath(normId);
		memoryFiles.push(botMemoryPath);

		let botExcerpt = "";
		if (existsSync(botMemoryPath)) {
			try {
				const content = readFileSync(botMemoryPath, "utf8").trim();
				botExcerpt = content.length > 1200 ? content.slice(-1200) : content;
			} catch {
				botExcerpt = "";
			}
		}

		const bot = this.bots.get(normId);
		const memberTeams: PersistentTeamRecord[] = [];
		const teamMemoryExcerpts: string[] = [];
		const allRecentTeamMessages: PersistentTeamMessage[] = [];

		for (const team of this.teams.values()) {
			if (team.memberAgentIds.includes(normId)) {
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
				const msgs = this.listTeamMessages(team.teamId, 5);
				allRecentTeamMessages.push(...msgs);
			}
		}

		allRecentTeamMessages.sort((a, b) => a.timestamp - b.timestamp);
		const recent5TeamMsgs = allRecentTeamMessages.slice(-5);

		const lines: string[] = [
			BOT_MEMORY_BLOCK_HEADER,
			`You are persistent bot "${normId}". You have persistent memory files you can read; the host appends a line to them from each report you finish.`,
			`- Bot memory file: ${botMemoryPath}`,
		];

		if (memberTeams.length > 0) {
			lines.push(
				`- Member of teams: ${memberTeams.map((t) => `${t.name ?? t.teamId} (${this.getTeamMemoryFilePath(t.teamId)})`).join(", ")}`,
			);
		}
		if (bot?.lastTranscriptRef) {
			lines.push(`- Prior transcript reference: ${bot.lastTranscriptRef}`);
		}
		if (bot?.lastSummary) {
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
			const botRecord = this.bots.get(agentId);
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
