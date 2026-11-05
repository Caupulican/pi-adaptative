import type { ArtifactStore } from "../context/context-artifacts.ts";
import type { BroadQueryTracker } from "../context/tool-output-packer.ts";
import { defaultFffSearchBackend, type FffSearchBackend } from "./fff-search-backend.ts";
import type { ReadOperationFactory } from "./read-operation-context.ts";
import { defaultSearchRouter, type SearchRouter } from "./search-router.ts";

export interface SearchToolRuntimeOptions<Operations> {
	readOperation?: ReadOperationFactory;
	operations?: Operations;
	fff?: FffSearchBackend | false;
	searchRouter?: SearchRouter;
	artifactStore?: ArtifactStore;
	broadQueryTracker?: BroadQueryTracker;
}

export function resolveSearchToolRuntime<Operations>(options?: SearchToolRuntimeOptions<Operations>): {
	strategy: "bounded-local" | "routed";
	operations: Operations | undefined;
	fffBackend: FffSearchBackend | undefined;
	searchRouter: SearchRouter;
	artifactStore: ArtifactStore | undefined;
	broadQueryTracker: BroadQueryTracker | undefined;
} {
	return {
		strategy: options?.readOperation ? "bounded-local" : "routed",
		operations: options?.operations,
		fffBackend:
			options?.readOperation || options?.fff === false ? undefined : (options?.fff ?? defaultFffSearchBackend),
		searchRouter: options?.searchRouter ?? defaultSearchRouter,
		artifactStore: options?.artifactStore,
		broadQueryTracker: options?.broadQueryTracker,
	};
}
