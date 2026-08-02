import type { ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { getToolResultArtifactId, getToolResultText } from "../src/core/context/context-tool-result.ts";

function toolResult(details?: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [
			{ type: "text", text: "first" },
			{ type: "image", data: "AA==", mimeType: "image/png" },
			{ type: "text", text: "second" },
		],
		details,
		isError: false,
		timestamp: 1,
	};
}

describe("context tool-result projection", () => {
	it("joins only visible text blocks in their original order", () => {
		expect(getToolResultText(toolResult())).toBe("first\nsecond");
	});

	it("accepts only string artifact identities", () => {
		expect(getToolResultArtifactId({ artifactId: "artifact-1" })).toBe("artifact-1");
		expect(getToolResultArtifactId({ artifactId: 1 })).toBeUndefined();
		expect(getToolResultArtifactId(null)).toBeUndefined();
	});
});
