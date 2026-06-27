import type { ToolDefinition } from "../extensions/types.ts";
import type { MemoryLifecycleContext, MemoryProvider } from "./memory-provider.ts";

export class MemoryManager {
	private readonly providers: MemoryProvider[] = [];
	private readonly activeProviders: Set<string> = new Set();
	private readonly registeredToolNames: Set<string> = new Set();
	private ctx?: MemoryLifecycleContext;
	private systemPromptBlockCache?: string;

	// Core reserved tool names to prevent hijacking or schema corruption.
	private static readonly RESERVED_CORE_TOOL_NAMES = new Set([
		"read",
		"write",
		"grep",
		"find",
		"ls",
		"bash",
		"ask_user",
		"skillify",
		"skill_audit",
		"skill_search",
		"skill_open",
	]);

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
			try {
				const available = await p.isAvailable();
				if (!available) {
					continue;
				}

				await p.initialize(sessionId, ctx);
				this.activeProviders.add(p.name);
			} catch (err) {
				console.error(`Memory provider ${p.name} failed to initialize and was deactivated:`, err);
			}
		}
	}

	public buildSystemPromptBlock(): string {
		if (this.systemPromptBlockCache !== undefined) {
			return this.systemPromptBlockCache;
		}

		this.systemPromptBlockCache = this._composeSystemPromptBlock();
		return this.systemPromptBlockCache;
	}

	/**
	 * Compose the memory block freshly from the providers, BYPASSING the frozen cache used by the
	 * system prompt. Used by end-of-loop reflection so its confront-before-write sees the live memory
	 * (including writes made earlier in the same session) without churning the prefix-cache-stable
	 * system prompt block.
	 */
	public buildSystemPromptBlockFresh(): string {
		return this._composeSystemPromptBlock();
	}

	private _composeSystemPromptBlock(): string {
		const blocks: string[] = [];
		for (const p of this.providers) {
			if (!this.activeProviders.has(p.name) || !p.systemPromptBlock) {
				continue;
			}
			try {
				const block = p.systemPromptBlock();
				if (block) {
					blocks.push(block);
				}
			} catch (err) {
				console.error(`Memory provider ${p.name} failed to generate system prompt block:`, err);
			}
		}
		return blocks.join("\n\n");
	}

	public async prefetch(query: string): Promise<string> {
		const results: string[] = [];
		for (const p of this.providers) {
			if (!this.activeProviders.has(p.name) || !p.prefetch) {
				continue;
			}
			try {
				const text = await p.prefetch(query);
				if (text) {
					results.push(text);
				}
			} catch (err) {
				console.error(`Memory provider ${p.name} failed during prefetch:`, err);
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
			try {
				await p.syncTurn(user, assistant);
			} catch (err) {
				console.error(`Memory provider ${p.name} failed during syncTurn:`, err);
			}
		}
	}

	public async onPreCompress(): Promise<string> {
		const insights: string[] = [];
		for (const p of this.providers) {
			if (!this.activeProviders.has(p.name) || !p.onPreCompress) {
				continue;
			}
			try {
				const insight = await p.onPreCompress();
				if (insight) {
					insights.push(insight);
				}
			} catch (err) {
				console.error(`Memory provider ${p.name} failed during onPreCompress:`, err);
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
			try {
				await p.onSessionEnd();
			} catch (err) {
				console.error(`Memory provider ${p.name} failed during onSessionEnd:`, err);
			}
		}
	}

	public async shutdownAll(): Promise<void> {
		// Shutdown in reverse registration order
		const reversed = [...this.providers].reverse();
		for (const p of reversed) {
			if (!this.activeProviders.has(p.name)) {
				continue;
			}
			try {
				await p.shutdown();
			} catch (err) {
				console.error(`Memory provider ${p.name} failed to shutdown cleanly:`, err);
			}
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
	}
}
