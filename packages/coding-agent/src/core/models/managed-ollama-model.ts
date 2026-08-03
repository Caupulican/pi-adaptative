import { derivedLocalModelRef, sizedLocalModelRef } from "./context-sizing.ts";
import type { OllamaCreateModelInput, OllamaModelParameter } from "./local-runtime.ts";

export const ORNITH_9B_OLLAMA_REF = "hf.co/deepreinforce-ai/Ornith-1.0-9B-GGUF:Q4_K_M";

const ORNITH_9B_OLLAMA_REPOS = new Set([
	"hf.co/deepreinforce-ai/ornith-1.0-9b-gguf",
	"hf.co/kikocis/ornith-1.0-9b-ollama-fixed-gguf",
]);

interface OllamaRuntimeProfile {
	id: "qwen3.5" | "qwen3.5-ornith";
	template: string;
	renderer: string;
	parser: string;
	parameters: Readonly<Record<string, OllamaModelParameter>>;
}

export interface ManagedOllamaModelPlan {
	name: string;
	create: Omit<OllamaCreateModelInput, "name">;
	profileId?: OllamaRuntimeProfile["id"];
}

function sourceRepository(sourceRef: string): string {
	return sourceRef.replace(/:[^/:]+$/, "").toLowerCase();
}

function resolveOllamaRuntimeProfile(
	sourceRef: string,
	modelInfo: Readonly<Record<string, unknown>>,
): OllamaRuntimeProfile | undefined {
	const isOrnith = ORNITH_9B_OLLAMA_REPOS.has(sourceRepository(sourceRef));
	const architecture =
		typeof modelInfo["general.architecture"] === "string"
			? modelInfo["general.architecture"].trim().toLowerCase()
			: "";
	if (!isOrnith && architecture !== "qwen35") return undefined;
	return {
		id: isOrnith ? "qwen3.5-ornith" : "qwen3.5",
		template: "{{ .Prompt }}",
		renderer: "qwen3.5",
		parser: "qwen3.5",
		parameters: isOrnith ? { temperature: 0.6, top_p: 0.95, top_k: 20 } : {},
	};
}

/**
 * Plan the single Pi-owned derived model used for both context sizing and runtime-specific model
 * requirements. Keeping both concerns in one structured create request prevents a later
 * context-only derivation from silently dropping a required renderer/parser profile.
 */
export function planManagedOllamaModel(args: {
	sourceRef: string;
	modelInfo: Readonly<Record<string, unknown>>;
	numCtx?: number;
}): ManagedOllamaModelPlan | undefined {
	const profile = resolveOllamaRuntimeProfile(args.sourceRef, args.modelInfo);
	if (!profile && args.numCtx === undefined) return undefined;
	if (args.numCtx !== undefined && (!Number.isSafeInteger(args.numCtx) || args.numCtx <= 0)) {
		throw new Error(`numCtx must be a positive safe integer, got ${args.numCtx}`);
	}

	const parameters: Record<string, OllamaModelParameter> = { ...profile?.parameters };
	if (args.numCtx !== undefined) parameters.num_ctx = args.numCtx;
	const create: Omit<OllamaCreateModelInput, "name"> = {
		from: args.sourceRef,
		...(profile
			? {
					template: profile.template,
					renderer: profile.renderer,
					parser: profile.parser,
				}
			: {}),
		...(Object.keys(parameters).length > 0 ? { parameters } : {}),
	};

	return {
		name:
			args.numCtx === undefined
				? derivedLocalModelRef(args.sourceRef, "managed")
				: sizedLocalModelRef(args.sourceRef, args.numCtx),
		create,
		...(profile ? { profileId: profile.id } : {}),
	};
}
