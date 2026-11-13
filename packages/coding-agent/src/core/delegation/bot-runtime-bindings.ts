import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { groupBotRuntimeId, isGeneratedBotRuntimeId } from "./bot-runtime-id.ts";
import { isGeneratedWorkerLaneId } from "./worker-lane-id.ts";

export const BOT_RUNTIME_BINDINGS_CUSTOM_TYPE = "pi_bot_runtime_bindings";
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_BINDINGS = 1024;

/**
 * Whether `id` is in the bot id domain. Anything else is not a bot: a managed lane id such as `collaboration:<job>:<agent>`,
 * the id of a plain delegate worker (`worker-<n>`), which is a child of the session that started it, and a runtime the
 * harness generated for a bot (`bot-<uuid>`, `bot-<32 hex>`, `group-<32 hex>`, `bot-runtime-id.ts`), which is a bot's
 * worker and never a bot's name.
 */
export function isBotId(id: string): boolean {
	return ID.test(id) && !isGeneratedWorkerLaneId(id) && !isGeneratedBotRuntimeId(id);
}

/**
 * Refuses a name no bot may take: the id of a delegate worker, which `delegate` manages (status, send, cancel), and the id
 * of a bot's runtime, which the harness generates for that bot's worker.
 */
export function assertBotId(id: string): void {
	if (isGeneratedWorkerLaneId(id))
		throw new Error(
			`"${id}" is a delegate worker, not a bot; manage it with the delegate tool (status, send, cancel). Bots are created with /bot new or the bot tool under another name.`,
		);
	if (isGeneratedBotRuntimeId(id))
		throw new Error(
			`"${id}" is the id the harness gives a bot's worker runtime, not a name a bot can take. Bots are created with /bot new or the bot tool under another name.`,
		);
}

export interface BotRuntimeContext {
	agentId: string;
	teamId?: string;
	teamIncarnationId?: string;
}

function contextKey(context: BotRuntimeContext): string {
	return context.teamId === undefined
		? context.agentId
		: JSON.stringify([context.agentId, context.teamId, context.teamIncarnationId]);
}

function decodeContext(key: string): BotRuntimeContext {
	if (ID.test(key)) return { agentId: key };
	const value: unknown = JSON.parse(key);
	if (
		!Array.isArray(value) ||
		value.length !== 3 ||
		typeof value[0] !== "string" ||
		!ID.test(value[0]) ||
		typeof value[1] !== "string" ||
		!ID.test(value[1]) ||
		typeof value[2] !== "string" ||
		!value[2] ||
		value[2].length > 64
	)
		throw new Error("Invalid bot group binding.");
	const context = { agentId: value[0], teamId: value[1], teamIncarnationId: value[2] };
	if (contextKey(context) !== key) throw new Error("Noncanonical bot group binding.");
	return context;
}

/** The bot records a runtime's bot is read from: the record of a bot id, undefined for an id no bot holds. */
export type BotRecords = () => { getBot(agentId: string): { agentId: string; displayName?: string } | undefined };

/**
 * Bot names are durable aliases; each parent branch owns its current worker generations. A runtime is a bot's only when a
 * bot record stands behind its alias: a delegate worker, a managed lane or an unowned runtime resolves to no bot.
 */
export class BotRuntimeBindings {
	private readonly manager: () => SessionManager;
	private readonly records: BotRecords;
	private cachedEntry: object | undefined;
	private cachedSession = "";
	private current = new Map<string, string>();
	// Unbound runtime IDs are opaque (managed lanes include ':'), not serialized bot binding keys.
	private readonly generationContexts = new Map<string, BotRuntimeContext>();

	constructor(manager: () => SessionManager, records: BotRecords) {
		this.manager = manager;
		this.records = records;
	}

	private read(): Map<string, string> {
		const manager = this.manager();
		const session = manager.getSessionId();
		const entry = manager.getLatestCustomEntryOnBranch(BOT_RUNTIME_BINDINGS_CUSTOM_TYPE);
		if (entry === this.cachedEntry && session === this.cachedSession) return this.current;
		const bindings = entry ? this.decode(entry.data) : new Map<string, string>();
		this.current = bindings;
		this.cachedEntry = entry;
		this.cachedSession = session;
		this.generationContexts.clear();
		return bindings;
	}

	private decode(data: unknown): Map<string, string> {
		const manager = this.manager();
		const bindings = new Map<string, string>();
		if (
			!isPlainRecord(data) ||
			data.version !== 1 ||
			typeof data.sessionId !== "string" ||
			!isPlainRecord(data.bindings)
		)
			throw new Error("Bot runtime binding snapshot is unavailable.");
		const inherited = data.sessionId !== manager.getSessionId();
		if (inherited && !manager.getSessionLineageIds().includes(data.sessionId))
			throw new Error("Bot runtime binding snapshot belongs to an unrelated parent.");
		const entries = Object.entries(data.bindings);
		if (entries.length > MAX_BINDINGS) throw new Error("Bot runtime binding limit exceeded.");
		for (const [alias, runtime] of entries) {
			decodeContext(alias);
			if (typeof runtime !== "string" || !ID.test(runtime)) throw new Error("Invalid bot runtime binding.");
			bindings.set(alias, runtime);
		}
		if (new Set(bindings.values()).size !== bindings.size) throw new Error("Ambiguous bot runtime bindings.");
		// Forks copy custom history, but a new parent owns no workers from that history.
		if (inherited) bindings.clear();
		return bindings;
	}

	preferredId(context: BotRuntimeContext): string {
		return context.teamId === undefined ? context.agentId : groupBotRuntimeId(contextKey(context));
	}

	runtime(alias: string, teamId?: string, teamIncarnationId?: string): string {
		const context = { agentId: alias, teamId, teamIncarnationId };
		return this.read().get(contextKey(context)) ?? this.preferredId(context);
	}

	revision(): object {
		return this.read();
	}

	/** The bot alias a runtime is the current generation of; undefined for a superseded runtime, a delegate worker, a managed lane or a runtime no bot holds, none of which is a bot. */
	alias(runtime: string): string | undefined {
		const context = this.generationContext(runtime);
		if (!isBotId(context.agentId) || !this.records().getBot(context.agentId)) return undefined;
		return this.runtime(context.agentId, context.teamId, context.teamIncarnationId) === runtime
			? context.agentId
			: undefined;
	}

	/** The bot a runtime belongs to in any generation, as its record names it; undefined for a group thread, a delegate worker or a managed lane. */
	botOf(runtime: string): { agentId: string; displayName?: string } | undefined {
		const context = this.generationContext(runtime);
		const bot =
			context.teamId === undefined && isBotId(context.agentId) ? this.records().getBot(context.agentId) : undefined;
		return bot ? { agentId: bot.agentId, displayName: bot.displayName } : undefined;
	}

	/** Historical ownership identifies a superseded sender; it never grants reuse of that runtime. */
	generationContext(runtime: string): BotRuntimeContext {
		const bindings = this.read();
		for (const [alias, current] of bindings) if (current === runtime) return decodeContext(alias);
		const cached = this.generationContexts.get(runtime);
		if (cached) return { ...cached };
		const branch = this.manager().getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index]!;
			if (entry.type !== "custom" || entry.customType !== BOT_RUNTIME_BINDINGS_CUSTOM_TYPE) continue;
			for (const [alias, previous] of this.decode(entry.data)) {
				if (previous !== runtime) continue;
				const context = decodeContext(alias);
				this.rememberGeneration(runtime, context);
				return context;
			}
		}
		const context = { agentId: runtime };
		this.rememberGeneration(runtime, context);
		return context;
	}

	private rememberGeneration(runtime: string, context: BotRuntimeContext): void {
		if (this.generationContexts.size >= MAX_BINDINGS)
			this.generationContexts.delete(this.generationContexts.keys().next().value!);
		this.generationContexts.set(runtime, { ...context });
	}

	runtimes(alias: string): string[] {
		// A bot started before runtimes were bound ran under its own alias; a delegate worker's id is never a bot's runtime.
		const result = new Set(isBotId(alias) ? [alias] : []);
		for (const entry of this.manager().getBranch()) {
			if (entry.type !== "custom" || entry.customType !== BOT_RUNTIME_BINDINGS_CUSTOM_TYPE) continue;
			for (const [key, runtime] of this.decode(entry.data))
				if (decodeContext(key).agentId === alias) result.add(runtime);
		}
		return [...result];
	}

	assertCapacity(alias: string, teamId?: string, teamIncarnationId?: string): void {
		const bindings = this.read();
		if (!bindings.has(contextKey({ agentId: alias, teamId, teamIncarnationId })) && bindings.size >= MAX_BINDINGS)
			throw new Error("Bot runtime binding limit exceeded.");
	}

	bind(alias: string, runtime: string, teamId?: string, teamIncarnationId?: string): void {
		this.assertCapacity(alias, teamId, teamIncarnationId);
		if (!ID.test(alias) || !ID.test(runtime)) throw new Error("Invalid bot runtime binding.");
		assertBotId(alias);
		const key = contextKey({ agentId: alias, teamId, teamIncarnationId });
		decodeContext(key);
		const bindings = new Map(this.read());
		for (const [other, current] of bindings)
			if (other !== key && current === runtime) throw new Error("Worker already belongs to another bot.");
		bindings.set(key, runtime);
		this.manager().appendCustomEntry(BOT_RUNTIME_BINDINGS_CUSTOM_TYPE, {
			version: 1,
			sessionId: this.manager().getSessionId(),
			bindings: Object.fromEntries(bindings),
		});
	}
}
