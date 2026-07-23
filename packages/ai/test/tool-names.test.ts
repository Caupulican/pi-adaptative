import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool } from "../src/types.ts";
import { createToolNameMap } from "../src/utils/tool-names.ts";

function tools(...names: string[]): Tool[] {
	return names.map((name) => ({ name, description: name, parameters: Type.Object({}) }));
}

describe("createToolNameMap", () => {
	it("resolves collisions after provider-specific normalization", () => {
		const map = createToolNameMap(tools("read", "Read"), {
			normalizeName: (name) => (name.toLowerCase() === "read" ? "Read" : name),
		});

		expect(map.toProviderName("read")).toBe("Read");
		expect(map.toProviderName("Read")).toBe("Read_2");
		expect(map.toOriginalName("Read")).toBe("read");
		expect(map.toOriginalName("Read_2")).toBe("Read");
	});

	it("sanitizes history-only names and rejects duplicate local identities", () => {
		const map = createToolNameMap(tools("read"));
		expect(map.toProviderName("mcp.server:old_call")).toBe("mcp_server_old_call");
		expect(map.toOriginalName("mcp_server_old_call")).toBe("mcp.server:old_call");
		expect(() => createToolNameMap(tools("read", "read"))).toThrow("Duplicate tool name 'read'");
	});
});
