import { describe, expect, it } from "vitest";
import { evaluateToolGate } from "../src/core/autonomy/gates.ts";
import { getDefaultActiveToolNames } from "../src/core/default-tool-surface.ts";
import { assessOperationRisk } from "../src/core/risk-classifier.ts";
import { WORKER_FORBIDDEN_TOOLS } from "../src/core/session-role.ts";
import { getToolCapabilityPolicy } from "../src/core/tool-capability-policy.ts";

describe("secret_store capability boundary", () => {
	it("is default-active only for the user plane and requires credentials.modify", () => {
		expect(getDefaultActiveToolNames()).toContain("secret_store");
		expect(WORKER_FORBIDDEN_TOOLS.has("secret_store")).toBe(true);
		expect(getToolCapabilityPolicy("secret_store")).toEqual({
			capabilityCandidates: ["credentials.modify"],
			enforcement: "control-plane",
		});
	});

	it("uses its native owner confirmation instead of an outer duplicate approval", () => {
		expect(assessOperationRisk({ operation: "Tool secret_store", toolName: "secret_store" })).toMatchObject({
			risk: "scoped-write",
			reasonCode: "native_owner_secret_flow",
			requiresApproval: false,
		});
		expect(
			evaluateToolGate({
				toolName: "secret_store",
				cwd: "/workspace",
				envelope: {
					id: "secret-envelope",
					allowedTools: ["secret_store"],
					capabilities: ["credentials.modify"],
				},
			}),
		).toMatchObject({ outcome: "allow", reasonCode: "allowed_by_envelope" });
	});
});
