import type { Api, Model } from "@caupulican/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import { resolveWorkerAuthority } from "../src/core/delegation/worker-authority-resolver.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationModelBinding,
	type OrchestrationProfile,
} from "../src/core/orchestration/contracts.ts";
import { compileWorkerModelPinPolicy, resolveWorkerModelPin } from "../src/core/orchestration/worker-model-pins.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";
import { createHarness } from "./suite/harness.ts";

const foreground = { id: "foreground", provider: "faux", reasoning: true } as Model<Api>;
const requested = { id: "requested", provider: "faux", reasoning: true } as Model<Api>;
const pinned = { id: "pinned", provider: "faux", reasoning: true } as Model<Api>;
const models = new Map([foreground, requested, pinned].map((model) => [model.id, model]));
const modelRegistry = {
	find: (provider: string, modelId: string) => (provider === "faux" ? models.get(modelId) : undefined),
	hasConfiguredAuth: () => true,
} as unknown as ModelRegistry;

const luna = { provider: "faux", modelId: "pinned", thinkingLevel: "high" as const };
const terra = { provider: "faux", modelId: "requested", thinkingLevel: "medium" as const };

function workerProfile(modelId: string, overrides: Partial<OrchestrationProfile> = {}): OrchestrationProfile {
	const now = new Date().toISOString();
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "model-pin-worker",
		description: "Worker model-pin regression profile",
		role: "implementer",
		modelPolicy: { mode: "fixed", candidates: [{ provider: "faux", modelId, thinkingLevel: "off" }] },
		capabilityCeiling: ["filesystem.read"],
		toolNames: ["read"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxCostUsd: 1, maxTokens: 8_192, maxToolCalls: 4, maxWallClockMs: 60_000 },
		maxConcurrent: 1,
		leaseTtlMs: 90_000,
		requireIndependentVerification: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("worker model pin policy", () => {
	it("keeps the policy absent when no scope opts in", () => {
		const policy = compileWorkerModelPinPolicy({});

		expect(policy).toEqual({ status: "absent" });
		expect(resolveWorkerModelPin(policy, "implementer")).toBeUndefined();
	});

	it("lets global role and default pins dominate trusted local settings", () => {
		const policy = compileWorkerModelPinPolicy({
			global: {
				default: luna,
				roles: { verifier: terra },
			},
			project: {
				default: terra,
				roles: { implementer: terra, verifier: luna },
			},
		});

		expect(resolveWorkerModelPin(policy, "implementer")).toEqual({ binding: luna, source: "global" });
		expect(resolveWorkerModelPin(policy, "verifier")).toEqual({ binding: terra, source: "global" });
	});

	it("lets a trusted project fill roles that global settings leave adaptive", () => {
		const policy = compileWorkerModelPinPolicy({
			global: { roles: { implementer: luna } },
			project: { roles: { explorer: terra } },
		});

		expect(resolveWorkerModelPin(policy, "implementer")?.source).toBe("global");
		expect(resolveWorkerModelPin(policy, "explorer")).toEqual({ binding: terra, source: "project" });
		expect(resolveWorkerModelPin(policy, "planner")).toBeUndefined();
	});

	it("uses trusted local roles before trusted local defaults and gives the directory overlay local priority", () => {
		const policy = compileWorkerModelPinPolicy({
			project: { default: terra, roles: { explorer: terra, operator: terra } },
			directoryProfile: { default: luna, roles: { explorer: luna } },
		});

		expect(resolveWorkerModelPin(policy, "explorer")).toEqual({ binding: luna, source: "directoryProfile" });
		expect(resolveWorkerModelPin(policy, "operator")).toEqual({ binding: terra, source: "project" });
		expect(resolveWorkerModelPin(policy, "planner")).toEqual({ binding: luna, source: "directoryProfile" });
	});

	it("marks malformed configured policy invalid instead of silently adapting", () => {
		const policy = compileWorkerModelPinPolicy({
			global: { roles: { implementer: { provider: "faux", modelId: "pinned" } } },
		});

		expect(policy.status).toBe("invalid");
	});

	it("preserves global pins when project settings try to replace them", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ workerDelegation: { modelPins: { roles: { implementer: luna } } } }),
		);
		storage.withLock("project", () =>
			JSON.stringify({ workerDelegation: { modelPins: { roles: { implementer: terra, explorer: terra } } } }),
		);
		const settings = SettingsManager.fromStorage(storage);

		expect(resolveWorkerModelPin(settings.getWorkerModelPinPolicy(), "implementer")).toEqual({
			binding: luna,
			source: "global",
		});
		expect(resolveWorkerModelPin(settings.getWorkerModelPinPolicy(), "explorer")).toEqual({
			binding: terra,
			source: "project",
		});
	});

	it("does not admit pins from an untrusted project", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () =>
			JSON.stringify({ workerDelegation: { modelPins: { roles: { implementer: terra } } } }),
		);

		const settings = SettingsManager.fromStorage(storage, { projectTrusted: false });

		expect(settings.getWorkerModelPinPolicy()).toEqual({ status: "absent" });
	});

	it("preserves configured pins when the ordinary worker-settings editor saves another field", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ workerDelegation: { modelPins: { roles: { implementer: luna } } } }),
		);
		const settings = SettingsManager.fromStorage(storage);

		settings.setWorkerDelegationSettings({ maxConcurrent: 3 });
		await settings.flush();
		let persisted: string | undefined;
		storage.withLock("global", (current) => {
			persisted = current;
			return undefined;
		});

		expect(resolveWorkerModelPin(settings.getWorkerModelPinPolicy(), "implementer")?.binding).toEqual(luna);
		expect(JSON.parse(persisted ?? "{}").workerDelegation.modelPins.roles.implementer).toEqual(luna);
	});

	it("adds mandatory Caveman guidance only while a pin policy is active", () => {
		const dependencies = {
			caller: { kind: "session_root" as const },
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		};
		const baseline = createDelegateToolDefinition(dependencies);
		const absent = createDelegateToolDefinition({
			...dependencies,
			workerModelPinPolicy: compileWorkerModelPinPolicy({}),
		});
		const active = createDelegateToolDefinition({
			...dependencies,
			workerModelPinPolicy: compileWorkerModelPinPolicy({ global: { roles: { implementer: luna } } }),
		});

		expect(baseline.promptGuidelines?.join("\n")).not.toContain("pins win fresh model/thinking");
		expect(absent.promptGuidelines).toEqual(baseline.promptGuidelines);
		expect(active.promptGuidelines?.join("\n")).toContain("CAVEMAN MODE - MANDATORY");
		expect(active.promptGuidelines?.join("\n")).toContain("pins win fresh model/thinking");
	});
});

describe("worker model pin admission", () => {
	it("overrides an agent-selected model and thinking level without changing its role or tools", () => {
		const resolution = resolveWorkerAuthority({
			authority: {
				role: "implementer",
				model: { provider: "faux", modelId: "requested" },
				thinkingLevel: "low",
				toolNames: ["read", "bash"],
			},
			modelPin: luna,
			foregroundModel: foreground,
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.modelBinding).toEqual(luna);
		expect(resolution.shipment.profile.role).toBe("implementer");
		expect(resolution.shipment.profile.toolNames).toEqual(["read", "bash", "delegate"]);
	});

	it("keeps explicit authority selection unchanged when no pin applies", () => {
		const resolution = resolveWorkerAuthority({
			authority: {
				role: "implementer",
				model: { provider: "faux", modelId: "requested" },
				thinkingLevel: "low",
			},
			foregroundModel: foreground,
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.modelBinding).toEqual({
			provider: "faux",
			modelId: "requested",
			thinkingLevel: "low",
		});
	});

	it("does not fall back when the pinned model is unavailable", () => {
		const resolution = resolveWorkerAuthority({
			authority: {
				role: "implementer",
				model: { provider: "faux", modelId: "requested" },
			},
			modelPin: { provider: "faux", modelId: "missing", thinkingLevel: "high" },
			foregroundModel: foreground,
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution).toEqual({ ok: false, reason: "orchestration_model_unavailable" });
	});
});

describe("worker model pin lifecycle", () => {
	it("binds a valid pin before an unavailable profile candidate and reports the durable effective model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "requested", contextWindow: 128_000, reasoning: true },
				{ id: "pinned", contextWindow: 128_000, reasoning: true },
			],
			settings: { workerDelegation: { modelPins: { roles: { implementer: luna } } } },
			workerOrchestrationProfile: workerProfile("profile-model-is-unavailable"),
		});
		let observedModelId = "";
		try {
			harness.setResponses([
				(_context, _options, _state, model) => {
					observedModelId = model.id;
					return fauxAssistantMessage('{"summary":"pin honored","status":"completed"}');
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use the exact owner model pin.",
				authority: {
					role: "implementer",
					model: { provider: "faux", modelId: "requested" },
					thinkingLevel: "low",
				},
			});

			expect(run.started).toBe(true);
			expect(observedModelId).toBe("pinned");
			expect(run.record).toMatchObject({ modelRef: "faux/pinned", thinkingLevel: "high" });
			if (!run.record) throw new Error("Expected a durable worker record.");
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const attemptId = snapshot.tasks[run.record.laneId]?.attemptIds.at(-1);
			expect(
				attemptId ? snapshot.attempts[attemptId]?.dispatch.executionContract?.worker.modelBinding : undefined,
			).toEqual(luna);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps a reused agent on its admitted pin while a fresh identity observes changed settings", async () => {
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "requested", contextWindow: 128_000, reasoning: true },
				{ id: "pinned", contextWindow: 128_000, reasoning: true },
			],
			settings: { workerDelegation: { modelPins: { roles: { implementer: luna } } } },
			workerOrchestrationProfile: workerProfile("profile-model-is-unavailable"),
		});
		const observedModelIds: string[] = [];
		try {
			const routeResponse = (
				context: { systemPrompt?: string },
				_options: unknown,
				_state: unknown,
				model: Model<Api>,
			) => {
				if (!context.systemPrompt?.includes("Autonomous orchestration-tree agent")) {
					return fauxAssistantMessage("Terminal handoff observed.");
				}
				observedModelIds.push(model.id);
				return fauxAssistantMessage('{"summary":"worker task complete","status":"completed"}');
			};
			harness.setResponses(Array.from({ length: 6 }, () => routeResponse));

			const initial = await harness.session.runWorkerDelegationOnce({
				instructions: "Create a reusable specialist.",
			});
			if (!initial.started || !initial.record) throw new Error("Expected the first worker identity to start.");
			expect(initial.record).toMatchObject({ modelRef: "faux/pinned", thinkingLevel: "high" });

			harness.settingsManager.setWorkerDelegationSettings({
				orchestrationProfile: "model-pin-worker",
				modelPins: { roles: { implementer: terra } },
			});
			const control = (
				harness.session as unknown as {
					_backgroundLanes: {
						startWorkerAgentTask(
							agentId: string,
							message: string,
							options: { idempotencyKey: string },
						): { started: boolean; skipReason?: string };
					};
				}
			)._backgroundLanes;
			const reused = control.startWorkerAgentTask(initial.record.laneId, "Continue on the admitted contract.", {
				idempotencyKey: "model-pin-reuse-after-settings-change",
			});
			expect(reused.started, reused.skipReason).toBe(true);
			await vi.waitFor(() => expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(2));

			const fresh = await harness.session.runWorkerDelegationOnce({ instructions: "Create a fresh specialist." });
			expect(fresh.started).toBe(true);
			expect(fresh.record).toMatchObject({ modelRef: "faux/requested", thinkingLevel: "medium" });
			expect(observedModelIds).toEqual(["pinned", "pinned", "requested"]);
		} finally {
			await harness.cleanup();
		}
	});

	it("blocks malformed settings before a worker or provider request is created", async () => {
		const malformed = {
			provider: "faux",
			modelId: "pinned",
		} as unknown as OrchestrationModelBinding;
		const harness = await createHarness({
			models: [{ id: "pinned", contextWindow: 128_000, reasoning: true }],
			settings: { workerDelegation: { modelPins: { roles: { implementer: malformed } } } },
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"must not run"}')]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Do not silently adapt." });

			expect(run).toEqual({ started: false, skipReason: "worker_model_pins_invalid" });
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(
				harness.settingsManager
					.drainErrors()
					.map(({ error }) => error.message)
					.join("\n"),
			).toContain("thinkingLevel");
		} finally {
			await harness.cleanup();
		}
	});

	it("fails closed when the role pin is unavailable instead of using the profile or requested model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "requested", contextWindow: 128_000 },
			],
			settings: {
				workerDelegation: {
					modelPins: {
						roles: {
							implementer: { provider: "faux", modelId: "missing-pin", thinkingLevel: "off" },
						},
					},
				},
			},
			workerOrchestrationProfile: workerProfile("requested"),
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"must not fall back"}')]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Honor the owner pin." });

			expect(run).toEqual({ started: false, skipReason: "worker_model_pin_unavailable:implementer" });
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("pins the mandatory verifier independently and persists both bindings before execution", async () => {
		const implementationProfile = workerProfile("unavailable-implementation-model", {
			profileId: "verified-model-pin-worker",
			requireIndependentVerification: true,
			verificationProfileId: "verified-model-pin-review",
		});
		const verifierProfile = workerProfile("unavailable-verifier-model", {
			profileId: "verified-model-pin-review",
			role: "verifier",
		});
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "pinned", contextWindow: 128_000, reasoning: true },
				{ id: "requested", contextWindow: 128_000, reasoning: true },
			],
			settings: {
				workerDelegation: {
					modelPins: { roles: { implementer: luna, verifier: terra } },
				},
			},
			workerOrchestrationProfile: implementationProfile,
			additionalOrchestrationProfiles: [verifierProfile],
		});
		const observedModelIds: string[] = [];
		try {
			harness.setResponses([
				(_context, _options, _state, model) => {
					observedModelIds.push(model.id);
					return fauxAssistantMessage('{"summary":"implemented","status":"completed","findings":[]}');
				},
				(_context, _options, _state, model) => {
					observedModelIds.push(model.id);
					return fauxAssistantMessage(
						'{"summary":"verified","status":"completed","verdict":"accepted","reasonCodes":["passed"],"findings":[]}',
					);
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Implement, then verify." });
			if (!run.started || !run.record) {
				throw new Error(`Expected the implementation worker to start: ${run.skipReason ?? "unknown"}`);
			}
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const implementationAttemptId = snapshot.tasks[run.record.laneId]?.attemptIds.at(-1);
			const contract = implementationAttemptId
				? snapshot.attempts[implementationAttemptId]?.dispatch.executionContract
				: undefined;
			expect(contract?.worker.modelBinding).toEqual(luna);
			expect(contract?.verifier?.modelBinding).toEqual(terra);

			await vi.waitFor(() => expect(harness.session.getWorkerClaimSnapshots().length).toBeGreaterThanOrEqual(2));
			expect(observedModelIds).toEqual(["pinned", "requested"]);
			expect(harness.session.getLaneRecords()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ modelRef: "faux/pinned", thinkingLevel: "high" }),
					expect.objectContaining({ modelRef: "faux/requested", thinkingLevel: "medium" }),
				]),
			);
		} finally {
			await harness.cleanup();
		}
	});

	it("applies the child role pin to fresh nested delegation", async () => {
		const recursiveProfile = workerProfile("unavailable-profile-model", {
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
		});
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "pinned", contextWindow: 128_000, reasoning: true },
				{ id: "requested", contextWindow: 128_000, reasoning: true },
			],
			settings: {
				workerDelegation: {
					modelPins: { roles: { implementer: luna, explorer: terra } },
				},
			},
			workerOrchestrationProfile: recursiveProfile,
		});
		const observedModelIds: string[] = [];
		try {
			harness.setResponses([
				(_context, _options, _state, model) => {
					observedModelIds.push(model.id);
					return fauxAssistantMessage(
						[
							fauxToolCall("delegate", {
								instructions: "Inspect the nested evidence.",
								authority: { role: "explorer" },
							}),
						],
						{ stopReason: "toolUse" },
					);
				},
				(_context, _options, _state, model) => {
					observedModelIds.push(model.id);
					return fauxAssistantMessage('{"summary":"nested evidence inspected","status":"completed"}');
				},
				(_context, _options, _state, model) => {
					observedModelIds.push(model.id);
					return fauxAssistantMessage('{"summary":"parent complete","status":"completed"}');
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Delegate one nested inspection." });
			expect(run.started).toBe(true);
			await vi.waitFor(() => expect(harness.session.getWorkerClaimSnapshots().length).toBeGreaterThanOrEqual(2));
			expect(observedModelIds).toHaveLength(3);
			expect(observedModelIds.filter((modelId) => modelId === "pinned")).toHaveLength(2);
			expect(observedModelIds.filter((modelId) => modelId === "requested")).toHaveLength(1);
			expect(harness.session.getLaneRecords()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ modelRef: "faux/pinned", thinkingLevel: "high" }),
					expect.objectContaining({ modelRef: "faux/requested", thinkingLevel: "medium" }),
				]),
			);
		} finally {
			await harness.cleanup();
		}
	});
});
