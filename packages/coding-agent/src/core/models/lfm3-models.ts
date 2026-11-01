/**
 * Ollama-backed LFM3 model catalog. These refs are exact quantized tags so setup does not resolve
 * a moving `latest` alias. The advertised context value is copied from the Ollama library; it is
 * catalog metadata, not a promise that the local runtime will accept that entire context.
 */
export interface LFM3ModelDescriptor {
	id: "text" | "vision" | "audio" | "omni";
	name: string;
	sourceRef: string;
	modalities: readonly ("text" | "image" | "audio" | "speech")[];
	/** Ollama's rounded display label only; installed runtime metadata determines usable context. */
	advertisedContext: string;
	minimumOllamaVersion: typeof LFM3_MINIMUM_OLLAMA_VERSION;
}

export const LFM3_MINIMUM_OLLAMA_VERSION = "0.40.13" as const;

export const LFM3_MODELS: readonly LFM3ModelDescriptor[] = [
	{
		id: "text",
		name: "LFM3-1.7B",
		sourceRef: "lfm3:1.7b-q4_K_M",
		modalities: ["text"],
		advertisedContext: "256K",
		minimumOllamaVersion: LFM3_MINIMUM_OLLAMA_VERSION,
	},
	{
		id: "vision",
		name: "LFM3-VL-2B",
		sourceRef: "lfm3-vl:2b-q4_K_M",
		modalities: ["text", "image"],
		advertisedContext: "125K",
		minimumOllamaVersion: LFM3_MINIMUM_OLLAMA_VERSION,
	},
	{
		id: "audio",
		name: "LFM3-Audio-2B",
		sourceRef: "lfm3-audio:2b-q4_K_M",
		modalities: ["text", "audio", "speech"],
		advertisedContext: "125K",
		minimumOllamaVersion: LFM3_MINIMUM_OLLAMA_VERSION,
	},
	{
		id: "omni",
		name: "LFM3-Omni-2B",
		sourceRef: "lfm3-omni:2b-q4_K_M",
		modalities: ["text", "image", "audio", "speech"],
		advertisedContext: "125K",
		minimumOllamaVersion: LFM3_MINIMUM_OLLAMA_VERSION,
	},
];
