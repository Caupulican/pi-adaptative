import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveWorkerAuthority } from "../src/core/delegation/worker-authority-resolver.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";

const model = { id: "m1", provider: "faux" } as Model<Api>;
const modelRegistry = {
	find: () => model,
	hasConfiguredAuth: () => true,
} as unknown as ModelRegistry;

describe("resolveWorkerAuthority", () => {
	it("keeps adaptive workers recursive when an ordinary tool list is narrowed", () => {
		const resolution = resolveWorkerAuthority({
			authority: { toolNames: ["read", "bash"] },
			base: undefined,
			foregroundModel: model,
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["read", "bash", "delegate"]);
		expect(resolution.shipment.profile.capabilityCeiling).toContain("workflow.delegate");
	});

	it("keeps an explicit capability restriction authoritative for leaf workers", () => {
		const resolution = resolveWorkerAuthority({
			authority: {
				capabilities: ["filesystem.read", "process.exec"],
				toolNames: ["read", "bash"],
			},
			base: undefined,
			foregroundModel: model,
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["read", "bash"]);
		expect(resolution.shipment.profile.capabilityCeiling).not.toContain("workflow.delegate");
	});
});
