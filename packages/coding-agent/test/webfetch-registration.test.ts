import { describe, expect, it } from "vitest";
import { requiredCapabilitiesForTool } from "../src/core/autonomy/approval-gate.ts";
import { getDefaultActiveToolNames } from "../src/core/default-tool-surface.ts";
import { classifyToolTrust } from "../src/core/security/untrusted-boundary.ts";
import { envelopeHasToolCapability } from "../src/core/tool-capability-policy.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";

describe("WebFetch registration and authority", () => {
	it("registers a default native public-web tool on both platforms", () => {
		for (const platform of ["linux", "win32"] as const) {
			expect(getDefaultActiveToolNames(platform)).toContain("webfetch");
			expect(createAllToolDefinitions(process.cwd(), undefined, platform)).toHaveProperty("webfetch");
		}
	});
	it("requires HTTP authority, not merely local read or MCP authority", () => {
		expect(requiredCapabilitiesForTool("webfetch")).toEqual(["network.http"]);
		expect(envelopeHasToolCapability(["network.http"], "webfetch")).toBe(true);
		expect(envelopeHasToolCapability(["filesystem.read", "service.mcp"], "webfetch")).toBe(false);
		expect(classifyToolTrust("webfetch")).toBe("untrusted");
		expect(classifyToolTrust("read")).toBe("trusted");
	});
});
