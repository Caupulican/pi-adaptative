export type MemorySurface = "context" | "routing" | "tooling" | "parametric";

/** Where raw memory queries are processed. Omitted classifications fail closed as external. */
export type MemoryProviderEgress = "local" | "external";

export interface MemoryCapabilities {
	surfaces: MemorySurface[];
}

export interface MemoryLifecycleContext {
	agentDir: string;
	cwd: string;
	isChildSession: boolean;
}
