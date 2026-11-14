import type { SessionCapabilities } from "../session-standing.ts";

export type MemorySurface = "context" | "routing" | "tooling" | "parametric";

/** Where raw memory queries are processed. Omitted classifications fail closed as external. */
export type MemoryProviderEgress = "local" | "external";

export interface MemoryCapabilities {
	surfaces: MemorySurface[];
}

/** What the session's memory may do, from its standing (`session-standing.ts`); every provider is initialized with it. */
export type MemoryStanding = Pick<SessionCapabilities, "readsOwnerMemory" | "ownsMemoryWrites" | "ownsHistory">;

export interface MemoryLifecycleContext extends MemoryStanding {
	agentDir: string;
	cwd: string;
	/** @deprecated Read `ownsMemoryWrites`, `ownsHistory` or `readsOwnerMemory`. True where the session writes no owner memory. */
	isChildSession: boolean;
}

/** What `MemoryManager.initializeAll` takes: the session's memory standing, or the deprecated child flag (true: none of it). */
export type MemoryLifecycleInput = { agentDir: string; cwd: string } & (MemoryStanding | { isChildSession: boolean });

/** The context every provider is initialized with; the one place the deprecated child flag is read or derived. */
export function memoryLifecycleContext(input: MemoryLifecycleInput): MemoryLifecycleContext {
	const { agentDir, cwd } = input;
	const { readsOwnerMemory, ownsMemoryWrites, ownsHistory } =
		"ownsMemoryWrites" in input
			? input
			: {
					readsOwnerMemory: !input.isChildSession,
					ownsMemoryWrites: !input.isChildSession,
					ownsHistory: !input.isChildSession,
				};
	return { agentDir, cwd, readsOwnerMemory, ownsMemoryWrites, ownsHistory, isChildSession: !ownsMemoryWrites };
}
