import { FinishReason } from "@google/genai";
import { describe, expect, it } from "vitest";
import { mapStopReason } from "../src/providers/google-shared.ts";

describe("Google finish-reason mapping", () => {
	it("treats the provider's tool-call limit as an error", () => {
		expect(mapStopReason(FinishReason.TOO_MANY_TOOL_CALLS)).toBe("error");
	});
});
