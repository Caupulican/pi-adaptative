import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	bindCompiledVerifierIdentity,
	resolveWorkerAuthority,
} from "../src/core/delegation/worker-authority-resolver.ts";
import type { ResolvedWorkerProfile } from "../src/core/delegation/worker-profile-resolver.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";

const model = { id: "m1", provider: "faux", reasoning: true } as Model<Api>;
const modelRegistry = {
	find: () => model,
	hasConfiguredAuth: () => true,
} as unknown as ModelRegistry;

describe("resolveWorkerAuthority", () => {
	it("makes every adaptive worker a leaf even when an ordinary tool list is narrowed", () => {
		const resolution = resolveWorkerAuthority({
			authority: { toolNames: ["read", "bash"] },
			base: undefined,
			foregroundModel: model,
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["read", "bash"]);
		expect(resolution.shipment.profile.capabilityCeiling).not.toContain("workflow.delegate");
		expect(resolution.shipment.profile.delegationLimits).toEqual({
			maxDepth: 0,
			maxChildrenPerAgent: 0,
			maxNestedAgentsPerSession: 0,
		});
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

	it("admits the read-only memory surface with memory.query authority", () => {
		const resolution = resolveWorkerAuthority({
			authority: {
				capabilities: ["memory.query"],
				toolNames: ["memory"],
			},
			base: undefined,
			foregroundModel: model,
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["memory"]);
		expect(resolution.shipment.profile.capabilityCeiling).toEqual(["memory.query"]);
	});

	it("inherits every compatible active foreground tool and strips root-only tools", () => {
		const resolution = resolveWorkerAuthority({
			foregroundModel: model,
			foregroundToolNames: ["read", "python", "delegate", "goal", "reflection"],
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["read", "python"]);
	});

	it("inherits run_toolkit_script only when it is active in the foreground, and keeps explicit requests deterministic", () => {
		const inherited = resolveWorkerAuthority({
			foregroundModel: model,
			foregroundToolNames: ["read", "run_toolkit_script"],
			modelRegistry,
			isModelExhausted: () => false,
		});
		expect(inherited.ok).toBe(true);
		if (inherited.ok) expect(inherited.shipment.profile.toolNames).toEqual(["read", "run_toolkit_script"]);

		const explicit = resolveWorkerAuthority({
			authority: { toolNames: ["run_toolkit_script"] },
			foregroundModel: model,
			foregroundToolNames: ["run_toolkit_script"],
			modelRegistry,
			isModelExhausted: () => false,
		});
		expect(explicit.ok).toBe(true);
		if (explicit.ok) expect(explicit.shipment.profile.toolNames).toEqual(["run_toolkit_script"]);

		const unavailable = resolveWorkerAuthority({
			authority: { toolNames: ["run_toolkit_script"] },
			foregroundModel: model,
			foregroundToolNames: ["read"],
			modelRegistry,
			isModelExhausted: () => false,
		});
		expect(unavailable).toEqual({
			ok: false,
			reason: "orchestration_tool_unavailable:run_toolkit_script",
		});
	});

	it("rejects an explicit classified tool when its capability is unavailable", () => {
		const resolution = resolveWorkerAuthority({
			authority: { toolNames: ["python"] },
			foregroundModel: model,
			foregroundEnvelope: { id: "read-only", capabilities: ["filesystem.read"] },
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution).toEqual({
			ok: false,
			reason: "orchestration_tool_capability_missing:python",
		});
	});

	it("rejects a sibling tool that was not active in the inherited foreground surface", () => {
		const resolution = resolveWorkerAuthority({
			authority: { toolNames: ["write"] },
			foregroundModel: model,
			foregroundToolNames: ["edit"],
			foregroundEnvelope: { id: "write-capable", capabilities: ["filesystem.write"] },
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution).toEqual({
			ok: false,
			reason: "orchestration_tool_unavailable:write",
		});
	});

	it("preserves a base identity only when compiled content is unchanged", () => {
		const alternateModel = { id: "m2", provider: "faux", reasoning: true } as Model<Api>;
		const identityRegistry = {
			find: (_provider: string, modelId: string) => (modelId === alternateModel.id ? alternateModel : model),
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry;
		const profile = Object.assign(
			createTestWorkerOrchestrationProfile({
				profileId: "exact-leaf-base",
				model,
				capabilityCeiling: ["filesystem.read", "process.exec"],
				toolNames: ["read", "python"],
			}),
			{ delegationLimits: { maxDepth: 0, maxChildrenPerAgent: 0, maxNestedAgentsPerSession: 0 } },
		);
		const base: ResolvedWorkerProfile = {
			model,
			modelBinding: { provider: model.provider, modelId: model.id, thinkingLevel: "off" },
			profile,
			resourcePointers: [],
		};
		const exact = resolveWorkerAuthority({
			base,
			modelRegistry: identityRegistry,
			isModelExhausted: () => false,
		});
		expect(exact.ok).toBe(true);
		if (!exact.ok) return;
		expect(exact.shipment.profile).toEqual(profile);

		const overrides = [
			{ model: { provider: alternateModel.provider, modelId: alternateModel.id } },
			{ thinkingLevel: "low" as const },
			{ path: "/tmp/another-project" },
			{ toolNames: ["read"] },
		];
		const derivedIds = overrides.map((authority) => {
			const resolution = resolveWorkerAuthority({
				authority,
				base,
				cwd: "/repo",
				modelRegistry: identityRegistry,
				isModelExhausted: () => false,
			});
			expect(resolution.ok).toBe(true);
			if (!resolution.ok) return "";
			return resolution.shipment.profile.profileId;
		});
		expect(derivedIds).not.toContain(profile.profileId);
		expect(new Set(derivedIds).size).toBe(derivedIds.length);
	});

	it("derives a new implementation identity when a verifier compiles to a new identity", () => {
		const profile = Object.assign(
			createTestWorkerOrchestrationProfile({
				profileId: "implementation-source",
				model,
				capabilityCeiling: ["filesystem.read"],
				toolNames: ["read"],
			}),
			{
				requireIndependentVerification: true,
				verificationProfileId: "verifier-source",
				delegationLimits: { maxDepth: 0, maxChildrenPerAgent: 0, maxNestedAgentsPerSession: 0 },
			},
		);
		const shipment: ResolvedWorkerProfile = {
			model,
			modelBinding: { provider: model.provider, modelId: model.id, thinkingLevel: "off" },
			profile,
			resourcePointers: [],
		};

		const rebound = bindCompiledVerifierIdentity(shipment, "adaptive-verifier");

		expect(rebound.profile.verificationProfileId).toBe("adaptive-verifier");
		expect(rebound.profile.profileId).toMatch(/^adaptive-/);
		expect(rebound.profile.profileId).not.toBe(profile.profileId);
		expect(bindCompiledVerifierIdentity(rebound, "adaptive-verifier")).toBe(rebound);
	});
});
