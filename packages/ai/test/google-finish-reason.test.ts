import { FinishReason, FunctionCallingConfigMode, ThinkingLevel } from "@google/genai";
import { describe, expect, it } from "vitest";
import { mapStopReason, mapToolChoice, toGoogleGenAiThinkingConfig } from "../src/providers/google-shared.ts";

describe("Google finish-reason mapping", () => {
	it("treats the provider's tool-call limit as an error", () => {
		expect(mapStopReason(FinishReason.TOO_MANY_TOOL_CALLS)).toBe("error");
	});
	it("maps every installed SDK finish reason and refuses unknown reasons", () => {
		for (const reason of Object.values(FinishReason)) {
			const expected =
				reason === FinishReason.STOP ? "stop" : reason === FinishReason.MAX_TOKENS ? "length" : "error";
			expect(mapStopReason(reason), reason).toBe(expected);
		}
		expect(() => mapStopReason("UNKNOWN_FIXTURE" as FinishReason)).toThrow("Unhandled stop reason");
	});
	it("serializes tool modes identically to the installed SDK", () => {
		expect(mapToolChoice("auto")).toBe(FunctionCallingConfigMode.AUTO);
		expect(mapToolChoice("none")).toBe(FunctionCallingConfigMode.NONE);
		expect(mapToolChoice("any")).toBe(FunctionCallingConfigMode.ANY);
		expect(mapToolChoice("unknown")).toBe(FunctionCallingConfigMode.AUTO);
	});
	it("serializes every installed SDK thinking level without changing budget fields", () => {
		for (const thinkingLevel of Object.values(ThinkingLevel)) {
			expect(toGoogleGenAiThinkingConfig({ thinkingLevel, thinkingBudget: 123 }, true)).toEqual({
				thinkingLevel,
				thinkingBudget: 123,
				includeThoughts: true,
			});
		}
		expect(toGoogleGenAiThinkingConfig({})).toEqual({});
	});
});
