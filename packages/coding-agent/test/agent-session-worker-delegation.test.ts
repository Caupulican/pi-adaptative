import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { getLaneRecordSnapshots } from "../src/core/autonomy/session-lane-record.ts";
import { getWorkerRequestSnapshots } from "../src/core/delegation/session-worker-result.ts";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../src/core/orchestration/profile-store.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const WORKER_JSON =
	'{"summary":"The validator blocks out-of-scope changes.","findings":[{"summary":"Deny lists override allow lists","confidence":0.8}]}';

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

	it("enforces the architect profile's immutable worker-profile allowlist", async () => {
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
			toolNames: ["delegate", "delegate_status"],
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
				skipReason: "orchestration_profile_not_authorized_for_orchestrator",
			});
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
			toolNames: ["delegate", "delegate_status"],
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

			resolveFirst(fauxAssistantMessage('{"summary":"first complete"}'));
			resolveSecond(fauxAssistantMessage('{"summary":"second complete"}'));
			const outcomes = await Promise.all([firstRun, secondRun]);
			expect(outcomes.every((outcome) => outcome.record?.status === "succeeded")).toBe(true);
		} finally {
			resolveFirst(fauxAssistantMessage('{"summary":"cleanup"}'));
			resolveSecond(fauxAssistantMessage('{"summary":"cleanup"}'));
			harness.cleanup();
		}
	});

	it("runs bounded read-only delegation by default on a capable model", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage(WORKER_JSON)]);
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Scout something" });
			expect(run.started).toBe(true);
			expect(getWorkerRequestSnapshots(harness.sessionManager.getEntries())[0]?.envelope.capabilities).toEqual([
				"read_files",
			]);
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
			expect(run.outcome?.result.usageReportId).toBe(`worker:${harness.session.sessionId}:${run.record?.laneId}`);

			const results = harness.session.getWorkerResultSnapshots();
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

	it("denies delegated file tools access to private file-store memory under the workspace", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			const memoryPath = join(harness.tempDir, "MEMORY.md");
			writeFileSync(memoryPath, "PRIVATE_MEMORY_MARKER_SHOULD_NOT_LEAK\n", "utf-8");
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: memoryPath })], { stopReason: "toolUse" }),
				fauxAssistantMessage('{"summary":"private read attempt complete"}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Read private memory" });

			expect(run.outcome?.result.status).toBe("blocked");
			expect(run.outcome?.result.blockers?.some((blocker) => blocker.includes("read blocked"))).toBe(true);
			expect(JSON.stringify(run.outcome?.result)).not.toContain("PRIVATE_MEMORY_MARKER_SHOULD_NOT_LEAK");
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
			expect(harness.session.getWorkerResultSnapshots()[0]?.status).toBe("blocked");
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
					[fauxToolCall("write", { path: "src/direct.ts", content: "export const direct = true;\n" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage('{"summary":"direct write complete","actions":[]}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Write the direct helper" });

			expect(readFileSync(join(harness.tempDir, "src/direct.ts"), "utf-8")).toBe("export const direct = true;\n");
			expect(run.outcome?.result.changedFiles).toEqual(["src/direct.ts"]);
			expect(run.outcome?.acceptance).toMatchObject({
				outcome: "ask-user",
				reasonCode: "parent_review_required",
			});
			const request = getWorkerRequestSnapshots(harness.sessionManager.getEntries())[0];
			expect(request?.envelope.allowedTools).toEqual(["read", "grep", "find", "ls", "write", "edit"]);
			expect(request?.envelope.allowedTools).not.toContain("delegate");
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
				fauxAssistantMessage([fauxToolCall("write", { path: "outside.ts", content: "not allowed\n" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage('{"summary":"write was refused"}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Try the scoped write" });

			expect(existsSync(join(harness.tempDir, "outside.ts"))).toBe(false);
			expect(run.outcome?.result.changedFiles).toEqual([]);
			expect(run.outcome?.result.status).toBe("blocked");
			expect(run.outcome?.result.blockers?.some((blocker) => blocker.includes("write blocked"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("reports a failed direct edit target conservatively for parent review", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, writeEnabled: true, writePaths: ["src"] } },
		});
		try {
			mkdirSync(join(harness.tempDir, "src"), { recursive: true });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("edit", { path: "src/missing.ts", oldText: "x", newText: "y" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage('{"summary":"edit failed"}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Edit the missing helper" });

			expect(run.outcome?.result.changedFiles).toEqual(["src/missing.ts"]);
			expect(run.outcome?.result.status).toBe("blocked");
			expect(run.outcome?.result.blockers).toContain("edit failed during isolated execution");
		} finally {
			harness.cleanup();
		}
	});

	it("drains multiple queued local workers up to the configured concurrency", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, maxConcurrent: 1 } },
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
				fauxAssistantMessage('{"summary":"first worker done"}'),
				fauxAssistantMessage('{"summary":"second worker done"}'),
			]);

			await harness.session.prompt("Delegate both scouts", { autoContinueGoal: false });
			await vi.waitFor(() => expect(harness.session.getWorkerResultSnapshots()).toHaveLength(2));

			expect(harness.session.getWorkerResultSnapshots().map((result) => result.summary)).toEqual([
				"first worker done",
				"second worker done",
			]);
			expect(workerLaneRecords(harness).map((record) => record.status)).toEqual(["succeeded", "succeeded"]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
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
			context.systemPrompt?.includes("You are a bounded subagent shipped by a coding-agent session")
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
			expect(harness.session.getWorkerResultSnapshots()).toHaveLength(0);
			expect(JSON.stringify(harness.session.messages)).toContain("Foreground remained responsive.");

			resolveWorker(fauxAssistantMessage('{"summary":"background result arrived"}'));
			await terminal;
			await handoff;
			await wakeReply;

			expect(harness.session.getWorkerResultSnapshots()).toHaveLength(1);
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

	it("lets the model delegate through the delegate tool in a full turn", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("delegate", { instructions: "Scout the validation rules" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(WORKER_JSON),
				fauxAssistantMessage("Delegation reviewed."),
			]);

			await harness.session.prompt("Please delegate a scout task", { autoContinueGoal: false });
			await vi.waitFor(() => expect(harness.session.getWorkerResultSnapshots()).toHaveLength(1));

			expect(harness.session.getWorkerResultSnapshots()).toHaveLength(1);
			expect(workerLaneRecords(harness)[0]?.status).toBe("succeeded");

			const serialized = JSON.stringify(harness.session.messages);
			expect(serialized).not.toContain("UNTRUSTED");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});
