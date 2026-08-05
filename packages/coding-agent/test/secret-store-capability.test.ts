import { describe, expect, it } from "vitest";
import { evaluateToolGate } from "../src/core/autonomy/gates.ts";
import { getDefaultActiveToolNames } from "../src/core/default-tool-surface.ts";
import { assessOperationRisk } from "../src/core/risk-classifier.ts";
import { WORKER_FORBIDDEN_TOOLS } from "../src/core/session-role.ts";
import { getToolCapabilityPolicy } from "../src/core/tool-capability-policy.ts";

describe("secret_store capability boundary", () => {
	it("is default-active only for the user plane and requires credentials.use", () => {
		expect(getDefaultActiveToolNames()).toContain("secret_store");
		expect(WORKER_FORBIDDEN_TOOLS.has("secret_store")).toBe(true);
		expect(getToolCapabilityPolicy("secret_store")).toEqual({
			capabilityCandidates: ["credentials.use"],
			enforcement: "service-proxy",
		});
	});

	it("treats an owner-authorized project activation as a non-mutating credential-use operation", () => {
		expect(assessOperationRisk({ operation: "Tool secret_store", toolName: "secret_store" })).toMatchObject({
			risk: "read-only",
			reasonCode: "authorized_credential_use",
			requiresApproval: false,
		});
		expect(
			evaluateToolGate({
				toolName: "secret_store",
				cwd: "/workspace",
				envelope: {
					id: "secret-envelope",
					allowedTools: ["secret_store"],
					capabilities: ["credentials.use"],
				},
			}),
		).toMatchObject({ outcome: "allow", reasonCode: "allowed_by_envelope" });
	});
});
