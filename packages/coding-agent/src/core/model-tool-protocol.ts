import { type Api, isTextToolProtocolVariant, type Model, type SimpleStreamOptions } from "@caupulican/pi-ai";
import type { ModelAdaptationProfile } from "./models/adaptation-store.ts";

export const MODEL_TOOL_PROTOCOL_VERSION = 1;

export type ModelToolProtocolReasonCode =
	| "settings_disabled"
	| "settings_enabled"
	| "model_enabled"
	| "probe_calibrated"
	| "probe_calibration_missing"
	| "probe_calibration_failed"
	| "probe_calibration_invalid"
	| "native_default";

export interface ModelToolProtocolResolution {
	protocol: SimpleStreamOptions["textToolCallProtocol"];
	reasonCode: ModelToolProtocolReasonCode;
	variantsTried?: readonly string[];
}

/**
 * Resolve the effective tool-call transport for any model and execution lane.
 *
 * Explicit settings win, followed by model metadata and then graded probe evidence. A probe-driven
 * text protocol is usable only with a current, recognized calibration; otherwise the model stays on
 * native calls for this turn. Callers use the reason code for diagnostics, but never reimplement the
 * precedence or silently substitute the default dialect.
 */
export function resolveModelToolProtocol(args: {
	model: Pick<Model<Api>, "textToolCallProtocol">;
	settingsOverride?: boolean;
	adaptation: Pick<ModelAdaptationProfile, "protocol" | "toolProbe">;
}): ModelToolProtocolResolution {
	if (args.settingsOverride === false) {
		return { protocol: undefined, reasonCode: "settings_disabled" };
	}
	if (args.settingsOverride === true) {
		return { protocol: true, reasonCode: "settings_enabled" };
	}
	if (args.model.textToolCallProtocol === true) {
		return { protocol: true, reasonCode: "model_enabled" };
	}
	if (args.adaptation.toolProbe?.status !== "text-protocol") {
		return { protocol: undefined, reasonCode: "native_default" };
	}

	const calibration = args.adaptation.protocol;
	if (!calibration) {
		return { protocol: undefined, reasonCode: "probe_calibration_missing" };
	}
	if (calibration.status === "failed") {
		return {
			protocol: undefined,
			reasonCode: "probe_calibration_failed",
			variantsTried: calibration.variantsTried,
		};
	}
	if (calibration.version !== MODEL_TOOL_PROTOCOL_VERSION || !isTextToolProtocolVariant(calibration.variant)) {
		return { protocol: undefined, reasonCode: "probe_calibration_invalid" };
	}
	return {
		protocol: { variant: calibration.variant },
		reasonCode: "probe_calibrated",
	};
}
