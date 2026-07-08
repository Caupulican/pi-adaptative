const CONTEXT_RUNGS = [4_096, 8_192, 16_384, 32_768] as const;
const DEFAULT_HEADROOM_FRACTION = 0.8;
const F16_BYTES = 2;
const Q8_BYTES = 1;

export interface ContextSizingModelInfo {
	modelInfo: Record<string, unknown>;
	weightsBytes: number;
}

export interface ContextSizingHostProfile {
	totalMemBytes: number;
	headroomFraction?: number;
}

export interface ContextSizingRuntimeCaps {
	supportsKvQuantization?: boolean;
}

export interface ContextSizingDecision {
	numCtx: number;
	kvCacheType?: "q8_0";
	kvBytesPerToken: number;
	budgetBytes: number;
	estimatedBytes: number;
}

export function deriveLocalContextSizing(args: {
	host: ContextSizingHostProfile;
	model: ContextSizingModelInfo;
	runtime?: ContextSizingRuntimeCaps;
	rungs?: readonly number[];
}): ContextSizingDecision | undefined {
	const kvShape = deriveKvShape(args.model.modelInfo);
	if (!kvShape) return undefined;
	const headroomFraction = args.host.headroomFraction ?? DEFAULT_HEADROOM_FRACTION;
	const budgetBytes = Math.floor(args.host.totalMemBytes * headroomFraction);
	const availableKvBytes = budgetBytes - args.model.weightsBytes;
	if (availableKvBytes <= 0) return undefined;
	const rungs = args.rungs ?? CONTEXT_RUNGS;
	const f16Decision = chooseContextRung({ availableKvBytes, bytesPerElement: F16_BYTES, budgetBytes, kvShape, rungs });
	if (!args.runtime?.supportsKvQuantization) return f16Decision;
	const q8Decision = chooseContextRung({
		availableKvBytes,
		bytesPerElement: Q8_BYTES,
		budgetBytes,
		kvCacheType: "q8_0",
		kvShape,
		rungs,
	});
	if (q8Decision && (!f16Decision || q8Decision.numCtx > f16Decision.numCtx)) return q8Decision;
	return f16Decision;
}

export function renderOllamaContextModelfile(args: { from: string; numCtx: number }): string {
	return `FROM ${args.from}\nPARAMETER num_ctx ${args.numCtx}\n`;
}

export function sizedLocalModelRef(sourceRef: string, numCtx: number): string {
	const safeSource = sourceRef.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "local-model";
	return `pi-${safeSource}:ctx${numCtx}`;
}

function chooseContextRung(args: {
	availableKvBytes: number;
	bytesPerElement: number;
	budgetBytes: number;
	kvCacheType?: "q8_0";
	kvShape: { elementsPerToken: number };
	rungs: readonly number[];
}): ContextSizingDecision | undefined {
	const kvBytesPerToken = args.kvShape.elementsPerToken * args.bytesPerElement;
	for (const numCtx of [...args.rungs].sort((a, b) => b - a)) {
		const estimatedBytes = kvBytesPerToken * numCtx;
		if (estimatedBytes <= args.availableKvBytes) {
			return {
				numCtx,
				kvCacheType: args.kvCacheType,
				kvBytesPerToken,
				budgetBytes: args.budgetBytes,
				estimatedBytes,
			};
		}
	}
	return undefined;
}

function deriveKvShape(modelInfo: Record<string, unknown>): { elementsPerToken: number } | undefined {
	const layers = firstPositiveNumber(modelInfo, ["llama.block_count", "qwen2.block_count", "gemma3.block_count"]);
	if (!layers) return undefined;
	const headCountKv = firstPositiveNumber(modelInfo, [
		"llama.attention.head_count_kv",
		"qwen2.attention.head_count_kv",
		"gemma3.attention.head_count_kv",
	]);
	const keyLength = firstPositiveNumber(modelInfo, [
		"llama.attention.key_length",
		"qwen2.attention.key_length",
		"gemma3.attention.key_length",
	]);
	const valueLength = firstPositiveNumber(modelInfo, [
		"llama.attention.value_length",
		"qwen2.attention.value_length",
		"gemma3.attention.value_length",
	]);
	if (headCountKv && keyLength && valueLength) {
		return { elementsPerToken: layers * headCountKv * (keyLength + valueLength) };
	}
	const embeddingLength = firstPositiveNumber(modelInfo, [
		"llama.embedding_length",
		"qwen2.embedding_length",
		"gemma3.embedding_length",
	]);
	return embeddingLength ? { elementsPerToken: layers * embeddingLength * 2 } : undefined;
}

function firstPositiveNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}
