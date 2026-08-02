import type { ArtifactStore } from "../context/context-artifacts.ts";
import type { BroadQueryTracker } from "../context/tool-output-packer.ts";
import { defaultFffSearchBackend, type FffSearchBackend } from "./fff-search-backend.ts";
import { defaultSearchRouter, type SearchRouter } from "./search-router.ts";

export interface SearchToolRuntimeOptions<Operations> {
	operations?: Operations;
	fff?: FffSearchBackend | false;
	searchRouter?: SearchRouter;
	artifactStore?: ArtifactStore;
	broadQueryTracker?: BroadQueryTracker;
}

export function resolveSearchToolRuntime<Operations>(options?: SearchToolRuntimeOptions<Operations>): {
	operations: Operations | undefined;
	fffBackend: FffSearchBackend | undefined;
	searchRouter: SearchRouter;
	artifactStore: ArtifactStore | undefined;
	broadQueryTracker: BroadQueryTracker | undefined;
} {
	return {
		operations: options?.operations,
		fffBackend: options?.fff === false ? undefined : (options?.fff ?? defaultFffSearchBackend),
		searchRouter: options?.searchRouter ?? defaultSearchRouter,
		artifactStore: options?.artifactStore,
		broadQueryTracker: options?.broadQueryTracker,
	};
}
