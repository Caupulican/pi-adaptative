import { TOOL_SCHEMA_SEARCH_DETAILS_KIND, TOOL_SCHEMA_SEARCH_NAME } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { evaluateToolGate } from "../src/core/autonomy/gates.ts";
import { CLASSIFIED_LANE_TOOL_NAMES } from "../src/core/orchestration/lane-tool-manifests.ts";
import {
	resolveProfileToolCapabilities,
	resolveToolCallCapabilities,
	toolSurvivesReadOnly,
} from "../src/core/tool-capability-policy.ts";
import { createToolSchemaSearchDefinition } from "../src/core/tools/tool_search.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

describe("tool schema disclosure wiring", () => {
	it("emits bounded trusted search details without performing provider work", async () => {
		const tool = wrapToolDefinition(createToolSchemaSearchDefinition());
		const result = await tool.execute("search-1", { query: "memory persistence", maxResults: 3 });

		expect(tool.readOnly).toBe(true);
		expect(result.details).toEqual({
			kind: TOOL_SCHEMA_SEARCH_DETAILS_KIND,
			query: "memory persistence",
			maxResults: 3,
		});
		expect(result.content).toEqual([{ type: "text", text: 'Searching deferred tools for "memory persistence".' }]);
	});

	it("classifies schema search as known zero-authority infrastructure", () => {
		expect(resolveToolCallCapabilities([], TOOL_SCHEMA_SEARCH_NAME)).toEqual([]);
		expect(resolveProfileToolCapabilities({ capabilityCeiling: [] }, TOOL_SCHEMA_SEARCH_NAME)).toEqual([]);
		expect(resolveToolCallCapabilities([], "unknown_tool")).toBeUndefined();
		expect(toolSurvivesReadOnly(TOOL_SCHEMA_SEARCH_NAME)).toBe(true);
		expect(CLASSIFIED_LANE_TOOL_NAMES).toContain(TOOL_SCHEMA_SEARCH_NAME);
		expect(
			evaluateToolGate({
				toolName: TOOL_SCHEMA_SEARCH_NAME,
				cwd: "/tmp",
				envelope: { id: "zero-authority", capabilities: [] },
			}),
		).toMatchObject({ outcome: "allow" });
	});
});
