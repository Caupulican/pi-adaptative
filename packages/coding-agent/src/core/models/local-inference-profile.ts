import { availableParallelism, totalmem } from "node:os";

export type LocalInferenceProfileMode = "balanced" | "low-impact";

export interface LocalInferenceProfile {
	mode: LocalInferenceProfileMode;
	promptCacheMiB: number;
	maxLoadedModels: number;
	parallelRequests: number;
	maxQueuedRequests: number;
	keepAlive: string;
	kvCacheType: "q8_0";
	flashAttention: boolean;
	generationThreads: number;
	batchThreads: number;
}

interface LocalInferenceHostCapacity {
	mode: LocalInferenceProfileMode;
	totalMemoryBytes: number;
	logicalCpuCount: number;
}

export interface LocalInferenceHostProbes {
	totalMemoryBytes?: () => number;
	logicalCpuCount?: () => number;
}

const GIB = 1024 ** 3;

function boundedThreads(logicalCpuCount: number, maximum: number): number {
	const available = Number.isFinite(logicalCpuCount) ? Math.floor(logicalCpuCount) : 1;
	return Math.max(1, Math.min(maximum, available));
}

/**
 * One provider-neutral owner for local inference resource policy. Runtime adapters translate this
 * validated profile into their native arguments; they must not invent independent cache,
 * residency, concurrency, or thread defaults.
 */
export function deriveLocalInferenceProfile(args: LocalInferenceHostCapacity): LocalInferenceProfile {
	if (args.mode === "low-impact") {
		const threads = boundedThreads(args.logicalCpuCount, 2);
		return {
			mode: args.mode,
			promptCacheMiB: 256,
			maxLoadedModels: 1,
			parallelRequests: 1,
			maxQueuedRequests: 1,
			keepAlive: "2m",
			kvCacheType: "q8_0",
			flashAttention: true,
			generationThreads: threads,
			batchThreads: threads,
		};
	}

	const memoryBytes = Number.isFinite(args.totalMemoryBytes) ? Math.max(0, args.totalMemoryBytes) : 0;
	const capacity =
		memoryBytes >= 64 * GIB
			? { promptCacheMiB: 2_048, maxLoadedModels: 2, maximumThreads: 8 }
			: memoryBytes >= 32 * GIB
				? { promptCacheMiB: 1_024, maxLoadedModels: 2, maximumThreads: 8 }
				: memoryBytes >= 16 * GIB
					? { promptCacheMiB: 768, maxLoadedModels: 1, maximumThreads: 6 }
					: memoryBytes >= 8 * GIB
						? { promptCacheMiB: 512, maxLoadedModels: 1, maximumThreads: 4 }
						: { promptCacheMiB: 256, maxLoadedModels: 1, maximumThreads: 2 };
	const threads = boundedThreads(args.logicalCpuCount, capacity.maximumThreads);
	return {
		mode: args.mode,
		promptCacheMiB: capacity.promptCacheMiB,
		maxLoadedModels: capacity.maxLoadedModels,
		parallelRequests: 1,
		maxQueuedRequests: 4,
		keepAlive: "10m",
		kvCacheType: "q8_0",
		flashAttention: true,
		generationThreads: threads,
		batchThreads: threads,
	};
}

/** Resolves host capacity exactly once through the provider-neutral profile owner. Runtime
 * adapters pass their injectable probes here instead of reproducing host-default selection. */
export function deriveHostLocalInferenceProfile(
	mode: LocalInferenceProfileMode,
	probes: LocalInferenceHostProbes = {},
): LocalInferenceProfile {
	return deriveLocalInferenceProfile({
		mode,
		totalMemoryBytes: (probes.totalMemoryBytes ?? totalmem)(),
		logicalCpuCount: (probes.logicalCpuCount ?? availableParallelism)(),
	});
}

export function ollamaEnvironmentForLocalInferenceProfile(profile: LocalInferenceProfile): Record<string, string> {
	return {
		OLLAMA_FLASH_ATTENTION: profile.flashAttention ? "1" : "0",
		OLLAMA_KV_CACHE_TYPE: profile.kvCacheType,
		OLLAMA_NUM_PARALLEL: String(profile.parallelRequests),
		OLLAMA_MAX_LOADED_MODELS: String(profile.maxLoadedModels),
		OLLAMA_MAX_QUEUE: String(profile.maxQueuedRequests),
		OLLAMA_KEEP_ALIVE: profile.keepAlive,
		LLAMA_ARG_CACHE_RAM: String(profile.promptCacheMiB),
		LLAMA_ARG_THREADS: String(profile.generationThreads),
		LLAMA_ARG_THREADS_BATCH: String(profile.batchThreads),
	};
}
