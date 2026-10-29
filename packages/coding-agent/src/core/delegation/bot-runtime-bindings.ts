import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { isPlainRecord } from "../util/value-guards.ts";

const BINDING_TYPE = "pi_bot_runtime_bindings";
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_BINDINGS = 1024;

/** Bot names are durable aliases; each parent branch owns its current worker generations. */
export class BotRuntimeBindings {
	private readonly manager: () => SessionManager;
	private cachedEntry: object | undefined;
	private cachedSession = "";
	private current = new Map<string, string>();

	constructor(manager: () => SessionManager) {
		this.manager = manager;
	}

	private read(): Map<string, string> {
		const manager = this.manager();
		const session = manager.getSessionId();
		const entry = manager.getLatestCustomEntryOnBranch(BINDING_TYPE);
		if (entry === this.cachedEntry && session === this.cachedSession) return this.current;
		const bindings = new Map<string, string>();
		if (entry) {
			const data = entry.data;
			if (
				!isPlainRecord(data) ||
				data.version !== 1 ||
				typeof data.sessionId !== "string" ||
				!isPlainRecord(data.bindings)
			)
				throw new Error("Bot runtime binding snapshot is unavailable.");
			const inherited = data.sessionId !== session;
			if (inherited && !manager.getSessionLineageIds().includes(data.sessionId))
				throw new Error("Bot runtime binding snapshot belongs to an unrelated parent.");
			const entries = Object.entries(data.bindings);
			if (entries.length > MAX_BINDINGS) throw new Error("Bot runtime binding limit exceeded.");
			for (const [alias, runtime] of entries) {
				if (!ID.test(alias) || typeof runtime !== "string" || !ID.test(runtime))
					throw new Error("Invalid bot runtime binding.");
				bindings.set(alias, runtime);
			}
			if (new Set(bindings.values()).size !== bindings.size) throw new Error("Ambiguous bot runtime bindings.");
			// Forks copy custom history, but a new parent owns no workers from that history.
			if (inherited) bindings.clear();
		}
		this.current = bindings;
		this.cachedEntry = entry;
		this.cachedSession = session;
		return bindings;
	}

	runtime(alias: string): string {
		return this.read().get(alias) ?? alias;
	}

	revision(): object {
		return this.read();
	}

	alias(runtime: string): string | undefined {
		const bindings = this.read();
		for (const [alias, current] of bindings) if (current === runtime) return alias;
		return bindings.has(runtime) ? undefined : runtime;
	}

	assertCapacity(alias: string): void {
		const bindings = this.read();
		if (!bindings.has(alias) && bindings.size >= MAX_BINDINGS) throw new Error("Bot runtime binding limit exceeded.");
	}

	bind(alias: string, runtime: string): void {
		this.assertCapacity(alias);
		if (!ID.test(alias) || !ID.test(runtime)) throw new Error("Invalid bot runtime binding.");
		const bindings = new Map(this.read());
		for (const [other, current] of bindings)
			if (other !== alias && current === runtime) throw new Error("Worker already belongs to another bot.");
		bindings.set(alias, runtime);
		this.manager().appendCustomEntry(BINDING_TYPE, {
			version: 1,
			sessionId: this.manager().getSessionId(),
			bindings: Object.fromEntries(bindings),
		});
	}
}
