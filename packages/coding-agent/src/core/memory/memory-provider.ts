import type { ToolDefinition } from "../extensions/types.ts";

export type MemorySurface = "context" | "routing" | "tooling" | "parametric";

export interface MemoryCapabilities {
	surfaces: MemorySurface[];
}

export interface MemoryLifecycleContext {
	agentDir: string;
	cwd: string;
	isChildSession: boolean;
}

export interface MemoryProvider {
	readonly name: string;
	isAvailable(): boolean | Promise<boolean>;
	getCapabilities(): MemoryCapabilities;
	initialize(sessionId: string, ctx: MemoryLifecycleContext): Promise<void>;
	shutdown(): Promise<void>;
	// context surface:
	systemPromptBlock?(): string;
	prefetch?(query: string): Promise<string>;
	syncTurn?(user: string, assistant: string): Promise<void>;
	onPreCompress?(): Promise<string>;
	onSessionEnd?(): Promise<void>;
	getToolDefinitions?(): ToolDefinition[];
	getContextMarkers?(): string[];
}
