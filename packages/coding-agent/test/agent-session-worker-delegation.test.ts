import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { describe, expect, it, vi } from "vitest";
import { getPrivateLaneDeniedPaths } from "../src/core/autonomy/lane-private-paths.ts";
import { getLaneRecordSnapshots } from "../src/core/autonomy/session-lane-record.ts";
import { getWorkerRequestSnapshots } from "../src/core/delegation/session-worker-claim.ts";
import { WorkerActionJournal } from "../src/core/delegation/worker-action-journal.ts";
import { WorkerAgentMailbox } from "../src/core/delegation/worker-agent-control.ts";
import { resolveWorkerAuthority } from "../src/core/delegation/worker-authority-resolver.ts";
import { WorkerConversation, WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import {
	buildWorkerExecutionPlan,
	compileWorkerExecutionGrant,
	workerExecutionAuthorityFromPlan,
} from "../src/core/delegation/worker-execution-policy.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { workerResourcePointerId } from "../src/core/delegation/worker-resource-catalog.ts";
import { WorkerWriteReservationStore } from "../src/core/delegation/worker-write-reservation.ts";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { getWorkerHumanInputsRequiringDelivery } from "../src/core/human-input.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { OrchestrationProfileStore } from "../src/core/orchestration/profile-store.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import { createWorkerResultContract } from "../src/core/orchestration/worker-result-adapter.ts";
import { createTestExecutionGrant, createTestWorkerExecutionAuthority } from "./orchestration-profile-fixture.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./suite/test-resources.ts";

const WORKER_JSON =
	'{"summary":"The validator blocks out-of-scope changes.","status":"completed","findings":[{"summary":"Deny lists override allow lists","confidence":0.8}]}';

function workerLaneRecords(harness: Harness) {
	return getLaneRecordSnapshots(harness.sessionManager.getEntries()).filter((record) => record.type === "worker");
}

function workerProfile(modelId: string, thinkingLevel: "off" | "low" = "off"): OrchestrationProfile {
	const now = new Date().toISOString();
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: `worker-${modelId}`,
		description: `Pinned ${modelId} test worker`,
		role: "implementer",
		modelPolicy: { mode: "fixed", candidates: [{ provider: "faux", modelId, thinkingLevel }] },
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
	};
}

function verifiedWorkerProfiles(): {
	implementationProfile: OrchestrationProfile;
	verifierProfile: OrchestrationProfile;
} {
	return {
		implementationProfile: {
			...workerProfile("faux-1"),
			profileId: "verified-worker",
			requireIndependentVerification: true,
			verificationProfileId: "verified-worker-review",
		},
		verifierProfile: {
			...workerProfile("faux-1"),
			profileId: "verified-worker-review",
			role: "verifier",
			description: "Pinned independent verifier",
		},
	};
}

describe("AgentSession worker delegation", () => {
	it("constructs only the model and tool surface owned by the active orchestration profile", async () => {
		const now = new Date().toISOString();
		const operator: OrchestrationProfile = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			profileId: "test-operator",
			description: "Pinned direct-process operator",
			role: "operator",
			modelPolicy: {
				mode: "fixed",
				candidates: [{ provider: "faux", modelId: "operator-worker", thinkingLevel: "off" }],
			},
			capabilityCeiling: ["filesystem.read", "process.exec"],
			toolNames: ["read", "run_process"],
			resourceProfileNames: [],
			dispatchProfileIds: [],
			executionPolicy: {
				allowedExecutables: [process.execPath],
				allowedEnvironmentVariables: [],
				maxOutputBytes: 16_384,
			},
			budget: { maxCostUsd: 1, maxTokens: 8_192, maxToolCalls: 4, maxWallClockMs: 5_000 },
			maxConcurrent: 1,
			leaseTtlMs: 10_000,
			requireIndependentVerification: false,
			createdAt: now,
			updatedAt: now,
		};
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "operator-worker", contextWindow: 128_000 },
			],
			orchestrationProfile: operator,
		});
		try {
			expect(harness.session.model?.id).toBe("operator-worker");
			expect(harness.session.thinkingLevel).toBe("off");
			expect(harness.session.getActiveToolNames()).toEqual(["read", "run_process"]);
			expect(harness.session.getToolDefinition("tool_task")).toBeUndefined();
			expect(harness.session.getToolDefinition("run_process")).toBeDefined();
			expect(harness.session.getToolDefinition("bash")).toBeUndefined();
			expect(harness.session.getToolDefinition("delegate")).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("does not construct the profile-only process tool without an active owner profile", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.getToolDefinition("run_process")).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("rejects an unknown profile by identity instead of treating architect metadata as an authority allowlist", async () => {
		const now = new Date().toISOString();
		const architect: OrchestrationProfile = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			profileId: "test-architect",
			description: "Routing-only architect",
			role: "orchestrator",
			modelPolicy: {
				mode: "fixed",
				candidates: [{ provider: "faux", modelId: "faux-model", thinkingLevel: "off" }],
			},
			capabilityCeiling: ["workflow.delegate"],
			toolNames: ["delegate"],
			resourceProfileNames: [],
			dispatchProfileIds: ["test-worker"],
			budget: { maxCostUsd: 1, maxTokens: 8_192, maxToolCalls: 4, maxWallClockMs: 60_000 },
			maxConcurrent: 1,
			leaseTtlMs: 90_000,
			requireIndependentVerification: false,
			createdAt: now,
			updatedAt: now,
		};
		const harness = await createHarness({
			models: [{ id: "faux-model", contextWindow: 128_000 }],
			settings: { workerDelegation: { maxConcurrent: 2 } },
			orchestrationProfile: architect,
		});
		try {
			harness.setResponses([fauxAssistantMessage(WORKER_JSON)]);
			const allowed = await harness.session.runWorkerDelegationOnce({
				instructions: "Use the owner-pinned worker",
				profileId: "test-worker",
			});
			expect(allowed.started).toBe(true);
			const denied = await harness.session.runWorkerDelegationOnce({
				instructions: "Try an unlisted worker",
				profileId: "unlisted-expensive-worker",
			});
			expect(denied).toMatchObject({
				started: false,
				skipReason: "orchestration_profile_not_found",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("honors explicit preset identity and rejects a profile id that is not loaded", async () => {
		const ownerDefault = workerProfile("owner-default-worker");
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "owner-default-worker", contextWindow: 128_000 },
			],
			workerOrchestrationProfile: ownerDefault,
		});
		let selectedModelId = "";
		try {
			harness.setResponses([
				(_context, _options, _state, model) => {
					selectedModelId = model.id;
					return fauxAssistantMessage(WORKER_JSON);
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use the owner-selected worker.",
				profileId: "invented-at-runtime",
			});

			expect(run).toEqual({ started: false, skipReason: "orchestration_profile_not_found" });
			expect(selectedModelId).toBe("");
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("enforces concurrency per worker profile under the global worker ceiling", async () => {
		const now = new Date().toISOString();
		const architect: OrchestrationProfile = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			profileId: "concurrency-architect",
			description: "Routes independent worker profiles",
			role: "orchestrator",
			modelPolicy: {
				mode: "fixed",
				candidates: [{ provider: "faux", modelId: "faux-model", thinkingLevel: "off" }],
			},
			capabilityCeiling: ["workflow.delegate"],
			toolNames: ["delegate"],
			resourceProfileNames: [],
			dispatchProfileIds: ["worker-a", "worker-b"],
			budget: { maxCostUsd: 1, maxTokens: 8_192, maxToolCalls: 4, maxWallClockMs: 60_000 },
			maxConcurrent: 1,
			leaseTtlMs: 90_000,
			requireIndependentVerification: false,
			createdAt: now,
			updatedAt: now,
		};
		const harness = await createHarness({
			models: [{ id: "faux-model", contextWindow: 128_000 }],
			settings: { workerDelegation: { maxConcurrent: 2 } },
			orchestrationProfile: architect,
		});
		let resolveFirst!: (message: AssistantMessage) => void;
		let resolveSecond!: (message: AssistantMessage) => void;
		const first = new Promise<AssistantMessage>((resolve) => {
			resolveFirst = resolve;
		});
		const second = new Promise<AssistantMessage>((resolve) => {
			resolveSecond = resolve;
		});
		try {
			const store = new OrchestrationProfileStore({
				agentDir: harness.tempDir,
				cwd: harness.tempDir,
				projectTrusted: true,
			});
			for (const profileId of ["worker-a", "worker-b"]) {
				store.save(
					{
						schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
						profileId,
						description: `Independent ${profileId}`,
						role: "implementer",
						modelPolicy: {
							mode: "fixed",
							candidates: [{ provider: "faux", modelId: "faux-model", thinkingLevel: "off" }],
						},
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
					},
					"global",
				);
			}
			harness.setResponses([() => first, () => second]);

			const firstRun = harness.session.runWorkerDelegationOnce({ instructions: "First", profileId: "worker-a" });
			const secondRun = harness.session.runWorkerDelegationOnce({ instructions: "Second", profileId: "worker-b" });
			expect(
				harness.session
					.getLaneRecords()
					.filter((record) => record.type === "worker" && record.status === "running"),
			).toHaveLength(2);

			resolveFirst(fauxAssistantMessage('{"summary":"first complete","status":"completed"}'));
			resolveSecond(fauxAssistantMessage('{"summary":"second complete","status":"completed"}'));
			const outcomes = await Promise.all([firstRun, secondRun]);
			expect(outcomes.every((outcome) => outcome.record?.status === "succeeded")).toBe(true);
		} finally {
			resolveFirst(fauxAssistantMessage('{"summary":"cleanup"}'));
			resolveSecond(fauxAssistantMessage('{"summary":"cleanup"}'));
			harness.cleanup();
		}
	});

	it("runs project-capable delegation by default on a capable model", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage(WORKER_JSON)]);
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout something" });
			expect(run.started).toBe(true);
			expect(getWorkerRequestSnapshots(harness.sessionManager.getEntries())[0]?.envelope.capabilities).toEqual([
				"filesystem.read",
				"filesystem.write",
				"workflow.delegate",
				"memory.query",
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("activates every owner-admitted profile resource when the model-facing delegation has no runtime narrowing", async () => {
		let skill = "";
		let prompt = "";
		const resourceLoader = {
			...createTestResourceLoader(),
			getDiscoverableSkillPaths: () => [skill],
			getDiscoverablePromptPaths: () => [prompt],
		};
		const profile = {
			...workerProfile("resource-worker"),
			resourceProfileNames: ["worker-resources"],
		};
		const harness = await createHarness({
			models: [{ id: "resource-worker", contextWindow: 128_000 }],
			workerOrchestrationProfile: profile,
			resourceLoader,
		});
		try {
			skill = join(harness.tempDir, "resources", "skill", "SKILL.md");
			prompt = join(harness.tempDir, "resources", "prompt.md");
			mkdirSync(dirname(skill), { recursive: true });
			mkdirSync(dirname(prompt), { recursive: true });
			writeFileSync(skill, "DEFAULT_SKILL_RESOURCE_MARKER", "utf-8");
			writeFileSync(prompt, "DEFAULT_PROMPT_RESOURCE_MARKER", "utf-8");
			harness.settingsManager.setProfileDefinition(
				"worker-resources",
				{ resources: { skills: { allow: ["*"] }, prompts: { allow: ["*"] } } },
				"global",
			);
			let workerSystemPrompt = "";
			harness.setResponses([
				(context) => {
					workerSystemPrompt = context.systemPrompt ?? "";
					return fauxAssistantMessage('{"summary":"profile resources applied","status":"completed"}');
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use the owner-authored resources.",
			});

			expect(run.record?.status).toBe("succeeded");
			expect(workerSystemPrompt).toContain("DEFAULT_SKILL_RESOURCE_MARKER");
			expect(workerSystemPrompt).toContain("DEFAULT_PROMPT_RESOURCE_MARKER");
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const attempt = run.record
				? Object.values(snapshot.attempts).find((entry) => entry.taskId === run.record!.laneId)
				: undefined;
			expect(attempt?.dispatch.resourcePointerIds).toEqual(
				[workerResourcePointerId("skill", skill), workerResourcePointerId("prompt", prompt)].sort(),
			);
			expect(attempt?.grant?.resources.map((resource) => resource.id).sort()).toEqual(
				[workerResourcePointerId("skill", skill), workerResourcePointerId("prompt", prompt)].sort(),
			);
			expect(Object.values(snapshot.agents)[0]?.resumeContext.contextPointers).toEqual(attempt?.grant?.resources);
		} finally {
			harness.cleanup();
		}
	});

	it("materializes only owner-admitted resource pointers selected for the durable task", async () => {
		let selectedSkill = "";
		let omittedSkill = "";
		const resourceLoader = {
			...createTestResourceLoader(),
			getDiscoverableSkillPaths: () => [selectedSkill, omittedSkill],
		};
		const profile = {
			...workerProfile("resource-worker"),
			resourceProfileNames: ["worker-resources"],
		};
		const harness = await createHarness({
			models: [{ id: "resource-worker", contextWindow: 128_000 }],
			workerOrchestrationProfile: profile,
			resourceLoader,
		});
		try {
			selectedSkill = join(harness.tempDir, "resources", "selected", "SKILL.md");
			omittedSkill = join(harness.tempDir, "resources", "omitted", "SKILL.md");
			mkdirSync(dirname(selectedSkill), { recursive: true });
			mkdirSync(dirname(omittedSkill), { recursive: true });
			writeFileSync(selectedSkill, "SELECTED_RESOURCE_MARKER", "utf-8");
			writeFileSync(omittedSkill, "OMITTED_RESOURCE_MARKER", "utf-8");
			harness.settingsManager.setProfileDefinition(
				"worker-resources",
				{ resources: { skills: { allow: ["*"] } } },
				"global",
			);
			let workerSystemPrompt = "";
			harness.setResponses([
				(context) => {
					workerSystemPrompt = context.systemPrompt ?? "";
					return fauxAssistantMessage('{"summary":"selected resource applied","status":"completed"}');
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use the selected worker resource.",
				taskContext: {
					requirementIds: [],
					dependsOnTaskIds: [],
					acceptanceCriterionIds: [],
					resourcePointerIds: [workerResourcePointerId("skill", selectedSkill)],
				},
			});

			expect(run.record?.status).toBe("succeeded");
			expect(workerSystemPrompt).toContain("SELECTED_RESOURCE_MARKER");
			expect(workerSystemPrompt).not.toContain("OMITTED_RESOURCE_MARKER");
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const attempt = run.record
				? Object.values(snapshot.attempts).find((entry) => entry.taskId === run.record!.laneId)
				: undefined;
			expect(attempt?.grant?.resources).toMatchObject([
				{
					id: workerResourcePointerId("skill", selectedSkill),
					digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
			]);
			expect(Object.values(snapshot.agents)[0]?.resumeContext.contextPointers).toEqual(attempt?.grant?.resources);
		} finally {
			harness.cleanup();
		}
	});

	it("fails closed before provider execution when a task selects an unadmitted resource pointer", async () => {
		const profile = {
			...workerProfile("resource-worker"),
			resourceProfileNames: ["worker-resources"],
		};
		const harness = await createHarness({
			models: [{ id: "resource-worker", contextWindow: 128_000 }],
			workerOrchestrationProfile: profile,
		});
		try {
			harness.settingsManager.setProfileDefinition(
				"worker-resources",
				{ resources: { skills: { allow: ["*"] } } },
				"global",
			);
			harness.setResponses([fauxAssistantMessage('{"summary":"must not execute"}')]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Try an unknown resource.",
				taskContext: {
					requirementIds: [],
					dependsOnTaskIds: [],
					acceptanceCriterionIds: [],
					resourcePointerIds: ["skill:not-admitted"],
				},
			});

			expect(run).toMatchObject({ started: false, skipReason: "worker_resource_pointer_unknown" });
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("tags a started worker lane with the active goal's goalId", async () => {
		const harness = await createHarness();
		try {
			harness.session.saveGoalStateSnapshot(
				createGoalState({ goalId: "goal-42", userGoal: "Ship the feature", now: new Date().toISOString() }),
			);
			harness.setResponses([fauxAssistantMessage(WORKER_JSON)]);
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout something" });
			expect(run.started).toBe(true);
			expect(run.record?.goalId).toBe("goal-42");

			const persisted = workerLaneRecords(harness);
			expect(persisted).toHaveLength(1);
			expect(persisted[0]?.goalId).toBe("goal-42");
		} finally {
			harness.cleanup();
		}
	});

	it("leaves a worker lane without a goalId when no goal is active", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage(WORKER_JSON)]);
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout something" });
			expect(run.started).toBe(true);
			expect(run.record?.goalId).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("gives worker delegation a stable synthetic cache-affinity key, never the real session id", async () => {
		const harness = await createHarness();
		try {
			let seenSessionId: string | undefined;
			harness.setResponses([
				(_context, options) => {
					seenSessionId = options?.sessionId;
					return fauxAssistantMessage(WORKER_JSON);
				},
			]);
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout something" });
			expect(run.started).toBe(true);
			expect(seenSessionId).toMatch(/^lane:worker:/);
			expect(seenSessionId).not.toBe(harness.session.sessionId);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps an explicit delegation disable independent of Ultra", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: false } },
		});
		try {
			const model = harness.session.model;
			if (!model) throw new Error("Expected harness model");
			model.thinkingLevelMap = { max: "max", ultra: "max" };
			harness.session.setThinkingLevel("ultra");
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout safely" });
			expect(run).toMatchObject({ started: false, skipReason: "worker_delegation_disabled" });
		} finally {
			harness.cleanup();
		}
	});

	it("gates delegation against the configured worker model rather than the foreground model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "tiny-worker", contextWindow: 4_096 },
			],
			settings: { workerDelegation: { enabled: true } },
			workerOrchestrationProfile: workerProfile("tiny-worker"),
		});
		try {
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout safely" });

			expect(run).toMatchObject({ started: false, skipReason: "model_delegation_unsupported" });
			expect(workerLaneRecords(harness)).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});

	it("uses the selected worker model's text-tool protocol instead of the foreground model's", async () => {
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "text-worker", contextWindow: 128_000 },
			],
			settings: { workerDelegation: { enabled: true } },
			workerOrchestrationProfile: workerProfile("text-worker"),
		});
		try {
			const workerModel = harness.session.modelRegistry.find("faux", "text-worker");
			if (!workerModel) throw new Error("Expected worker model");
			workerModel.textToolCallProtocol = true;
			let nativeTools: string[] | undefined;
			harness.setResponses([
				(context, _options, _state, model) => {
					nativeTools = context.tools?.map((tool) => tool.name) ?? [];
					expect(model.id).toBe("text-worker");
					return fauxAssistantMessage(WORKER_JSON);
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout safely" });

			expect(run.record?.status).toBe("succeeded");
			expect(nativeTools).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("uses the exact reasoning level pinned by the owner-authored orchestration profile", async () => {
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{
					id: "reasoning-worker",
					contextWindow: 128_000,
					reasoning: true,
				},
			],
			settings: { workerDelegation: { enabled: true } },
			workerOrchestrationProfile: workerProfile("reasoning-worker"),
		});
		try {
			let seenReasoning: unknown;
			harness.setResponses([
				(_context, options) => {
					seenReasoning = options?.reasoning;
					return fauxAssistantMessage(WORKER_JSON);
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout safely" });

			expect(run.record?.status).toBe("succeeded");
			expect(seenReasoning).toBe("off");
		} finally {
			harness.cleanup();
		}
	});

	it("skips on empty instructions", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "   " });
			expect(run.started).toBe(false);
			expect(run.skipReason).toBe("missing_instructions");
		} finally {
			harness.cleanup();
		}
	});

	it("runs a delegated worker end to end: result, lane record, acceptance", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			harness.setResponses([fauxAssistantMessage(WORKER_JSON)]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Summarize the delegation validation rules",
			});

			expect(run.started).toBe(true);
			expect(run.record?.status).toBe("succeeded");
			expect(run.record?.reasonCode).toBe("worker_completed");
			expect(run.outcome?.accepted).toBe(true);
			expect(run.outcome?.claim.usageReportId).toBe(`worker:${harness.session.sessionId}:${run.record?.laneId}`);

			const results = harness.session.getWorkerClaimSnapshots();
			expect(results).toHaveLength(1);
			expect(results[0]?.status).toBe("completed");
			expect(results[0]?.summary).toBe("The validator blocks out-of-scope changes.");
			expect(results[0]?.evidence?.findings).toHaveLength(1);

			const lanes = workerLaneRecords(harness);
			expect(lanes).toHaveLength(1);
			expect(lanes[0]?.status).toBe("succeeded");

			const diagnostics = harness.session.getAutonomyDiagnosticSnapshot();
			expect(diagnostics.delegation?.some((entry) => entry.title.startsWith("Lane worker-"))).toBe(true);
			expect(diagnostics.delegation?.some((entry) => entry.title.startsWith("Worker worker-"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("projects durable worker context through the shared retention boundary before provider requests", async () => {
		const compactSpy = vi.spyOn(WorkerConversation.prototype, "compactProviderContext");
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"retention boundary checked"}')]);

			await harness.session.runWorkerDelegationOnce({ instructions: "Check the worker context boundary" });

			expect(compactSpy).toHaveBeenCalled();
		} finally {
			compactSpy.mockRestore();
			harness.cleanup();
		}
	});

	it("keeps a classified transient retry suspended and nonterminal until its backoff fires", async () => {
		const harness = await createHarness();
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		const runIsolatedCompletion = harness.session.runIsolatedCompletion.bind(harness.session);
		vi.useFakeTimers();
		let providerExecutions = 0;
		const completion = vi.spyOn(harness.session, "runIsolatedCompletion").mockImplementation((options) => {
			providerExecutions += 1;
			if (providerExecutions <= 3) {
				return Promise.reject(new Error("503 service unavailable; retry after 2s"));
			}
			return runIsolatedCompletion(options);
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"retry recovered","status":"completed"}')]);

			const runPromise = harness.session.runWorkerDelegationOnce({ instructions: "Retry one transient outage." });
			await vi.advanceTimersByTimeAsync(0);
			for (let retry = providerExecutions; retry < 3; retry++) await vi.advanceTimersToNextTimerAsync();
			expect(providerExecutions).toBe(3);
			await vi.advanceTimersByTimeAsync(0);

			const suspended = await runPromise;
			if (!suspended.record) throw new Error("Expected a durable suspended retry record.");
			const laneId = suspended.record.laneId;
			const suspendedSnapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const attemptId = suspendedSnapshot.tasks[laneId]?.attemptIds.at(-1);
			expect(attemptId ? suspendedSnapshot.attempts[attemptId]?.status : undefined).toBe("suspended");
			expect(suspended.record.status).toBe("running");
			expect(harness.session.getWorkerClaimSnapshots()).toEqual([]);
			expect(workerLaneRecords(harness)).toEqual([]);

			// Ordinary observation/recovery during backoff must not reinterpret suspension as terminal.
			harness.session.getLaneRecords();
			harness.session.getLaneRecords();
			const observedSnapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			expect(attemptId ? observedSnapshot.attempts[attemptId]?.status : undefined).toBe("suspended");
			expect(providerExecutions).toBe(3);
			expect(harness.session.getWorkerClaimSnapshots()).toEqual([]);
			expect(workerLaneRecords(harness)).toEqual([]);

			await vi.runOnlyPendingTimersAsync();
			await vi.advanceTimersByTimeAsync(0);
			await vi.waitFor(() => expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(1));
			expect(providerExecutions).toBe(4);
			const completedSnapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			expect(attemptId ? completedSnapshot.attempts[attemptId]?.status : undefined).toBe("completed");
			expect(completedSnapshot.tasks[laneId]?.attemptIds).toEqual([attemptId]);
			expect(workerLaneRecords(harness)).toEqual([expect.objectContaining({ laneId, status: "succeeded" })]);
			const terminalRecords = harness
				.eventsOfType("delegate_workers")
				.flatMap((event) => event.terminalSinceFlush)
				.filter((record) => record.laneId === laneId);
			expect(terminalRecords).toEqual([expect.objectContaining({ laneId, status: "succeeded" })]);
		} finally {
			await vi.runOnlyPendingTimersAsync();
			vi.useRealTimers();
			completion.mockRestore();
			random.mockRestore();
			await harness.cleanup();
		}
	});

	it("recovers an idle-parent handoff after one wake failure without reopening child evidence", async () => {
		const harness = await createHarness();
		let prepareAgentTurn: { mockRestore(): void } | undefined;
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"parent complete","status":"completed"}')]);
			const parent = await harness.session.runWorkerDelegationOnce({ instructions: "Establish the parent agent." });
			if (!parent.record) throw new Error("Expected a durable parent agent.");

			prepareAgentTurn = vi.spyOn(WorkerLifecycle.prototype, "prepareAgentTurn").mockImplementationOnce(() => {
				throw new Error("simulated idle-parent handoff start failure");
			});
			harness.setResponses([fauxAssistantMessage('{"summary":"child complete","status":"completed"}')]);
			const child = await harness.session.runWorkerDelegationOnce({
				instructions: "Produce child terminal evidence.",
				parentAgentId: parent.record.laneId,
			});
			if (!child.record) throw new Error("Expected a durable child agent.");
			const childLaneId = child.record.laneId;

			const lifecycle = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			expect(lifecycle.getTerminalNotification(child.record.laneId)).toMatchObject({ status: "delivered" });
			const handoffAttempt = Object.values(lifecycle.getTaskRuntimeSnapshot().attempts).find(
				(attempt) =>
					attempt.dispatch.logicalLaneId === parent.record?.laneId &&
					attempt.dispatch.controlMessageId !== undefined &&
					attempt.dispatch.instructions.includes(`childAgentId=${childLaneId}`),
			);
			expect(handoffAttempt).toBeDefined();
			const controlMessageId = handoffAttempt?.dispatch.controlMessageId;
			if (!controlMessageId) throw new Error("Expected the recovered terminal handoff control message.");
			const parentMailbox = new WorkerAgentMailbox({
				agentDir: harness.tempDir,
				parentSessionId: harness.session.sessionId,
				agentId: parent.record.laneId,
			});
			await vi.waitFor(() =>
				expect(parentMailbox.getMessage(controlMessageId)).toMatchObject({
					deliveredAt: expect.any(String),
					senderAgentId: childLaneId,
					task: {
						kind: "terminal_handoff",
						sourceAttemptId: expect.any(String),
					},
				}),
			);
			expect(parentMailbox.pendingTaskBearing()).toEqual([]);
			const rootTerminalProjections = harness
				.eventsOfType("delegate_workers")
				.flatMap((event) => event.terminalSinceFlush)
				.filter((record) => record.laneId === childLaneId);
			expect(rootTerminalProjections).toEqual([]);
		} finally {
			prepareAgentTurn?.mockRestore();
			await harness.cleanup();
		}
	});

	it("keeps follow-up turns owned by the controller so interrupt can fence them", async () => {
		const harness = await createHarness();
		let releaseFollowUp!: (message: AssistantMessage) => void;
		const heldFollowUp = new Promise<AssistantMessage>((resolve) => {
			releaseFollowUp = resolve;
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"initial turn complete"}')]);
			const initial = await harness.session.runWorkerDelegationOnce({ instructions: "Start a durable worker" });
			if (!initial.started || !initial.record) throw new Error("Expected the initial worker turn to complete.");

			harness.setResponses([() => heldFollowUp]);
			const controls = (
				harness.session as unknown as {
					_backgroundLanes: {
						followUpWorkerAgent(
							agentId: string,
							message: string,
						): { started: boolean; record?: { laneId: string } };
						interruptWorkerAgent(agentId: string): { interrupted: boolean; reason?: string };
					};
				}
			)._backgroundLanes;
			const followUp = controls.followUpWorkerAgent(initial.record.laneId, "Inspect the focused regression.");
			expect(followUp.started).toBe(true);
			if (!followUp.record) throw new Error("Expected a durable follow-up record.");

			let activeOwner = "";
			await vi.waitFor(() => {
				const snapshot = new WorkerLifecycle({
					agentDir: harness.tempDir,
					sessionId: harness.session.sessionId,
				}).getTaskRuntimeSnapshot();
				const attemptId = snapshot.tasks[followUp.record!.laneId]?.attemptIds.at(-1);
				const attempt = attemptId ? snapshot.attempts[attemptId] : undefined;
				expect(attempt?.status).toBe("running");
				activeOwner = attempt?.lease?.ownerId ?? "";
			});
			expect(activeOwner).toMatch(/^pi-worker:\d+:/);
			expect(controls.interruptWorkerAgent(initial.record.laneId)).toEqual({ interrupted: true });

			releaseFollowUp(fauxAssistantMessage('{"summary":"interrupted turn unwound"}'));
			await vi.waitFor(() => {
				const snapshot = new WorkerLifecycle({
					agentDir: harness.tempDir,
					sessionId: harness.session.sessionId,
				}).getTaskRuntimeSnapshot();
				const attemptId = snapshot.tasks[followUp.record!.laneId]?.attemptIds.at(-1);
				expect(attemptId ? snapshot.attempts[attemptId]?.status : undefined).toBe("suspended");
			});
		} finally {
			releaseFollowUp(fauxAssistantMessage('{"summary":"cleanup"}'));
			harness.cleanup();
		}
	});

	it("persists a worker's conversation across tasks: a reused agent keeps its prior task context", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"first task done","status":"completed"}')]);
			const initial = await harness.session.runWorkerDelegationOnce({
				instructions: "Memorize the codeword ZEPHYR-9 for later tasks",
			});
			if (!initial.started || !initial.record) throw new Error("Expected the initial worker task to complete.");

			const routeFollowUp: FauxResponseFactory = (context) =>
				context.systemPrompt?.includes("Autonomous orchestration-tree agent")
					? fauxAssistantMessage('{"summary":"second task done","status":"completed"}')
					: fauxAssistantMessage("Background handoff acknowledged.");
			harness.setResponses([routeFollowUp, routeFollowUp, routeFollowUp]);
			const controls = (
				harness.session as unknown as {
					_backgroundLanes: {
						followUpWorkerAgent(
							agentId: string,
							message: string,
						): { started: boolean; record?: { laneId: string } };
						readWorkerAgentTranscript(
							agentId: string,
							options?: { maxMessages?: number },
						): { totalMessages: number; messages: unknown[] };
					};
				}
			)._backgroundLanes;
			const agentId = initial.record.laneId;
			const followUp = controls.followUpWorkerAgent(agentId, "Recall the codeword from the previous task");
			expect(followUp.started).toBe(true);
			// The follow-up is a NEW task (fresh lane) dispatched onto the SAME durable conversation.
			expect(followUp.record?.laneId).not.toBe(initial.record.laneId);

			await vi.waitFor(() => {
				const transcript = JSON.stringify(controls.readWorkerAgentTranscript(agentId, { maxMessages: 64 }));
				expect(transcript).toContain("ZEPHYR-9");
				expect(transcript).toContain("Recall the codeword from the previous task");
			});
			await vi.waitFor(() => {
				const snapshot = new WorkerLifecycle({
					agentDir: harness.tempDir,
					sessionId: harness.session.sessionId,
				}).getTaskRuntimeSnapshot();
				const followUpTask = followUp.record ? snapshot.tasks[followUp.record.laneId] : undefined;
				const followUpAttemptId = followUpTask?.attemptIds.at(-1);
				const followUpAttempt = followUpAttemptId ? snapshot.attempts[followUpAttemptId] : undefined;
				expect(followUpAttempt?.status).toBe("completed");
				const baselineId = followUpAttempt?.checkpointIds[0];
				expect(baselineId ? snapshot.checkpoints[baselineId]?.usage : undefined).toMatchObject({
					toolCalls: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 0,
					costUsd: 0,
				});
			});
		} finally {
			harness.cleanup();
		}
	});

	it("interrupts a leased logical-agent turn before provider execution begins", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"initial turn complete"}')]);
			const initial = await harness.session.runWorkerDelegationOnce({ instructions: "Create a resumable worker" });
			if (!initial.record) throw new Error("Expected an initial logical worker lane.");
			const controls = (
				harness.session as unknown as {
					_backgroundLanes: {
						getLaneRecords(): unknown[];
						interruptWorkerAgent(agentId: string): { interrupted: boolean; reason?: string };
						_workers?: {
							getAgentControlProcessOwnerId(): string;
							lifecycle: WorkerLifecycle;
						};
					};
				}
			)._backgroundLanes;
			controls.getLaneRecords();
			const workerController = controls._workers;
			if (!workerController) throw new Error("Expected worker controller to be materialized.");
			const agent = workerController.lifecycle.getAgent(initial.record.laneId);
			if (!agent) throw new Error("Expected logical worker agent registration.");
			const prepared = workerController.lifecycle.prepareAgentTurn({
				agentId: agent.agentId,
				instructions: "Prepare an interruptible provider turn.",
			});
			const task = workerController.lifecycle.getTask(prepared.record.laneId);
			if (!task) throw new Error("Expected a durable follow-up task.");
			workerController.lifecycle.bindGrant(
				prepared.attempt.attemptId,
				createTestExecutionGrant({
					objectiveId: task.task.objectiveId,
					taskId: prepared.attempt.taskId,
					attemptId: prepared.attempt.attemptId,
					role: task.task.role,
				}),
			);
			const started = workerController.lifecycle.startAgent(
				prepared.record.laneId,
				agent.agentId,
				90_000,
				workerController.getAgentControlProcessOwnerId(),
			);
			workerController.lifecycle.suspendAgent(
				prepared.record.laneId,
				agent.agentId,
				workerController.getAgentControlProcessOwnerId(),
			);
			workerController.lifecycle.ledger.runtime.requestAgentResume(agent.agentId, started.attemptId);
			workerController.lifecycle.ledger.runtime.resumeAttempt(
				started.attemptId,
				agent.agentId,
				90_000,
				workerController.getAgentControlProcessOwnerId(),
			);
			expect(workerController.lifecycle.getActiveAttempt(prepared.record.laneId)?.status).toBe("leased");

			expect(controls.interruptWorkerAgent(agent.agentId)).toEqual({ interrupted: true });
			expect(workerController.lifecycle.getActiveAttempt(prepared.record.laneId)?.status).toBe("suspended");
		} finally {
			harness.cleanup();
		}
	});

	it("denies delegated file tools access to private file-store memory under the workspace", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			const memoryPath = join(harness.tempDir, "MEMORY.md");
			writeFileSync(memoryPath, "PRIVATE_MEMORY_MARKER_SHOULD_NOT_LEAK\n", "utf-8");
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: memoryPath })], { stopReason: "toolUse" }),
				fauxAssistantMessage('{"summary":"private read attempt complete","status":"completed"}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Read private memory" });

			expect(run.outcome?.claim.status).toBe("completed");
			expect(run.outcome?.claim.blockers).toBeUndefined();
			expect(JSON.stringify(run.outcome?.claim)).not.toContain("PRIVATE_MEMORY_MARKER_SHOULD_NOT_LEAK");
		} finally {
			harness.cleanup();
		}
	});

	it("records a blocked worker as requiring parent review", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			harness.setResponses([
				fauxAssistantMessage('{"summary":"Stuck","status":"blocked","blockers":["Need repo access"]}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Do the impossible" });

			expect(run.record?.status).toBe("failed");
			expect(run.record?.reasonCode).toBe("worker_blocked");
			expect(run.outcome?.accepted).toBe(false);
			expect(run.outcome?.acceptance.outcome).toBe("block");
			expect(harness.session.getWorkerClaimSnapshots()[0]?.status).toBe("blocked");
		} finally {
			harness.cleanup();
		}
	});

	it("executes a direct scoped write and reports it for parent review", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, writeEnabled: true, writePaths: ["src"] } },
		});
		try {
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("write", {
							path: "src/direct.ts",
							content: "export const direct = true;\n",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage('{"summary":"direct write complete","status":"completed","actions":[]}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Write the direct helper" });

			expect(readFileSync(join(harness.tempDir, "src/direct.ts"), "utf-8")).toBe("export const direct = true;\n");
			expect(run.outcome?.claim.changedFiles).toEqual(["src/direct.ts"]);
			expect(run.outcome?.acceptance).toMatchObject({
				outcome: "ask-user",
				reasonCode: "parent_review_required",
			});
			expect(getWorkerHumanInputsRequiringDelivery(harness.sessionManager)).toMatchObject([
				{ request: { source: "worker", workerRequestId: run.record?.laneId }, status: "pending" },
			]);
			const request = getWorkerRequestSnapshots(harness.sessionManager.getEntries())[0];
			expect(request?.envelope.allowedTools).toEqual([
				"read",
				"grep",
				"find",
				"ls",
				"memory",
				"write",
				"edit",
				"delegate",
			]);
			expect(request?.envelope.allowedTools).toContain("delegate");
		} finally {
			harness.cleanup();
		}
	});

	it("holds an overlapping write lane queued until the first reservation releases", async () => {
		const profile = {
			...workerProfile("faux-1"),
			profileId: "concurrent-write-worker",
			capabilityCeiling: ["filesystem.read", "filesystem.write"] as const,
			toolNames: ["read", "write", "edit"],
			maxConcurrent: 2,
		};
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, maxConcurrent: 2, writeEnabled: true, writePaths: ["src"] } },
			workerOrchestrationProfile: profile,
		});
		let resolveFirst!: (message: AssistantMessage) => void;
		let resolveSecond!: (message: AssistantMessage) => void;
		const first = new Promise<AssistantMessage>((resolve) => {
			resolveFirst = resolve;
		});
		const second = new Promise<AssistantMessage>((resolve) => {
			resolveSecond = resolve;
		});
		let providerCalls = 0;
		try {
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			await harness.session.setModel({ ...harness.getModel(), baseUrl: "https://faux.invalid" });
			harness.setResponses([
				() => {
					providerCalls += 1;
					return first;
				},
				() => {
					providerCalls += 1;
					return second;
				},
			]);

			const controls = (
				harness.session as unknown as {
					_backgroundLanes: {
						startWorkerDelegation(request: { instructions: string }): { started: boolean; skipReason?: string };
					};
				}
			)._backgroundLanes;
			expect(controls.startWorkerDelegation({ instructions: "First scoped write" }).started).toBe(true);
			expect(controls.startWorkerDelegation({ instructions: "Second scoped write" })).toMatchObject({
				started: true,
			});
			await vi.waitFor(() => expect(providerCalls).toBe(1));
			expect(
				harness.session.getLaneRecords().some((record) => record.type === "worker" && record.status === "queued"),
			).toBe(true);

			resolveFirst(fauxAssistantMessage('{"summary":"first write complete"}'));
			await vi.waitFor(() => expect(providerCalls).toBe(2));
			resolveSecond(fauxAssistantMessage('{"summary":"second write complete"}'));
			await vi.waitFor(() => expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(2));
		} finally {
			resolveFirst?.(fauxAssistantMessage('{"summary":"cleanup"}'));
			resolveSecond?.(fauxAssistantMessage('{"summary":"cleanup"}'));
			harness.cleanup();
		}
	});

	it("fails closed before provider execution when a write reservation scope escapes the workspace", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, writeEnabled: true, writePaths: ["../outside"] } },
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"must not execute"}')]);

			await expect(
				harness.session.runWorkerDelegationOnce({ instructions: "Write outside the workspace" }),
			).resolves.toMatchObject({
				started: false,
				skipReason: "write_reservation_scope_invalid",
			});
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("publishes one terminal handoff when durable conversation setup fails before worker start", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, writeEnabled: true, writePaths: ["src"] } },
		});
		const ensureConversation = vi.spyOn(WorkerConversationStore.prototype, "ensure").mockImplementationOnce(() => {
			throw new Error("synthetic durable conversation failure");
		});
		let signalTerminal!: () => void;
		const terminal = new Promise<void>((resolve) => {
			signalTerminal = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (
				event.type === "delegate_workers" &&
				event.terminalSinceFlush.some(
					(record) => record.status === "canceled" && record.reasonCode === "worker_conversation_unavailable",
				)
			) {
				signalTerminal();
			}
		});
		try {
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			harness.setResponses([fauxAssistantMessage("Terminal handoff acknowledged.")]);

			await expect(
				harness.session.runWorkerDelegationOnce({ instructions: "Exercise setup failure cleanup" }),
			).resolves.toMatchObject({ started: false, skipReason: "worker_conversation_unavailable" });
			await terminal;
			expect(workerLaneRecords(harness)).toEqual([
				expect.objectContaining({ status: "canceled", reasonCode: "worker_conversation_unavailable" }),
			]);
			expect(
				new WorkerWriteReservationStore({ agentDir: harness.tempDir }).recover({
					workspace: { repositoryRoot: harness.tempDir, executionRoot: harness.tempDir },
					evidence: [],
				}).outcomes,
			).toEqual([]);
		} finally {
			unsubscribe();
			ensureConversation.mockRestore();
			harness.cleanup();
		}
	});

	it("durably journals runner-applied structured mutations under the active attempt fence", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, writeEnabled: true, writePaths: ["src"] } },
		});
		try {
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			harness.setResponses([
				fauxAssistantMessage(
					'{"summary":"structured write complete","status":"completed","actions":[{"op":"write","path":"src/structured.ts","content":"export const structured = true;\\n"}]}',
				),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Write the structured helper" });
			if (!run.started || !run.record) throw new Error("Expected structured worker to start.");
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const attemptId = snapshot.tasks[run.record.laneId]?.attemptIds.at(-1);
			const attempt = attemptId ? snapshot.attempts[attemptId] : undefined;
			if (!attemptId || !attempt) throw new Error("Expected a durable worker attempt.");
			const journal = new WorkerActionJournal({
				agentDir: harness.tempDir,
				parentSessionId: harness.session.sessionId,
				taskId: run.record.laneId,
				attemptId,
				fencingToken: attempt.result?.fencingToken ?? attempt.lease?.fencingToken ?? 0,
			});

			expect(readFileSync(join(harness.tempDir, "src/structured.ts"), "utf-8")).toBe(
				"export const structured = true;\n",
			);
			expect(existsSync(journal.filePath)).toBe(true);
			expect(readFileSync(journal.filePath, "utf-8")).not.toContain("export const structured");
		} finally {
			harness.cleanup();
		}
	});

	it("blocks and reports a direct write outside the configured scope", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, writeEnabled: true, writePaths: ["src"] } },
		});
		try {
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: "outside.ts", content: "must not be written" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage('{"summary":"write was refused","status":"completed"}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Try the scoped write" });

			expect(existsSync(join(harness.tempDir, "outside.ts"))).toBe(false);
			expect(run.outcome?.claim.changedFiles).toEqual([]);
			expect(run.outcome?.claim.status).toBe("completed");
			expect(run.outcome?.claim.blockers).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("does not block worker on a failed direct edit target, allowing it to recover", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, writeEnabled: true, writePaths: ["src"] } },
		});
		try {
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("edit", {
							path: "src/missing.ts",
							edits: [{ oldText: "before", newText: "after" }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage('{"summary":"edit failed","status":"completed"}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Edit the missing helper" });

			expect(run.outcome?.claim.changedFiles).toEqual(["src/missing.ts"]);
			expect(run.outcome?.claim.status).toBe("completed");
			expect(run.outcome?.claim.blockers).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("drains multiple queued local workers up to the configured concurrency", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, maxConcurrent: 1 } },
		});
		const terminalLaneIds = new Set<string>();
		let signalAllTerminal!: () => void;
		const allTerminal = new Promise<void>((resolve) => {
			signalAllTerminal = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "delegate_workers") return;
			for (const record of event.terminalSinceFlush) terminalLaneIds.add(record.laneId);
			if (terminalLaneIds.size === 2) signalAllTerminal();
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("delegate", { instructions: "Scout first" }),
						fauxToolCall("delegate", { instructions: "Scout second" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Delegations started."),
				fauxAssistantMessage('{"summary":"first worker done","status":"completed"}'),
				fauxAssistantMessage('{"summary":"second worker done","status":"completed"}'),
			]);

			await harness.session.prompt("Delegate both scouts", { autoContinueGoal: false });
			await allTerminal;

			expect(terminalLaneIds.size).toBe(2);
			expect(harness.session.getWorkerClaimSnapshots().map((claim) => claim.summary)).toEqual([
				"first worker done",
				"second worker done",
			]);
			expect(workerLaneRecords(harness).map((record) => record.status)).toEqual(["succeeded", "succeeded"]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			unsubscribe();
			harness.cleanup();
		}
	});

	it("keeps a queued worker's full execution contract pinned across profile edits", async () => {
		const pinned: OrchestrationProfile = {
			...workerProfile("pinned-worker", "low"),
			capabilityCeiling: ["filesystem.read", "filesystem.write"],
			toolNames: ["read", "write"],
		};
		const replacement = workerProfile("replacement-worker", "off");
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "pinned-worker", contextWindow: 128_000, reasoning: true },
				{ id: "replacement-worker", contextWindow: 128_000 },
			],
			settings: { workerDelegation: { enabled: true, maxConcurrent: 1 } },
			workerOrchestrationProfile: pinned,
			additionalOrchestrationProfiles: [replacement],
		});
		let releaseFirst = () => {};
		let signalQueued!: () => void;
		let signalAllTerminal!: () => void;
		const queued = new Promise<void>((resolve) => {
			signalQueued = resolve;
		});
		const allTerminal = new Promise<void>((resolve) => {
			signalAllTerminal = resolve;
		});
		const terminalLaneIds = new Set<string>();
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "delegate_workers") return;
			if (
				harness.session.getLaneRecords().some((record) => record.type === "worker" && record.status === "queued")
			) {
				signalQueued();
			}
			for (const record of event.terminalSinceFlush) terminalLaneIds.add(record.laneId);
			if (terminalLaneIds.size === 2) signalAllTerminal();
		});
		try {
			const firstWorkerResponse = new Promise<AssistantMessage>((resolve) => {
				releaseFirst = () => resolve(fauxAssistantMessage('{"summary":"first worker done","status":"completed"}'));
			});
			const workerModelIds: string[] = [];
			const workerReasoning: unknown[] = [];
			const workerToolNames: string[][] = [];
			const routeResponse: FauxResponseFactory = (context, options, _state, model) => {
				if (!context.systemPrompt?.includes("Autonomous orchestration-tree agent")) {
					return fauxAssistantMessage("Delegations started.");
				}
				workerModelIds.push(model.id);
				workerReasoning.push(options?.reasoning);
				workerToolNames.push(context.tools?.map((tool) => tool.name) ?? []);
				return workerModelIds.length === 1
					? firstWorkerResponse
					: fauxAssistantMessage('{"summary":"second worker done","status":"completed"}');
			};
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("delegate", { instructions: "First queued-profile worker" }),
						fauxToolCall("delegate", { instructions: "Second queued-profile worker" }),
					],
					{ stopReason: "toolUse" },
				),
				routeResponse,
				routeResponse,
				routeResponse,
			]);

			await harness.session.prompt("Delegate both workers", { autoContinueGoal: false });
			await queued;
			new OrchestrationProfileStore({
				agentDir: harness.tempDir,
				cwd: harness.tempDir,
				projectTrusted: true,
			}).save(
				{
					...replacement,
					profileId: pinned.profileId,
					description: "Mutated in-place worker profile",
					capabilityCeiling: [],
					toolNames: [],
					updatedAt: new Date().toISOString(),
				},
				"global",
				{ overwrite: true },
			);
			harness.settingsManager.setWorkerDelegationSettings({
				orchestrationProfile: replacement.profileId,
				writeEnabled: true,
				writePaths: ["src"],
			});
			releaseFirst();

			await allTerminal;
			expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(2);
			expect(workerModelIds).toEqual([
				pinned.modelPolicy.candidates[0]?.modelId,
				pinned.modelPolicy.candidates[0]?.modelId,
			]);
			expect(workerReasoning).toEqual(["low", "low"]);
			expect(workerToolNames).toEqual([
				["read", "memory", "write"],
				["read", "memory", "write"],
			]);
		} finally {
			unsubscribe();
			releaseFirst();
			harness.cleanup();
		}
	});

	it("returns from the foreground turn while the worker remains genuinely backgrounded", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		let resolveWorker: (message: AssistantMessage) => void = () => {};
		let workerResolved = false;
		const workerResponse = new Promise<AssistantMessage>((resolve) => {
			resolveWorker = (message) => {
				workerResolved = true;
				resolve(message);
			};
		});
		const routeResponse: FauxResponseFactory = (context) =>
			context.systemPrompt?.includes("Autonomous orchestration-tree agent")
				? workerResponse
				: fauxAssistantMessage("Foreground remained responsive.");
		let resolveTerminal!: () => void;
		let resolveHandoff!: () => void;
		let resolveWakeReply!: () => void;
		const terminal = new Promise<void>((resolve) => {
			resolveTerminal = resolve;
		});
		const handoff = new Promise<void>((resolve) => {
			resolveHandoff = resolve;
		});
		const wakeReply = new Promise<void>((resolve) => {
			resolveWakeReply = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (
				event.type === "delegate_workers" &&
				event.terminalSinceFlush.some((record) => record.status === "succeeded")
			) {
				resolveTerminal();
			}
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "background-worker-completion"
			) {
				resolveHandoff();
			}
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				JSON.stringify(event.message.content).includes("Background handoff acknowledged.")
			) {
				resolveWakeReply();
			}
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("delegate", { instructions: "Wait for the background result" })], {
					stopReason: "toolUse",
				}),
				routeResponse,
				routeResponse,
				fauxAssistantMessage("Background handoff acknowledged."),
			]);

			await harness.session.prompt("Start one background worker", { autoContinueGoal: false });
			expect(
				harness.session
					.getLaneRecords()
					.filter((record) => record.type === "worker")
					.at(-1)?.status,
			).toBe("running");
			expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(0);
			expect(JSON.stringify(harness.session.messages)).toContain("Foreground remained responsive.");

			resolveWorker(fauxAssistantMessage('{"summary":"background result arrived","status":"completed"}'));
			await terminal;
			await handoff;
			await wakeReply;

			expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(1);
			const serialized = JSON.stringify(harness.session.messages);
			expect(serialized).toContain("Background worker terminal handoff:");
			expect(serialized).toContain("Background handoff acknowledged.");
			expect(serialized).not.toContain("background result arrived");
		} finally {
			unsubscribe();
			if (!workerResolved) resolveWorker(fauxAssistantMessage('{"summary":"test cleanup"}'));
			harness.cleanup();
		}
	});

	it("persists a terminal handoff before acknowledging its durable notification", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		let resolveWorker: (message: AssistantMessage) => void = () => {};
		let resolveForeground: (message: AssistantMessage) => void = () => {};
		const workerResponse = new Promise<AssistantMessage>((resolve) => {
			resolveWorker = resolve;
		});
		const foregroundResponse = new Promise<AssistantMessage>((resolve) => {
			resolveForeground = resolve;
		});
		let signalForegroundStarted!: () => void;
		const foregroundStarted = new Promise<void>((resolve) => {
			signalForegroundStarted = resolve;
		});
		const routeResponse: FauxResponseFactory = (context) =>
			context.systemPrompt?.includes("Autonomous orchestration-tree agent")
				? workerResponse
				: fauxAssistantMessage("Foreground remained responsive.");
		const heldForegroundResponse: FauxResponseFactory = () => {
			signalForegroundStarted();
			return foregroundResponse;
		};
		let signalTerminal!: () => void;
		let signalWakeReply!: () => void;
		const terminal = new Promise<void>((resolve) => {
			signalTerminal = resolve;
		});
		const wakeReply = new Promise<void>((resolve) => {
			signalWakeReply = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (
				event.type === "delegate_workers" &&
				event.terminalSinceFlush.some((record) => record.status === "succeeded")
			) {
				signalTerminal();
			}
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				JSON.stringify(event.message.content).includes("Durable handoff acknowledged.")
			) {
				signalWakeReply();
			}
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("delegate", { instructions: "Wait for the durable result" })], {
					stopReason: "toolUse",
				}),
				routeResponse,
				routeResponse,
				heldForegroundResponse,
				fauxAssistantMessage("Durable handoff acknowledged."),
			]);

			await harness.session.prompt("Start one durable background worker", { autoContinueGoal: false });
			const foregroundRun = harness.session.prompt("Keep the foreground occupied", { autoContinueGoal: false });
			await foregroundStarted;

			resolveWorker(fauxAssistantMessage('{"summary":"durable result arrived","status":"completed"}'));
			await terminal;

			const eventStore = new OrchestrationEventStore({
				agentDir: harness.tempDir,
				sessionId: harness.sessionManager.getSessionId(),
			});
			expect(eventStore.readAll().some((event) => event.type === "notification.enqueued")).toBe(true);
			expect(eventStore.readAll().some((event) => event.type === "notification.delivered")).toBe(false);
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom_message" && entry.customType === "background-worker-completion"),
			).toBe(false);

			resolveForeground(fauxAssistantMessage("Foreground released."));
			await foregroundRun;
			await wakeReply;
			await vi.waitFor(() => {
				expect(eventStore.readAll().some((event) => event.type === "notification.delivered")).toBe(true);
			});
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom_message" && entry.customType === "background-worker-completion"),
			).toBe(true);
		} finally {
			unsubscribe();
			resolveWorker(fauxAssistantMessage('{"summary":"test cleanup"}'));
			resolveForeground(fauxAssistantMessage("Test cleanup."));
			harness.cleanup();
		}
	});

	it("lets the model delegate through the delegate tool in a full turn", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			const routeResponse: FauxResponseFactory = (context) =>
				context.systemPrompt?.includes("Autonomous orchestration-tree agent")
					? fauxAssistantMessage(WORKER_JSON)
					: fauxAssistantMessage("Delegation reviewed.");
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("delegate", { instructions: "Scout the validation rules" })], {
					stopReason: "toolUse",
				}),
				routeResponse,
				routeResponse,
			]);

			await harness.session.prompt("Please delegate a scout task", { autoContinueGoal: false });
			await vi.waitFor(() => expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(1));

			expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(1);
			expect(workerLaneRecords(harness)[0]?.status).toBe("succeeded");

			const serialized = JSON.stringify(harness.session.messages);
			expect(serialized).not.toContain("UNTRUSTED");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("automatically dispatches the owner-pinned verifier and reconciles the implementation", async () => {
		const { implementationProfile, verifierProfile } = verifiedWorkerProfiles();
		const harness = await createHarness({
			workerOrchestrationProfile: implementationProfile,
			additionalOrchestrationProfiles: [verifierProfile],
		});
		let resolveVerifier!: (message: AssistantMessage) => void;
		const verifierCompletion = new Promise<AssistantMessage>((resolve) => {
			resolveVerifier = resolve;
		});
		try {
			harness.setResponses([
				fauxAssistantMessage('{"summary":"implementation complete","status":"completed","findings":[]}'),
				() => verifierCompletion,
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Implement and verify" });
			if (!run.started || !run.record) throw new Error("Expected implementation worker to start");
			const subjectLaneId = run.record.laneId;
			expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(1);
			expect(harness.session.getLaneRecords().find((record) => record.laneId === subjectLaneId)).toMatchObject({
				status: "running",
				reasonCode: "independent_verification_required",
			});
			expect(
				harness.events.some(
					(event) =>
						event.type === "delegate_workers" &&
						event.terminalSinceFlush.some((record) => record.laneId === subjectLaneId),
				),
			).toBe(false);

			resolveVerifier(
				fauxAssistantMessage(
					'{"summary":"focused verification passed","status":"completed","verdict":"accepted","reasonCodes":["focused_checks_passed"],"findings":[]}',
				),
			);
			await vi.waitFor(() => {
				expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(2);
				expect(harness.session.getLaneRecords().find((record) => record.laneId === subjectLaneId)).toMatchObject({
					status: "succeeded",
					reasonCode: "independent_verification_accepted",
				});
			});

			const verifierResult = harness.session
				.getWorkerClaimSnapshots()
				.find((claim) => claim.verification !== undefined);
			expect(verifierResult?.verification).toEqual({
				subjectTaskId: subjectLaneId,
				verdict: "accepted",
				reasonCodes: ["focused_checks_passed"],
			});
			expect(workerLaneRecords(harness)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ laneId: subjectLaneId, status: "succeeded" }),
					expect.objectContaining({ type: "worker", status: "succeeded" }),
				]),
			);
		} finally {
			resolveVerifier(
				fauxAssistantMessage(
					'{"summary":"cleanup","status":"completed","verdict":"rejected","reasonCodes":["cleanup"],"findings":[]}',
				),
			);
			harness.cleanup();
		}
	});

	it("retries recovered verification after its temporary admission failure clears", async () => {
		const { implementationProfile, verifierProfile } = verifiedWorkerProfiles();
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: false } },
			workerOrchestrationProfile: implementationProfile,
			additionalOrchestrationProfiles: [verifierProfile],
		});
		try {
			const lifecycle = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			const executionContract = createWorkerExecutionContract({
				worker: {
					profile: implementationProfile,
					modelBinding: implementationProfile.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(implementationProfile, harness.tempDir),
				},
				verifier: {
					profile: verifierProfile,
					modelBinding: verifierProfile.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(verifierProfile, harness.tempDir),
				},
			});
			const prepared = lifecycle.prepare({
				instructions: "Implement before restart",
				executionContract,
				requiredCapabilities: [],
			});
			const task = lifecycle.getTask(prepared.attempt.taskId);
			if (!task) throw new Error("Expected durable implementation task");
			lifecycle.bindGrant(
				prepared.attempt.attemptId,
				createTestExecutionGrant({
					objectiveId: task.task.objectiveId,
					taskId: prepared.attempt.taskId,
					attemptId: prepared.attempt.attemptId,
					role: task.task.role,
				}),
			);
			const handle = lifecycle.start(prepared.record.laneId, implementationProfile.leaseTtlMs);
			lifecycle.finish(
				createWorkerResultContract({
					handle,
					claim: {
						requestId: prepared.record.laneId,
						status: "completed",
						summary: "Implementation survived the interrupted owner session.",
						changedFiles: [],
					},
					accepted: true,
					cwd: harness.tempDir,
					wallClockMs: 10,
					toolCalls: 0,
					verificationRequired: true,
					reasonCode: "independent_verification_required",
				}),
				{ notify: false },
			);

			expect(
				harness.session.getLaneRecords().find((record) => record.laneId === prepared.record.laneId),
			).toMatchObject({
				status: "running",
				reasonCode: "independent_verification_required",
			});
			expect(harness.getPendingResponseCount()).toBe(0);

			harness.setResponses([
				fauxAssistantMessage("Recovery boundary reached."),
				fauxAssistantMessage(
					'{"summary":"recovered verification passed","status":"completed","verdict":"accepted","reasonCodes":["recovery_check_passed"],"findings":[]}',
				),
			]);
			harness.settingsManager.setWorkerDelegationSettings({
				enabled: true,
				orchestrationProfile: implementationProfile.profileId,
			});
			expect(harness.session.getLaneRecords()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						profileId: verifierProfile.profileId,
						status: "queued",
					}),
				]),
			);
			await harness.session.prompt("Reach the next owner-idle recovery boundary", { autoContinueGoal: false });

			await vi.waitFor(() => {
				expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(1);
				expect(
					harness.session.getLaneRecords().find((record) => record.laneId === prepared.record.laneId),
				).toMatchObject({
					status: "succeeded",
					reasonCode: "independent_verification_accepted",
				});
			});
			expect(harness.session.getWorkerClaimSnapshots()[0]?.verification).toEqual({
				subjectTaskId: prepared.record.laneId,
				verdict: "accepted",
				reasonCodes: ["recovery_check_passed"],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("recovers an interrupted active worker with a fresh fence and delivers one terminal handoff", async () => {
		const profile = workerProfile("faux-1");
		const harness = await createHarness({
			settings: {
				workerDelegation: {
					enabled: true,
					maxUsd: profile.budget.maxCostUsd,
					maxWallClockMs: profile.budget.maxWallClockMs,
				},
			},
			workerOrchestrationProfile: profile,
		});
		try {
			const interrupted = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			const executionContract = createWorkerExecutionContract({
				worker: {
					profile,
					modelBinding: profile.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(profile, harness.tempDir),
				},
			});
			const prepared = interrupted.prepare({
				instructions: "Complete after the owner process restarts",
				executionContract,
				requiredCapabilities: [],
			});
			const task = interrupted.getTask(prepared.attempt.taskId);
			if (!task) throw new Error("Expected interrupted durable task");
			interrupted.bindGrant(prepared.attempt.attemptId, {
				...createTestExecutionGrant({
					objectiveId: task.task.objectiveId,
					taskId: prepared.attempt.taskId,
					attemptId: prepared.attempt.attemptId,
					role: task.task.role,
				}),
				capabilities: ["filesystem.read"],
				allowedTools: ["read"],
				readPaths: [harness.tempDir],
				deniedPaths: getPrivateLaneDeniedPaths(harness.tempDir, harness.tempDir),
				budget: { ...profile.budget },
			});
			const staleHandle = interrupted.start(prepared.record.laneId, profile.leaseTtlMs);

			harness.setResponses([
				fauxAssistantMessage("Owner recovery boundary reached."),
				fauxAssistantMessage('{"summary":"recovered worker completed","status":"completed","findings":[]}'),
				fauxAssistantMessage("Recovered handoff acknowledged."),
			]);
			expect(harness.session.getLaneRecords()).toEqual(
				expect.arrayContaining([expect.objectContaining({ laneId: prepared.record.laneId, status: "queued" })]),
			);
			const recoveredBeforeRun = interrupted.getTaskRuntimeSnapshot();
			expect(task.attemptIds).toHaveLength(1);
			expect(recoveredBeforeRun.tasks[prepared.record.laneId]?.attemptIds).toHaveLength(2);
			expect(recoveredBeforeRun.attempts[prepared.attempt.attemptId]?.status).toBe("expired");
			expect(
				recoveredBeforeRun.tasks[prepared.record.laneId]?.attemptIds
					.map((attemptId) => recoveredBeforeRun.attempts[attemptId])
					.at(-1)?.dispatch.executionContract,
			).toEqual(executionContract);

			await harness.session.prompt("Resume interrupted durable work", { autoContinueGoal: false });
			await vi.waitFor(() => {
				expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(1);
				expect(
					harness.session.getLaneRecords().find((record) => record.laneId === prepared.record.laneId),
				).toMatchObject({ status: "succeeded" });
			});

			expect(() =>
				interrupted.finish(
					createWorkerResultContract({
						handle: staleHandle,
						claim: {
							requestId: prepared.record.laneId,
							status: "completed",
							summary: "stale worker attempted completion",
							changedFiles: [],
						},
						accepted: true,
						cwd: harness.tempDir,
						wallClockMs: 10,
						toolCalls: 0,
					}),
				),
			).toThrow();

			const eventStore = new OrchestrationEventStore({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			await vi.waitFor(() => {
				expect(eventStore.readAll().filter((event) => event.type === "notification.delivered")).toHaveLength(1);
			});
			expect(eventStore.readAll().filter((event) => event.type === "notification.enqueued")).toHaveLength(1);
			expect(
				harness.sessionManager
					.getEntries()
					.filter(
						(entry) => entry.type === "custom_message" && entry.customType === "background-worker-completion",
					),
			).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("recovery marks only unmatched calls in an interrupted tool batch as unknown", async () => {
		const profile = workerProfile("faux-1");
		const harness = await createHarness({
			settings: {
				workerDelegation: {
					enabled: true,
					maxUsd: profile.budget.maxCostUsd,
					maxWallClockMs: profile.budget.maxWallClockMs,
				},
			},
			workerOrchestrationProfile: profile,
		});
		try {
			const executionPlan = buildWorkerExecutionPlan({
				profile,
				settings: harness.settingsManager.getWorkerDelegationSettings(),
				cwd: harness.tempDir,
				deniedPaths: getPrivateLaneDeniedPaths(harness.tempDir, harness.tempDir),
				memoryEnabled: harness.settingsManager.getMemoryRetrievalSettings().enabled,
			});
			const interrupted = new WorkerLifecycle({ agentDir: harness.tempDir, sessionId: harness.session.sessionId });
			const executionContract = createWorkerExecutionContract({
				worker: {
					profile,
					modelBinding: profile.modelPolicy.candidates[0]!,
					authority: workerExecutionAuthorityFromPlan(executionPlan),
				},
			});
			const prepared = interrupted.prepare({
				instructions: "Resume a partial tool batch",
				executionContract,
				requiredCapabilities: [],
			});
			const task = interrupted.getTask(prepared.record.laneId);
			if (!task) throw new Error("Expected durable task");
			const compiled = compileWorkerExecutionGrant({
				target: {
					objectiveId: task.task.objectiveId,
					taskId: prepared.attempt.taskId,
					attemptId: prepared.attempt.attemptId,
				},
				profile,
				plan: executionPlan,
				resources: [],
			});
			if (!compiled.ok) throw new Error(`Expected execution grant: ${compiled.reasonCodes.join(",")}`);
			interrupted.bindGrant(prepared.attempt.attemptId, compiled.grant);
			const conversation = new WorkerConversationStore().ensure({
				agentDir: harness.tempDir,
				parentSessionId: harness.session.sessionId,
				logicalAgentId: prepared.record.laneId,
				cwd: harness.tempDir,
				orchestrationProfileId: profile.profileId,
				resourceProfileNames: profile.resourceProfileNames,
				contextPointers: [],
			});
			interrupted.ensureAgent({
				agentId: prepared.record.laneId,
				role: profile.role,
				resumeContext: conversation.getResumeContext(),
			});
			// Recovery is permitted only once the recorded owner PID is provably gone; an open
			// second session must never steal a still-live logical worker.
			interrupted.startAgent(
				prepared.record.laneId,
				prepared.record.laneId,
				profile.leaseTtlMs,
				"pi-worker:999999:11111111-1111-4111-8111-111111111111",
			);
			conversation.appendMessage({ role: "user", content: "Run two reads", timestamp: 1 });
			conversation.appendMessage(
				fauxAssistantMessage(
					[fauxToolCall("read", { path: "first.ts" }), fauxToolCall("read", { path: "second.ts" })],
					{ stopReason: "toolUse" },
				),
			);
			const partialAssistant = conversation.getProviderContext().messages.at(-1);
			if (!partialAssistant || partialAssistant.role !== "assistant") throw new Error("Expected partial tool batch");
			const [first, second] = partialAssistant.content
				.filter(
					(content): content is Extract<(typeof partialAssistant.content)[number], { type: "toolCall" }> =>
						content.type === "toolCall",
				)
				.map((content) => content.id);
			if (!first || !second) throw new Error("Expected two tool calls");
			conversation.appendMessage({
				role: "toolResult",
				toolCallId: first,
				toolName: "read",
				content: [{ type: "text", text: "first completed" }],
				isError: false,
				timestamp: 2,
			});

			let recoveredToolResults: string[] = [];
			let recoveredSystemPrompt = "";
			harness.setResponses([
				(context) => {
					recoveredSystemPrompt = context.systemPrompt ?? "";
					recoveredToolResults = context.messages
						.filter((message) => message.role === "toolResult")
						.map((message) => message.toolCallId);
					return fauxAssistantMessage('{"summary":"recovered after inspection","status":"completed"}');
				},
			]);
			harness.session.getLaneRecords();
			(
				harness.session as unknown as {
					_backgroundLanes: { drainQueuedWorkerDelegations(): void };
				}
			)._backgroundLanes.drainQueuedWorkerDelegations();
			await vi.waitFor(() => expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(1));
			// The durable transcript retains the unknown result, while the provider-facing repair layer
			// replaces failed calls/results with its bounded failure record. The completed sibling stays.
			expect(recoveredToolResults).toEqual([first]);
			expect(recoveredSystemPrompt).toContain("ACTIVE TOOL FAILURES");
			expect(recoveredSystemPrompt).toContain('"tool":"read"');
			expect(recoveredSystemPrompt).toContain("Execution outcome is unknown");
			const recoveredConversation = new WorkerConversationStore().open({
				agentDir: harness.tempDir,
				resumeContext: conversation.getResumeContext(),
			});
			const synthetic = recoveredConversation
				.getProviderContext()
				.messages.filter((message) => message.role === "toolResult" && message.toolCallId === second);
			expect(synthetic).toHaveLength(1);
			if (synthetic[0]?.role === "toolResult") expect(synthetic[0].isError).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the implementation blocked when the owner-pinned verifier rejects it", async () => {
		const { implementationProfile, verifierProfile } = verifiedWorkerProfiles();
		const harness = await createHarness({
			workerOrchestrationProfile: implementationProfile,
			additionalOrchestrationProfiles: [verifierProfile],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage('{"summary":"implementation complete","status":"completed","findings":[]}'),
				fauxAssistantMessage(
					'{"summary":"focused verification failed","status":"completed","verdict":"rejected","reasonCodes":["focused_checks_failed"],"findings":[]}',
				),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Implement and verify" });
			if (!run.started || !run.record) throw new Error("Expected implementation worker to start");
			const subjectLaneId = run.record.laneId;
			await vi.waitFor(() => {
				expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(2);
				expect(harness.session.getLaneRecords().find((record) => record.laneId === subjectLaneId)).toMatchObject({
					status: "failed",
					reasonCode: "independent_verification_rejected:focused_checks_failed",
				});
			});

			expect(
				harness.session.getWorkerClaimSnapshots().find((claim) => claim.verification !== undefined)?.verification,
			).toEqual({
				subjectTaskId: subjectLaneId,
				verdict: "rejected",
				reasonCodes: ["focused_checks_failed"],
			});
		} finally {
			harness.cleanup();
		}
	});

	it("omits delegate tool and workflow.delegate capability from default leaf worker surface", () => {
		const modelRegistry = {
			find: () => ({ id: "m1", provider: "faux" }),
			hasConfiguredAuth: () => true,
		} as any;
		const resolution = resolveWorkerAuthority({
			authority: undefined,
			base: undefined,
			foregroundModel: { id: "m1", provider: "faux" } as any,
			modelRegistry,
			isModelExhausted: () => false,
		});
		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).not.toContain("delegate");
		expect(resolution.shipment.profile.capabilityCeiling).not.toContain("workflow.delegate");
	});

	it("rejects non-viable token grants at admission instead of starving the worker mid-flight", () => {
		const modelRegistry = {
			find: () => ({ id: "m1", provider: "faux" }),
			hasConfiguredAuth: () => true,
		} as any;
		const resolve = (maxTokens?: number) =>
			resolveWorkerAuthority({
				authority: maxTokens === undefined ? undefined : { budget: { maxTokens } },
				base: undefined,
				foregroundModel: { id: "m1", provider: "faux" } as any,
				modelRegistry,
				isModelExhausted: () => false,
			});

		const rejected = resolve(3_000);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.reason).toBe("token_budget_below_floor:requested=3000,min=5000");

		expect(resolve(5_000).ok).toBe(true);
		// Unbounded grants remain valid: the floor only guards explicit non-viable limits.
		expect(resolve(undefined).ok).toBe(true);

		const viable = resolve(5_000);
		if (!viable.ok) throw new Error("Expected a viable base shipment.");
		const rejectedBase = resolveWorkerAuthority({
			authority: undefined,
			base: {
				...viable.shipment,
				profile: {
					...viable.shipment.profile,
					budget: { ...viable.shipment.profile.budget, maxTokens: 3_000 },
				},
			},
			foregroundModel: viable.shipment.model,
			modelRegistry,
			isModelExhausted: () => false,
		});
		expect(rejectedBase).toEqual({
			ok: false,
			reason: "token_budget_below_floor:requested=3000,min=5000",
		});
	});

	it("applies the same viable-token floor to a freshly selected required verifier", async () => {
		const { implementationProfile, verifierProfile } = verifiedWorkerProfiles();
		const rejectedHarness = await createHarness({
			workerOrchestrationProfile: implementationProfile,
			additionalOrchestrationProfiles: [
				{ ...verifierProfile, budget: { ...verifierProfile.budget, maxTokens: 3_000 } },
			],
		});
		try {
			await expect(
				rejectedHarness.session.runWorkerDelegationOnce({ instructions: "Reject the starved verifier" }),
			).resolves.toEqual({
				started: false,
				skipReason: "independent_verifier_unavailable:token_budget_below_floor:requested=3000,min=5000",
			});
			expect(rejectedHarness.getPendingResponseCount()).toBe(0);
		} finally {
			await rejectedHarness.cleanup();
		}

		const viableHarness = await createHarness({
			workerOrchestrationProfile: implementationProfile,
			additionalOrchestrationProfiles: [
				{ ...verifierProfile, budget: { ...verifierProfile.budget, maxTokens: 5_000 } },
			],
		});
		try {
			viableHarness.setResponses([
				fauxAssistantMessage('{"summary":"implementation complete","status":"completed","findings":[]}'),
				fauxAssistantMessage(
					'{"summary":"verification passed","status":"completed","verdict":"accepted","reasonCodes":["focused_checks_passed"],"findings":[]}',
				),
			]);
			const admitted = await viableHarness.session.runWorkerDelegationOnce({
				instructions: "Admit the minimum viable verifier",
			});
			expect(admitted.started).toBe(true);
		} finally {
			await viableHarness.cleanup();
		}
	});

	it("maps tool aliases and admits delegate capability when explicitly requested in authority", () => {
		const modelRegistry = {
			find: () => ({ id: "m1", provider: "faux" }),
			hasConfiguredAuth: () => true,
		} as any;
		const resolution = resolveWorkerAuthority({
			authority: {
				toolNames: ["bash_tool", "python_tool", "delegate"],
			},
			base: undefined,
			foregroundModel: { id: "m1", provider: "faux" } as any,
			modelRegistry,
			isModelExhausted: () => false,
		});
		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["bash", "python", "delegate"]);
		expect(resolution.shipment.profile.capabilityCeiling).toContain("workflow.delegate");
	});
});
