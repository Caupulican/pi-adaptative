/**
 * Scout model admission: the model the context scout runs on, chosen by the scout setting (an explicit model, or `auto` for
 * the fast-context model) and admitted only when its fitness, tool probe and credentials allow a scout to run. A refusal is
 * returned as a plain failure reason; an admitted model comes with the auth and tool-call protocol its requests use.
 */
import type { Api, Model } from "@caupulican/pi-ai";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveCliModel } from "./model-resolver.ts";
import { evaluateSurfaceFitness } from "./model-router/fitness-gate.ts";
import { resolveModelToolProtocol } from "./model-tool-protocol.ts";
import { ModelAdaptationStore } from "./models/adaptation-store.ts";
import { FitnessStore } from "./models/fitness-store.ts";

export async function resolveScoutModel(
	modelRegistry: ModelRegistry,
	modelSetting: string,
	agentDir: string,
	isModelExhausted: (model: Model<Api>) => boolean = () => false,
	textProtocolOverride?: boolean,
) {
	const model =
		modelSetting === "auto"
			? findFastContextModel(modelRegistry)
			: resolveCliModel({ cliModel: modelSetting, modelRegistry }).model;
	if (!model) {
		return { failure: `no scout model matched ${modelSetting}` };
	}
	if (isModelExhausted(model)) {
		return { failure: `${model.provider}/${model.id} exhausted: quota` };
	}
	const modelRef = `${model.provider}/${model.id}`;
	const adaptation = ModelAdaptationStore.forAgentDir(agentDir).get(modelRef);
	const protocolResolution = resolveModelToolProtocol({
		model,
		settingsOverride: textProtocolOverride,
		adaptation,
	});
	if (modelSetting === "auto") {
		const fitness = FitnessStore.forAgentDir(agentDir)
			.getForHost()
			.find((entry) => entry.model === modelRef);
		const verdict = evaluateSurfaceFitness("scout_auto", fitness?.report);
		if (!verdict.fit) {
			return verdict.reason === "unprobed"
				? { failure: `${modelRef} unprobed — run /fitness before auto-selection` }
				: { failure: `${modelRef} unfit (${verdict.lane} ${verdict.succeeded}/${verdict.total})` };
		}
		const toolProbe = adaptation.toolProbe;
		if (!toolProbe) {
			return { failure: `${modelRef} unprobed — run /toolprobe before auto-selection` };
		}
		if (toolProbe.status === "none") {
			return { failure: `${modelRef} unfit (real tool execution: none)` };
		}
		if (toolProbe.status === "native" && toolProbe.nativeGrade !== "task") {
			return {
				failure: `${modelRef} unfit (real tool execution: native ${toolProbe.nativeGrade ?? "ungraded"})`,
			};
		}
		if (toolProbe.status === "text-protocol" && !protocolResolution.protocol) {
			return { failure: `${modelRef} unfit (real tool execution: phone calibration unavailable)` };
		}
	}
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { failure: auth.error ?? `no usable auth for scout model ${model.provider}/${model.id}` };
	}
	return {
		model,
		apiKey: auth.apiKey,
		headers: auth.headers,
		credentialHeaders: auth.credentialHeaders,
		providerAccountKey: auth.providerAccountKey,
		textToolCallProtocol: protocolResolution.protocol,
	};
}

function findFastContextModel(modelRegistry: ModelRegistry) {
	return modelRegistry.getAll().find((model) => {
		const text = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
		return text.includes("fastcontext");
	});
}
