import { totalmem } from "node:os";
import { deriveLocalContextSizing } from "./context-sizing.ts";
import { registerLocalModel } from "./local-registration.ts";
import type { InstalledLocalModel, OllamaRuntime } from "./local-runtime.ts";
import { planManagedOllamaModel } from "./managed-ollama-model.ts";
import { matchesInstalledLocalModel } from "./model-ref.ts";

/** Pull, size, create and register a model through the same path for every caller. */
export async function installOllamaModel(args: {
	runtime: OllamaRuntime;
	agentDir: string;
	sourceRef: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}): Promise<
	| {
			ok: true;
			modelRef: string;
			provenance: {
				source: InstalledLocalModel;
				served: InstalledLocalModel;
				sizing: ReturnType<typeof deriveLocalContextSizing>;
				profileId?: string;
			};
	  }
	| { ok: false; stage: string; reason: string }
> {
	args.signal?.throwIfAborted();
	const pulled = await args.runtime.pull(args.sourceRef, args.onProgress, args.signal);
	args.signal?.throwIfAborted();
	if (!pulled.ok) return { ok: false, stage: "pull", reason: pulled.error ?? "pull failed" };
	const installed = await args.runtime.list(args.signal);
	args.signal?.throwIfAborted();
	const entry = installed.find((item) => matchesInstalledLocalModel(args.sourceRef, item.name));
	if (!entry)
		return {
			ok: false,
			stage: "inspect",
			reason: `Pulled model ${args.sourceRef} is absent from the server listing`,
		};
	const shown = await args.runtime.show(args.sourceRef, args.signal);
	args.signal?.throwIfAborted();
	if (!shown.ok) return { ok: false, stage: "inspect", reason: shown.error };
	const sizing = deriveLocalContextSizing({
		host: { totalMemBytes: totalmem() },
		model: { modelInfo: shown.info.modelInfo, weightsBytes: entry.sizeBytes },
		runtime: { supportsKvQuantization: true },
	});
	const plan = planManagedOllamaModel({
		sourceRef: args.sourceRef,
		modelInfo: shown.info.modelInfo,
		numCtx: sizing?.numCtx,
	});
	let ref = args.sourceRef;
	if (plan) {
		const created = await args.runtime.createModel({ name: plan.name, ...plan.create }, args.signal);
		args.signal?.throwIfAborted();
		if (!created.ok) return { ok: false, stage: "profile", reason: created.error };
		ref = plan.name;
	}
	const served = plan
		? (await args.runtime.list(args.signal)).find((item) => matchesInstalledLocalModel(ref, item.name))
		: entry;
	args.signal?.throwIfAborted();
	if (!served)
		return { ok: false, stage: "inspect", reason: `Created model ${ref} is absent from the server listing` };
	const servedInfo = plan ? await args.runtime.show(ref, args.signal) : shown;
	args.signal?.throwIfAborted();
	if (!servedInfo.ok) return { ok: false, stage: "inspect", reason: servedInfo.error };
	const registration = registerLocalModel({
		agentDir: args.agentDir,
		ref,
		baseUrl: args.runtime.baseUrl,
		input: servedInfo.info.capabilities.includes("vision") ? ["text", "image"] : ["text"],
		reasoning: servedInfo.info.capabilities.includes("thinking"),
		contextWindow: sizing?.numCtx,
		servedContextWindow: sizing?.numCtx,
	});
	if (!registration.ok)
		return {
			ok: false,
			stage: "registration",
			reason: `${registration.reason ?? "registration failed"}${registration.manualSnippet ? `\nAdd this to ${registration.modelsJsonPath}:\n${registration.manualSnippet}` : ""}`,
		};
	return {
		ok: true,
		modelRef: `ollama/${ref}`,
		provenance: { source: entry, served, sizing, profileId: plan?.profileId },
	};
}
