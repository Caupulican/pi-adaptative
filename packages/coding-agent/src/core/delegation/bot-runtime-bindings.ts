import { createHash } from "node:crypto";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { isPlainRecord } from "../util/value-guards.ts";

const BINDING_TYPE = "pi_bot_runtime_bindings";
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_BINDINGS = 1024;

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

/** Bot names are durable aliases; each parent branch owns its current worker generations. */
export class BotRuntimeBindings {
	private readonly manager: () => SessionManager;
	private cachedEntry: object | undefined;
	private cachedSession = "";
	private current = new Map<string, string>();
	// Unbound runtime IDs are opaque (managed lanes include ':'), not serialized bot binding keys.
	private readonly generationContexts = new Map<string, BotRuntimeContext>();

	constructor(manager: () => SessionManager) {
		this.manager = manager;
	}

	private read(): Map<string, string> {
		const manager = this.manager();
		const session = manager.getSessionId();
		const entry = manager.getLatestCustomEntryOnBranch(BINDING_TYPE);
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
		return context.teamId === undefined
			? context.agentId
			: `group-${createHash("sha256").update(contextKey(context)).digest("hex").slice(0, 32)}`;
	}

	runtime(alias: string, teamId?: string, teamIncarnationId?: string): string {
		const context = { agentId: alias, teamId, teamIncarnationId };
		return this.read().get(contextKey(context)) ?? this.preferredId(context);
	}

	revision(): object {
		return this.read();
	}

	alias(runtime: string): string | undefined {
		const context = this.generationContext(runtime);
		return this.runtime(context.agentId, context.teamId, context.teamIncarnationId) === runtime
			? context.agentId
			: undefined;
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
			if (entry.type !== "custom" || entry.customType !== BINDING_TYPE) continue;
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
		const result = new Set([alias]);
		for (const entry of this.manager().getBranch()) {
			if (entry.type !== "custom" || entry.customType !== BINDING_TYPE) continue;
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
		const key = contextKey({ agentId: alias, teamId, teamIncarnationId });
		decodeContext(key);
		const bindings = new Map(this.read());
		for (const [other, current] of bindings)
			if (other !== key && current === runtime) throw new Error("Worker already belongs to another bot.");
		bindings.set(key, runtime);
		this.manager().appendCustomEntry(BINDING_TYPE, {
			version: 1,
			sessionId: this.manager().getSessionId(),
			bindings: Object.fromEntries(bindings),
		});
	}
}
