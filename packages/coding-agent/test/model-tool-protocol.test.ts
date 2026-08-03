import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, test } from "vitest";
import { MODEL_TOOL_PROTOCOL_VERSION, resolveModelToolProtocol } from "../src/core/model-tool-protocol.ts";
import type { ModelAdaptationProfile } from "../src/core/models/adaptation-store.ts";

const model: Model<Api> = {
	id: "model",
	name: "Model",
	api: "openai-completions",
	provider: "provider",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 2_048,
};

function adaptation(overrides: Partial<ModelAdaptationProfile> = {}): ModelAdaptationProfile {
	return { rules: [], teachStats: {}, ...overrides };
}

describe("resolveModelToolProtocol", () => {
	test("uses explicit settings before model and probe metadata", () => {
		const textModel = { ...model, textToolCallProtocol: true };
		expect(resolveModelToolProtocol({ model: textModel, settingsOverride: false, adaptation: adaptation() })).toEqual(
			{ protocol: undefined, reasonCode: "settings_disabled" },
		);
		expect(resolveModelToolProtocol({ model, settingsOverride: true, adaptation: adaptation() })).toEqual({
			protocol: true,
			reasonCode: "settings_enabled",
		});
	});

	test("preserves a model-declared text protocol without requiring calibration", () => {
		const textModel = { ...model, textToolCallProtocol: true };
		expect(resolveModelToolProtocol({ model: textModel, adaptation: adaptation() })).toEqual({
			protocol: true,
			reasonCode: "model_enabled",
		});
	});

	test("keeps a proven native model off the text protocol even when settings or model metadata enable it", () => {
		const nativeProfile = adaptation({
			toolProbe: {
				version: MODEL_TOOL_PROTOCOL_VERSION,
				status: "native",
				nativeGrade: "task",
				probedAt: "2026-08-02T00:00:00.000Z",
			},
		});
		const textModel = { ...model, textToolCallProtocol: true };

		expect(resolveModelToolProtocol({ model, settingsOverride: true, adaptation: nativeProfile })).toEqual({
			protocol: undefined,
			reasonCode: "probe_native",
		});
		expect(resolveModelToolProtocol({ model: textModel, adaptation: nativeProfile })).toEqual({
			protocol: undefined,
			reasonCode: "probe_native",
		});
	});

	test("returns the calibrated variant for every execution lane", () => {
		const profile = adaptation({
			toolProbe: {
				version: MODEL_TOOL_PROTOCOL_VERSION,
				status: "text-protocol",
				variant: "function-xml",
				probedAt: "2026-07-23T00:00:00.000Z",
			},
			protocol: {
				version: MODEL_TOOL_PROTOCOL_VERSION,
				status: "calibrated",
				variant: "function-xml",
				calibratedAt: "2026-07-23T00:00:00.000Z",
			},
		});
		expect(resolveModelToolProtocol({ model, adaptation: profile })).toEqual({
			protocol: { variant: "function-xml" },
			reasonCode: "probe_calibrated",
		});
	});

	test("does not guess a dialect when probe calibration is missing", () => {
		const profile = adaptation({
			toolProbe: {
				version: MODEL_TOOL_PROTOCOL_VERSION,
				status: "text-protocol",
				variant: "tool-call",
				probedAt: "2026-07-23T00:00:00.000Z",
			},
		});
		expect(resolveModelToolProtocol({ model, adaptation: profile })).toEqual({
			protocol: undefined,
			reasonCode: "probe_calibration_missing",
		});
	});

	test("rejects stale or unknown persisted dialects", () => {
		const stale = adaptation({
			toolProbe: {
				version: MODEL_TOOL_PROTOCOL_VERSION,
				status: "text-protocol",
				probedAt: "2026-07-23T00:00:00.000Z",
			},
			protocol: {
				version: MODEL_TOOL_PROTOCOL_VERSION + 1,
				variant: "unknown-dialect",
				calibratedAt: "2026-07-23T00:00:00.000Z",
			},
		});
		expect(resolveModelToolProtocol({ model, adaptation: stale }).reasonCode).toBe("probe_calibration_invalid");
	});
});
