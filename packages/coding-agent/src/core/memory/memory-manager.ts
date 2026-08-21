import type { MemoryPromptBudget } from "../context/memory-prompt-budget.ts";
import {
	DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY,
	hasSecretLikeMemoryText,
	type MemoryEgressPolicy,
} from "../context/memory-provider-contract.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import type { MemoryLifecycleContext, MemoryProvider } from "./memory-provider.ts";

export interface MemoryPrefetchOptions {
	externalEgressPolicy?: MemoryEgressPolicy;
}

export interface MemoryManagerOptions {
	/** Maximum time a provider lifecycle call may keep the session waiting. */
	lifecycleTimeoutMs?: number;
}

export type MemoryLifecycleOperation =
	| "isAvailable"
	| "initialize"
	| "prefetch"
	| "syncTurn"
	| "onPreCompress"
	| "onSessionEnd"
	| "shutdown";

export interface MemoryLifecycleDiagnostic {
	provider: string;
	operation: MemoryLifecycleOperation;
	status: "timeout" | "error" | "abandoned";
	message: string;
}

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 8_000;
const MAX_LIFECYCLE_DIAGNOSTICS = 32;

type ProviderOperationResult<T> =
	| { status: "ok"; value: T }
	| { status: "timeout" }
	| { status: "error"; error: unknown };

interface AbandonedProviderState {
	pendingOperations: number;
}

export class MemoryManager {
	/** Provider identities remain fenced while late timed-out operations are still pending, without retaining them strongly. */
	private static readonly ABANDONED_PROVIDERS = new WeakMap<MemoryProvider, AbandonedProviderState>();
	private readonly providers: MemoryProvider[] = [];
	private readonly activeProviders: Set<string> = new Set();
	private readonly registeredToolNames: Set<string> = new Set();
	private ctx?: MemoryLifecycleContext;
	private systemPromptBlockCache?: { key: string; text: string };
	private readonly lifecycleTimeoutMs: number;
	private readonly lifecycleDiagnostics: MemoryLifecycleDiagnostic[] = [];

	// Core reserved tool names to prevent hijacking or schema corruption.
	private static readonly RESERVED_CORE_TOOL_NAMES = new Set([
		"read",
		"write",
		"grep",
		"find",
		"ls",
		"bash",
		"python",
		"ask_user",
		"skillify",
		"skill_audit",
		"skill_search",
		"skill_open",
	]);

	constructor(options: MemoryManagerOptions = {}) {
		const timeout = options.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
		if (!Number.isFinite(timeout) || timeout <= 0) {
			throw new Error("Memory lifecycle timeout must be a finite positive number.");
		}
		this.lifecycleTimeoutMs = timeout;
	}

	/** Bounded, source-labelled diagnostics for lifecycle failures; no provider payloads are retained. */
	public getLifecycleDiagnostics(): MemoryLifecycleDiagnostic[] {
		return this.lifecycleDiagnostics.map((diagnostic) => ({ ...diagnostic }));
	}

	private recordLifecycleDiagnostic(diagnostic: MemoryLifecycleDiagnostic): void {
		if (this.lifecycleDiagnostics.length >= MAX_LIFECYCLE_DIAGNOSTICS) {
			this.lifecycleDiagnostics.shift();
		}
		this.lifecycleDiagnostics.push(diagnostic);
		console.error(
			`Memory provider ${diagnostic.provider} ${diagnostic.operation} ${diagnostic.status}: ${diagnostic.message}`,
		);
	}

	private abandonProvider(provider: MemoryProvider): void {
		// A timed-out Promise cannot be cancelled. Removing the provider prevents a late completion
		// from racing a later hook and makes abandonment the one mandatory recovery path.
		this.activeProviders.delete(provider.name);
		const state = MemoryManager.ABANDONED_PROVIDERS.get(provider) ?? { pendingOperations: 0 };
		state.pendingOperations += 1;
		MemoryManager.ABANDONED_PROVIDERS.set(provider, state);
	}

	private releaseAbandonedProvider(provider: MemoryProvider): void {
		const state = MemoryManager.ABANDONED_PROVIDERS.get(provider);
		if (state === undefined) return;
		state.pendingOperations -= 1;
		if (state.pendingOperations <= 0) MemoryManager.ABANDONED_PROVIDERS.delete(provider);
	}

	private async invokeProvider<T>(
		provider: MemoryProvider,
		operation: MemoryLifecycleOperation,
		callback: () => T | Promise<T>,
	): Promise<ProviderOperationResult<T>> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		const operationPromise = Promise.resolve()
			.then(callback)
			.then((value): ProviderOperationResult<T> => ({ status: "ok", value }))
			.catch((error): ProviderOperationResult<T> => ({ status: "error", error }))
			.finally(() => {
				if (timedOut) this.releaseAbandonedProvider(provider);
			});
		const timeoutPromise = new Promise<ProviderOperationResult<T>>((resolve) => {
			timeout = setTimeout(() => {
				timedOut = true;
				this.abandonProvider(provider);
				this.recordLifecycleDiagnostic({
					provider: provider.name,
					operation,
					status: "timeout",
					message: `exceeded ${this.lifecycleTimeoutMs}ms`,
				});
				resolve({ status: "timeout" });
			}, this.lifecycleTimeoutMs);
		});
		try {
			const result = await Promise.race([operationPromise, timeoutPromise]);
			if (result.status === "error") {
				this.recordLifecycleDiagnostic({
					provider: provider.name,
					operation,
					status: "error",
					message: result.error instanceof Error ? result.error.name : typeof result.error,
				});
				return { status: "error", error: result.error };
			}
			return result;
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
		}
	}

	public registerProvider(p: MemoryProvider): void {
		if (this.providers.some((prov) => prov.name === p.name)) {
			throw new Error(`Memory provider ${p.name} is already registered.`);
		}

		if (p.getToolDefinitions) {
			let tools: ToolDefinition[] = [];
			try {
				tools = p.getToolDefinitions() ?? [];
			} catch (err) {
				throw new Error(`Failed to get tool definitions from provider ${p.name}: ${String(err)}`);
			}

			for (const tool of tools) {
				if (MemoryManager.RESERVED_CORE_TOOL_NAMES.has(tool.name)) {
					throw new Error(`Memory provider ${p.name} tried to register reserved core tool: ${tool.name}`);
				}
				if (this.registeredToolNames.has(tool.name)) {
					throw new Error(
						`Memory provider tool name collision: ${tool.name} is already registered. First-registration-wins.`,
					);
				}
			}

			for (const tool of tools) {
				this.registeredToolNames.add(tool.name);
			}
		}

		this.providers.push(p);
	}

	public async initializeAll(sessionId: string, ctx: MemoryLifecycleContext): Promise<void> {
		this.ctx = ctx;
		this.activeProviders.clear();
		this.systemPromptBlockCache = undefined;

		for (const p of this.providers) {
			if (MemoryManager.ABANDONED_PROVIDERS.has(p)) {
				this.recordLifecycleDiagnostic({
					provider: p.name,
					operation: "initialize",
					status: "abandoned",
					message: "provider identity was abandoned by an earlier manager generation",
				});
				continue;
			}
			const availability = await this.invokeProvider(p, "isAvailable", () => p.isAvailable());
			if (availability.status !== "ok" || !availability.value) continue;

			const initialized = await this.invokeProvider(p, "initialize", () => p.initialize(sessionId, ctx));
			if (initialized.status === "ok") this.activeProviders.add(p.name);
		}
	}

	public buildSystemPromptBlock(budget?: MemoryPromptBudget): string {
		const key =
			budget === undefined
				? "none"
				: `${budget.enabled}:${budget.compact}:${budget.maxLines}:${budget.maxEstimatedTokens}:${budget.maxChars}`;
		if (this.systemPromptBlockCache !== undefined && this.systemPromptBlockCache.key === key) {
			return this.systemPromptBlockCache.text;
		}

		const text = this._composeSystemPromptBlock(budget);
		this.systemPromptBlockCache = { key, text };
		return text;
	}

	/**
	 * Compose the memory block freshly from the providers, BYPASSING the frozen cache used by the
	 * system prompt. Used by end-of-loop reflection so its confront-before-write sees the live memory
	 * (including writes made earlier in the same session) without churning the prefix-cache-stable
	 * system prompt block.
	 */
	public buildSystemPromptBlockFresh(budget?: MemoryPromptBudget): string {
		return this._composeSystemPromptBlock(budget);
	}

	private _composeSystemPromptBlock(budget?: MemoryPromptBudget): string {
		const blocks: string[] = [];
		for (const p of this.providers) {
			if (!this.activeProviders.has(p.name) || !p.systemPromptBlock) {
				continue;
			}
			try {
				const block = p.systemPromptBlock(budget);
				if (block) {
					blocks.push(block);
				}
			} catch (err) {
				console.error(`Memory provider ${p.name} failed to generate system prompt block:`, err);
			}
		}
		return blocks.join("\n\n");
	}

	public async prefetch(query: string, options: MemoryPrefetchOptions = {}): Promise<string> {
		const results: string[] = [];
		for (const p of this.providers) {
			if (!this.activeProviders.has(p.name) || !p.prefetch) {
				continue;
			}
			if (p.egress !== "local") {
				const policy = options.externalEgressPolicy ?? DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY;
				if (
					!policy.enabled ||
					!policy.allowExternalEgress ||
					!policy.allowQueryText ||
					query.length > policy.maxOutboundChars ||
					(policy.redactSecretLikeText && hasSecretLikeMemoryText(query))
				) {
					continue;
				}
			}
			const result = await this.invokeProvider(p, "prefetch", () => p.prefetch!(query));
			if (result.status === "ok" && result.value) {
				results.push(wrapUntrustedText(result.value, `memory:${p.name}`));
			}
		}
		return results.join("\n\n");
	}

	public async syncTurn(user: string, assistant: string): Promise<void> {
		if (this.ctx?.isChildSession) {
			return; // Write-gated: skip writes in child sessions
		}

		for (const p of this.providers) {
			if (!this.activeProviders.has(p.name) || !p.syncTurn) {
				continue;
			}
			await this.invokeProvider(p, "syncTurn", () => p.syncTurn!(user, assistant));
		}
	}

	public async onPreCompress(): Promise<string> {
		const insights: string[] = [];
		for (const p of this.providers) {
			if (!this.activeProviders.has(p.name) || !p.onPreCompress) {
				continue;
			}
			const result = await this.invokeProvider(p, "onPreCompress", () => p.onPreCompress!());
			if (result.status === "ok" && result.value) {
				insights.push(result.value);
			}
		}
		return insights.join("\n\n");
	}

	public async onSessionEnd(): Promise<void> {
		if (this.ctx?.isChildSession) {
			return; // Write-gated: skip writes in child sessions
		}

		for (const p of this.providers) {
			if (!this.activeProviders.has(p.name) || !p.onSessionEnd) {
				continue;
			}
			await this.invokeProvider(p, "onSessionEnd", () => p.onSessionEnd!());
		}
	}

	public async shutdownAll(): Promise<void> {
		// Shutdown in reverse registration order
		const reversed = [...this.providers].reverse();
		for (const p of reversed) {
			if (!this.activeProviders.has(p.name)) {
				continue;
			}
			await this.invokeProvider(p, "shutdown", () => p.shutdown());
		}
		this.activeProviders.clear();
	}

	public getToolDefinitions(): ToolDefinition[] {
		const tools: ToolDefinition[] = [];
		for (const p of this.providers) {
			if (!this.activeProviders.has(p.name) || !p.getToolDefinitions) {
				continue;
			}
			try {
				tools.push(...p.getToolDefinitions());
			} catch (err) {
				console.error(`Failed to get tool definitions from provider ${p.name}:`, err);
			}
		}
		return tools;
	}

	public getContextMarkers(): string[] {
		const markers = new Set<string>();
		for (const p of this.providers) {
			if (!this.activeProviders.has(p.name) || !p.getContextMarkers) {
				continue;
			}
			try {
				const list = p.getContextMarkers() ?? [];
				for (const m of list) {
					markers.add(m);
				}
			} catch (err) {
				console.error(`Failed to get context markers from provider ${p.name}:`, err);
			}
		}
		return [...markers];
	}

	public reset(): void {
		this.providers.length = 0;
		this.activeProviders.clear();
		this.registeredToolNames.clear();
		this.systemPromptBlockCache = undefined;
		this.ctx = undefined;
		this.lifecycleDiagnostics.length = 0;
	}
}
