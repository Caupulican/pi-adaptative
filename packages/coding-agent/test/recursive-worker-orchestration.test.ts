import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import type { AssistantMessage, Message } from "@caupulican/pi-ai/types";
import { describe, expect, it, vi } from "vitest";
import { workerConversationSessionsDir } from "../src/core/agent-paths.ts";
import { STABLE_SHELL_TOOL_NAME } from "../src/core/default-tool-surface.ts";
import type { WorkerAgentView } from "../src/core/delegation/worker-agent-control.ts";
import { DEFAULT_WORKER_FLEET_LIMITS } from "../src/core/delegation/worker-fleet-limits.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { budgetedTokens } from "../src/core/orchestration/capability-gateway.ts";
import { ORCHESTRATION_SCHEMA_VERSION } from "../src/core/orchestration/contracts.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./suite/test-resources.ts";
import { windowsLoadedSuiteTimeout } from "./windows-loaded-suite-timeout.ts";

const UNAVAILABLE_SHELL_TOOL_NAME = "nonexistent_shell";

interface AgentTranscriptPage {
	agentId: string;
	cursor: number;
	messages: Message[];
	nextCursor?: number;
	omittedMessages: number;
	serializedBytes: number;
}

interface AgentTreeControl {
	listWorkerAgents(): WorkerAgentView[];
	readWorkerAgentTranscript(agentId: string, options?: { cursor?: number; maxMessages?: number }): AgentTranscriptPage;
	startWorkerAgentTask(
		agentId: string,
		message: string,
		options?: { idempotencyKey?: string },
	): { started: boolean; steering: false; messageId: string; skipReason?: string };
}

function treeControl(session: object): AgentTreeControl {
	return (session as { _backgroundLanes: AgentTreeControl })._backgroundLanes;
}

function conversationEntries(agentDir: string, sessionId: string): string[] {
	const directory = workerConversationSessionsDir(agentDir, sessionId);
	return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function durableEntityCounts(lifecycle: WorkerLifecycle): { agents: number; tasks: number; attempts: number } {
	const snapshot = lifecycle.getTaskRuntimeSnapshot();
	return {
		agents: Object.keys(snapshot.agents).length,
		tasks: Object.keys(snapshot.tasks).length,
		attempts: Object.keys(snapshot.attempts).length,
	};
}

function seedAgent(lifecycle: WorkerLifecycle, args: { agentId: string; cwd: string; parentAgentId?: string }): void {
	lifecycle.ensureAgent({
		agentId: args.agentId,
		...(args.parentAgentId ? { parentAgentId: args.parentAgentId } : {}),
		role: "implementer",
		resumeContext: {
			provider: "external",
			sessionId: `seed-${args.agentId}`,
			cwd: args.cwd,
			resourceProfileNames: [],
			contextPointers: [],
		},
	});
}

describe("recursive worker orchestration", () => {
	it("allows an admitted worker to spawn a durable child through its delegate tool", async () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "recursive-wait",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
		});
		const harness = await createHarness({ workerOrchestrationProfile: profile });
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("delegate", { instructions: "Produce child evidence." })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall("delegate", { action: "wait", agentId: "worker-2" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage('{"summary":"child evidence","status":"completed"}'),
				fauxAssistantMessage('{"summary":"parent delegated successfully","status":"completed"}'),
			]);

			const parent = await harness.session.runWorkerDelegationOnce({
				instructions: "Attempt nested delegation.",
			});

			expect(parent.record?.status).toBe("succeeded");
			const parentTranscript = treeControl(harness.session).readWorkerAgentTranscript("worker-1", {
				maxMessages: 64,
			});
			expect(JSON.stringify(parentTranscript.messages)).toContain("delegate started");
			const agents = treeControl(harness.session).listWorkerAgents();
			expect(agents).toHaveLength(2);
			expect(agents).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ agentId: "worker-1", rootAgentId: "worker-1", depth: 0 }),
					expect.objectContaining({ parentAgentId: "worker-1", rootAgentId: "worker-1", depth: 1 }),
				]),
			);
		} finally {
			await harness.cleanup();
		}
	});

	it("routes a nested child's terminal handoff durably to its owning parent", async () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "recursive-handoff",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
		});
		const harness = await createHarness({
			workerOrchestrationProfile: profile,
			settings: { workerDelegation: { enabled: true, maxConcurrent: 1 } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("delegate", { instructions: "Produce nested result" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall("delegate", { action: "wait", agentId: "worker-2" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage('{"summary":"nested result","status":"completed"}'),
				fauxAssistantMessage('{"summary":"parent observed child completion","status":"completed"}'),
			]);

			const parent = await harness.session.runWorkerDelegationOnce({
				instructions: "Delegate worker.",
			});
			expect(parent.record?.status).toBe("succeeded");
			expect(harness.session.getLaneRecords().filter((record) => record.type === "worker")).toHaveLength(2);
			const parentTranscript = treeControl(harness.session).readWorkerAgentTranscript("worker-1", {
				maxMessages: 64,
			});
			expect(JSON.stringify(parentTranscript.messages)).toContain("Worker terminal handoff");
			expect(JSON.stringify(parentTranscript.messages)).toContain("childAgentId=worker-2");
		} finally {
			await harness.cleanup();
		}
	});

	it("lists the complete session tree and pages exact peer transcript messages", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"exact transcript","status":"completed"}')]);
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Preserve this exact request." });
			if (!run.record) throw new Error("Expected worker record.");

			const control = treeControl(harness.session);
			const agents = control.listWorkerAgents();
			expect(agents).toEqual([
				expect.objectContaining({ agentId: run.record.laneId, rootAgentId: run.record.laneId, depth: 0 }),
			]);
			expect(JSON.stringify(agents)).not.toContain("resumeContext");
			const first = control.readWorkerAgentTranscript(run.record.laneId, { cursor: 0, maxMessages: 1 });
			expect(first).toMatchObject({
				agentId: run.record.laneId,
				cursor: 0,
				nextCursor: 2,
				omittedMessages: 0,
			});
			expect(first.messages).toHaveLength(1);
			expect(first.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(first.messages), "utf8"));
			expect(first.messages[0]).toMatchObject({ role: "user" });
			expect(JSON.stringify(first.messages[0])).toContain("Preserve this exact request.");
			const second = control.readWorkerAgentTranscript(run.record.laneId, {
				cursor: first.nextCursor,
				maxMessages: 1,
			});
			expect(second.messages[0]).toMatchObject({ role: "assistant" });
			expect(JSON.stringify(second.messages[0])).toContain("exact transcript");
			expect(second.omittedMessages).toBe(0);
			expect(second.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(second.messages), "utf8"));
			expect(second.nextCursor).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	});

	it("lets top-level workers discover peers without exposing private resume paths", async () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "peer-discovery",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
		});
		const harness = await createHarness({ workerOrchestrationProfile: profile });
		try {
			harness.setResponses([
				fauxAssistantMessage('{"summary":"first peer ready","status":"completed"}'),
				fauxAssistantMessage([fauxToolCall("delegate", { action: "list" })], { stopReason: "toolUse" }),
				fauxAssistantMessage('{"summary":"peer list inspected","status":"completed"}'),
			]);
			const first = await harness.session.runWorkerDelegationOnce({ instructions: "Become the first peer." });
			if (!first.record) throw new Error("Expected first worker record.");

			const second = await harness.session.runWorkerDelegationOnce({ instructions: "Discover the first peer." });
			if (!second.record) throw new Error("Expected second worker record.");

			const transcript = treeControl(harness.session).readWorkerAgentTranscript(second.record.laneId, {
				maxMessages: 64,
			});
			const serialized = JSON.stringify(transcript.messages);
			expect(serialized).toContain(first.record.laneId);
			expect(serialized).toContain(second.record.laneId);
			expect(serialized).not.toContain("resumeContext");
			expect(serialized).not.toContain("sessionFile");
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects an exact ancestor task replay independently of the fleet depth bound", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"root complete","status":"completed"}')]);
			const instructions = "Do not recursively replay this exact task.";
			const root = await harness.session.runWorkerDelegationOnce({ instructions });
			if (!root.record) throw new Error("Expected root worker record.");

			const replay = await harness.session.runWorkerDelegationOnce({
				instructions,
				parentAgentId: root.record.laneId,
			});

			expect(replay).toEqual({ started: false, skipReason: "recursive_delegation_cycle" });
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects a child beyond the durable depth bound without creating task or conversation state", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"depth root ready","status":"completed"}')]);
			const root = await harness.session.runWorkerDelegationOnce({ instructions: "Create the depth-bound root." });
			if (!root.record) throw new Error("Expected root worker record.");
			const lifecycle = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			const rootAttempt = lifecycle.getLatestAgentAttempt(root.record.laneId);
			const executionContract = rootAttempt?.dispatch.executionContract;
			if (!executionContract) throw new Error("Expected root execution contract.");
			let parentAgentId = root.record.laneId;
			for (let depth = 1; depth <= DEFAULT_WORKER_FLEET_LIMITS.maxDepth; depth += 1) {
				const prepared = lifecycle.prepare({
					instructions: `Seed bounded depth ${depth}.`,
					parentAgentId,
					executionContract,
					requiredCapabilities: [],
				});
				seedAgent(lifecycle, {
					agentId: prepared.record.laneId,
					parentAgentId,
					cwd: harness.tempDir,
				});
				parentAgentId = prepared.record.laneId;
			}
			const before = durableEntityCounts(lifecycle);
			const beforeConversations = conversationEntries(harness.tempDir, harness.session.sessionId);
			harness.setResponses([fauxAssistantMessage('{"summary":"must not execute","status":"completed"}')]);

			const rejected = await harness.session.runWorkerDelegationOnce({
				instructions: "Attempt one child beyond the bounded depth.",
				parentAgentId,
			});

			expect(rejected).toEqual({ started: false, skipReason: "worker_agent_depth_limit_reached" });
			expect(durableEntityCounts(lifecycle)).toEqual(before);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects a sixty-fifth direct child before creating any durable child state", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"fanout root ready","status":"completed"}')]);
			const root = await harness.session.runWorkerDelegationOnce({ instructions: "Create the fanout-bound root." });
			if (!root.record) throw new Error("Expected root worker record.");
			const lifecycle = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			for (let index = 0; index < DEFAULT_WORKER_FLEET_LIMITS.maxChildrenPerAgent; index += 1) {
				seedAgent(lifecycle, {
					agentId: `seed-direct-child-${index}`,
					parentAgentId: root.record.laneId,
					cwd: harness.tempDir,
				});
			}
			const before = durableEntityCounts(lifecycle);
			const beforeConversations = conversationEntries(harness.tempDir, harness.session.sessionId);
			harness.setResponses([fauxAssistantMessage('{"summary":"must not execute","status":"completed"}')]);

			const rejected = await harness.session.runWorkerDelegationOnce({
				instructions: "Attempt the sixty-fifth direct child.",
				parentAgentId: root.record.laneId,
			});

			expect(rejected).toEqual({ started: false, skipReason: "worker_agent_child_limit_reached" });
			expect(durableEntityCounts(lifecycle)).toEqual(before);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects a session-wide identity overflow before creating task or conversation state", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"session root ready","status":"completed"}')]);
			const root = await harness.session.runWorkerDelegationOnce({ instructions: "Create the session-bound root." });
			if (!root.record) throw new Error("Expected root worker record.");
			const lifecycle = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			for (let index = 1; index < DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession; index += 1) {
				seedAgent(lifecycle, { agentId: `seed-session-agent-${index}`, cwd: harness.tempDir });
			}
			const before = durableEntityCounts(lifecycle);
			const beforeConversations = conversationEntries(harness.tempDir, harness.session.sessionId);
			harness.setResponses([fauxAssistantMessage('{"summary":"must not execute","status":"completed"}')]);

			const rejected = await harness.session.runWorkerDelegationOnce({
				instructions: "Attempt one identity beyond the session bound.",
			});

			expect(rejected).toEqual({ started: false, skipReason: "worker_agent_session_limit_reached" });
			expect(durableEntityCounts(lifecycle)).toEqual(before);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("reserves the final identity for a required verifier before persisting the implementation", async () => {
		const verifierProfile = createTestWorkerOrchestrationProfile({
			profileId: "identity-headroom-verifier",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			role: "verifier",
		});
		const implementationProfile = createTestWorkerOrchestrationProfile({
			profileId: "identity-headroom-implementation",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			requireIndependentVerification: true,
			verificationProfileId: verifierProfile.profileId,
		});
		const harness = await createHarness({
			workerOrchestrationProfile: implementationProfile,
			additionalOrchestrationProfiles: [verifierProfile],
		});
		try {
			const lifecycle = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			for (let index = 0; index < DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession - 1; index += 1) {
				seedAgent(lifecycle, { agentId: `seed-verifier-negative-${index}`, cwd: harness.tempDir });
			}
			const before = durableEntityCounts(lifecycle);
			const beforeConversations = conversationEntries(harness.tempDir, harness.session.sessionId);
			harness.setResponses([fauxAssistantMessage('{"summary":"must not execute","status":"completed"}')]);

			const rejected = await harness.session.runWorkerDelegationOnce({
				instructions: "Do not strand the required verifier.",
			});

			expect(rejected).toEqual({ started: false, skipReason: "worker_agent_session_limit_reached" });
			expect(durableEntityCounts(lifecycle)).toEqual(before);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	it(
		"uses the two remaining identities for an implementation and its required verifier",
		async () => {
			const verifierProfile = createTestWorkerOrchestrationProfile({
				profileId: "identity-headroom-control-verifier",
				model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
				role: "verifier",
			});
			const implementationProfile = createTestWorkerOrchestrationProfile({
				profileId: "identity-headroom-control-implementation",
				model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
				requireIndependentVerification: true,
				verificationProfileId: verifierProfile.profileId,
			});
			const harness = await createHarness({
				workerOrchestrationProfile: implementationProfile,
				additionalOrchestrationProfiles: [verifierProfile],
			});
			let resolveVerifier: ((message: AssistantMessage) => void) | undefined;
			const verifierCompletion = new Promise<AssistantMessage>((resolve) => {
				resolveVerifier = resolve;
			});
			let verifierStarted = false;
			try {
				const lifecycle = new WorkerLifecycle({
					agentDir: harness.tempDir,
					sessionId: harness.session.sessionId,
				});
				for (let index = 0; index < DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession - 2; index += 1) {
					seedAgent(lifecycle, { agentId: `seed-verifier-control-${index}`, cwd: harness.tempDir });
				}
				harness.setResponses([
					fauxAssistantMessage('{"summary":"implementation complete","status":"completed","findings":[]}'),
					() => {
						verifierStarted = true;
						return verifierCompletion;
					},
				]);

				const admitted = await harness.session.runWorkerDelegationOnce({
					instructions: "Use the reserved verifier identity.",
				});
				expect(admitted.started).toBe(true);
				await vi.waitFor(() => expect(verifierStarted).toBe(true), { timeout: 10_000 });
				expect(durableEntityCounts(lifecycle).agents).toBe(DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession);
				resolveVerifier?.(
					fauxAssistantMessage(
						'{"summary":"verification passed","status":"completed","verdict":"accepted","reasonCodes":["verified"],"findings":[]}',
					),
				);
				await vi.waitFor(
					() => {
						expect(
							Object.values(lifecycle.getTaskRuntimeSnapshot().tasks).some(
								(task) => task.verification?.verdict === "accepted",
							),
						).toBe(true);
					},
					{ timeout: 15_000 },
				);
			} finally {
				resolveVerifier?.(
					fauxAssistantMessage(
						'{"summary":"cleanup","status":"completed","verdict":"rejected","reasonCodes":["cleanup"],"findings":[]}',
					),
				);
				await harness.cleanup();
			}
		},
		(windowsLoadedSuiteTimeout() ?? 5000) + 10_000,
	);

	it.each([
		{
			name: "rejects verified persistent-agent reuse at a full fleet before mailbox or task creation",
			remainingIdentities: 0,
			expectedStarted: false,
		},
		{
			name: "reuses a verified persistent agent when exactly its verifier identity remains",
			remainingIdentities: 1,
			expectedStarted: true,
		},
	])(
		"$name",
		async ({ remainingIdentities, expectedStarted }) => {
			const scenario = expectedStarted ? "control" : "negative";
			const verifierProfile = createTestWorkerOrchestrationProfile({
				profileId: `reuse-headroom-${scenario}-verifier`,
				model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
				role: "verifier",
			});
			const implementationProfile = createTestWorkerOrchestrationProfile({
				profileId: `reuse-headroom-${scenario}-implementation`,
				model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
				requireIndependentVerification: true,
				verificationProfileId: verifierProfile.profileId,
			});
			const harness = await createHarness({
				workerOrchestrationProfile: implementationProfile,
				additionalOrchestrationProfiles: [verifierProfile],
			});
			try {
				harness.setResponses([
					fauxAssistantMessage('{"summary":"initial implementation","status":"completed","findings":[]}'),
					fauxAssistantMessage(
						'{"summary":"initial verification","status":"completed","verdict":"accepted","reasonCodes":["verified"],"findings":[]}',
					),
				]);
				const initial = await harness.session.runWorkerDelegationOnce({
					instructions: "Create the reusable specialist.",
				});
				expect(initial.record?.laneId).toBe("worker-1");
				const lifecycle = new WorkerLifecycle({
					agentDir: harness.tempDir,
					sessionId: harness.session.sessionId,
				});
				await vi.waitFor(
					() => {
						expect(
							Object.values(lifecycle.getTaskRuntimeSnapshot().tasks).filter(
								(task) => task.verification?.verdict === "accepted",
							),
						).toHaveLength(1);
					},
					{ timeout: 10_000 },
				);
				let seeded = 0;
				const targetAgentCount = DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession - remainingIdentities;
				while (durableEntityCounts(lifecycle).agents < targetAgentCount) {
					seedAgent(lifecycle, { agentId: `seed-reuse-headroom-${scenario}-${seeded++}`, cwd: harness.tempDir });
				}
				const before = durableEntityCounts(lifecycle);
				const beforeConversations = conversationEntries(harness.tempDir, harness.session.sessionId);
				harness.setResponses([
					fauxAssistantMessage('{"summary":"reused implementation","status":"completed","findings":[]}'),
					fauxAssistantMessage(
						'{"summary":"reuse verification","status":"completed","verdict":"accepted","reasonCodes":["verified"],"findings":[]}',
					),
				]);

				const outcome = treeControl(harness.session).startWorkerAgentTask(
					"worker-1",
					"Reuse the retained specialist and preserve verifier headroom.",
					{ idempotencyKey: `reuse-headroom-${scenario}` },
				);

				if (!expectedStarted) {
					expect(outcome).toEqual({
						started: false,
						steering: false,
						messageId: "",
						skipReason: "worker_agent_session_limit_reached",
					});
					expect(durableEntityCounts(lifecycle)).toEqual(before);
					expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
					expect(harness.getPendingResponseCount()).toBe(2);
					return;
				}

				expect(outcome.started).toBe(true);
				await vi.waitFor(
					() => {
						expect(durableEntityCounts(lifecycle).agents).toBe(DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession);
						expect(
							Object.values(lifecycle.getTaskRuntimeSnapshot().tasks).filter(
								(task) => task.verification?.verdict === "accepted",
							),
						).toHaveLength(2);
					},
					{ timeout: 10_000 },
				);
				expect(harness.getPendingResponseCount()).toBe(0);
			} finally {
				await harness.cleanup();
			}
		},
		90_000,
	);

	it("rejects a descendant preset that would introduce unadmitted resources or soul", async () => {
		let privilegedSkill = "";
		const parentProfile = createTestWorkerOrchestrationProfile({
			profileId: "bounded-parent-context",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
		});
		const privilegedProfile = createTestWorkerOrchestrationProfile({
			profileId: "privileged-child-context",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
			resourceProfileNames: ["privileged-worker-resources"],
		});
		const resourceLoader = {
			...createTestResourceLoader(),
			getDiscoverableSkillPaths: () => [privilegedSkill],
		};
		const harness = await createHarness({
			workerOrchestrationProfile: parentProfile,
			additionalOrchestrationProfiles: [privilegedProfile],
			resourceLoader,
		});
		try {
			privilegedSkill = join(harness.tempDir, "privileged", "SKILL.md");
			mkdirSync(dirname(privilegedSkill), { recursive: true });
			writeFileSync(privilegedSkill, "PRIVILEGED_RESOURCE_MARKER", "utf-8");
			harness.settingsManager.setProfileDefinition(
				"privileged-worker-resources",
				{
					soul: "PRIVILEGED_SOUL_MARKER",
					resources: { skills: { allow: ["*"] } },
				},
				"global",
			);
			harness.setResponses([fauxAssistantMessage('{"summary":"bounded parent ready","status":"completed"}')]);
			const root = await harness.session.runWorkerDelegationOnce({
				instructions: "Create a parent without privileged context.",
			});
			if (!root.record) throw new Error("Expected root worker record.");
			const lifecycle = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			const before = durableEntityCounts(lifecycle);
			const beforeConversations = conversationEntries(harness.tempDir, harness.session.sessionId);
			let childSystemPrompt = "";
			harness.setResponses([
				(context) => {
					childSystemPrompt = context.systemPrompt ?? "";
					return fauxAssistantMessage('{"summary":"must not execute","status":"completed"}');
				},
			]);

			const rejected = await harness.session.runWorkerDelegationOnce({
				instructions: "Attempt to acquire the privileged preset context.",
				parentAgentId: root.record.laneId,
				profileId: privilegedProfile.profileId,
			});

			expect(rejected).toEqual({ started: false, skipReason: "orchestration_context_authority_exceeded" });
			expect(childSystemPrompt).toBe("");
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(durableEntityCounts(lifecycle)).toEqual(before);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			const serialized = JSON.stringify(lifecycle.getTaskRuntimeSnapshot());
			expect(serialized).not.toContain("PRIVILEGED_RESOURCE_MARKER");
			expect(serialized).not.toContain("PRIVILEGED_SOUL_MARKER");
			expect(serialized).not.toContain(privilegedSkill);
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects a descendant whose required verifier would introduce unadmitted context", async () => {
		let privilegedVerifierSkill = "";
		const parentProfile = createTestWorkerOrchestrationProfile({
			profileId: "bounded-verifier-parent",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
		});
		const verifierProfile = createTestWorkerOrchestrationProfile({
			profileId: "privileged-descendant-verifier",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			role: "verifier",
			resourceProfileNames: ["privileged-verifier-resources"],
		});
		const childProfile = createTestWorkerOrchestrationProfile({
			profileId: "verified-bounded-child",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
			requireIndependentVerification: true,
			verificationProfileId: verifierProfile.profileId,
		});
		const resourceLoader = {
			...createTestResourceLoader(),
			getDiscoverableSkillPaths: () => [privilegedVerifierSkill],
		};
		const harness = await createHarness({
			workerOrchestrationProfile: parentProfile,
			additionalOrchestrationProfiles: [childProfile, verifierProfile],
			resourceLoader,
		});
		try {
			privilegedVerifierSkill = join(harness.tempDir, "privileged-verifier", "SKILL.md");
			mkdirSync(dirname(privilegedVerifierSkill), { recursive: true });
			writeFileSync(privilegedVerifierSkill, "PRIVILEGED_VERIFIER_RESOURCE", "utf-8");
			harness.settingsManager.setProfileDefinition(
				"privileged-verifier-resources",
				{
					soul: "PRIVILEGED_VERIFIER_SOUL",
					resources: { skills: { allow: ["*"] } },
				},
				"global",
			);
			harness.setResponses([fauxAssistantMessage('{"summary":"bounded parent ready","status":"completed"}')]);
			const root = await harness.session.runWorkerDelegationOnce({
				instructions: "Create the verifier-bounded parent.",
			});
			if (!root.record) throw new Error("Expected root worker record.");
			const lifecycle = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			const before = durableEntityCounts(lifecycle);
			const beforeConversations = conversationEntries(harness.tempDir, harness.session.sessionId);
			harness.setResponses([fauxAssistantMessage('{"summary":"must not execute","status":"completed"}')]);

			const rejected = await harness.session.runWorkerDelegationOnce({
				instructions: "Attempt a verifier context escalation.",
				parentAgentId: root.record.laneId,
				profileId: childProfile.profileId,
			});

			expect(rejected).toEqual({ started: false, skipReason: "orchestration_context_authority_exceeded" });
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(durableEntityCounts(lifecycle)).toEqual(before);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			const serialized = JSON.stringify(lifecycle.getTaskRuntimeSnapshot());
			expect(serialized).not.toContain("PRIVILEGED_VERIFIER_RESOURCE");
			expect(serialized).not.toContain("PRIVILEGED_VERIFIER_SOUL");
			expect(serialized).not.toContain(privilegedVerifierSkill);
		} finally {
			await harness.cleanup();
		}
	});

	it("treats loaded profiles as selectable presets instead of an architect authority allowlist", async () => {
		const now = new Date().toISOString();
		const architect = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			profileId: "architect-preset",
			description: "Foreground orchestration preset",
			role: "orchestrator" as const,
			modelPolicy: {
				mode: "fixed" as const,
				candidates: [{ provider: "faux", modelId: "faux-1", thinkingLevel: "off" as const }],
			},
			capabilityCeiling: ["workflow.delegate" as const],
			toolNames: ["delegate", "delegate_status"],
			resourceProfileNames: [],
			dispatchProfileIds: ["test-worker"],
			budget: { maxCostUsd: 1 },
			maxConcurrent: 1,
			leaseTtlMs: 90_000,
			requireIndependentVerification: false,
			createdAt: now,
			updatedAt: now,
		};
		const alternate = createTestWorkerOrchestrationProfile({
			profileId: "alternate-preset",
			model: { provider: "faux", id: "faux-1" },
		});
		const harness = await createHarness({
			orchestrationProfile: architect,
			additionalOrchestrationProfiles: [alternate],
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"alternate selected","status":"completed"}')]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use the alternate loaded preset.",
				profileId: alternate.profileId,
			});

			expect(run.started).toBe(true);
			expect(run.record?.profileId).toBe(alternate.profileId);
		} finally {
			await harness.cleanup();
		}
	});

	it("admits a profile-free model, reasoning, tool, capability, and path specification as a durable grant", async () => {
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 200_000 },
				{ id: "selected", contextWindow: 200_000, reasoning: true },
			],
			settings: {
				workerDelegation: { enabled: true, orchestrationProfile: undefined, maxConcurrent: 128 },
			},
		});
		try {
			let seenModel = "";
			let seenReasoning: unknown;
			let seenTools: string[] = [];
			harness.setResponses([
				(context, options, _state, model) => {
					seenModel = model.id;
					seenReasoning = (options as { reasoning?: unknown } | undefined)?.reasoning;
					seenTools = context.tools?.map((tool) => tool.name) ?? [];
					return fauxAssistantMessage('{"summary":"free authority complete","status":"completed"}');
				},
			]);
			const provider = harness.getModel("selected")?.provider;
			if (!provider) throw new Error("Expected selected faux model.");

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Exercise the profile-free authority contract.",
				authority: {
					role: "operator",
					model: { provider, modelId: "selected" },
					thinkingLevel: "low",
					capabilities: ["filesystem.read", "process.exec", "workflow.delegate"],
					toolNames: ["read", STABLE_SHELL_TOOL_NAME, "delegate"],
					readPaths: ["."],
					budget: { maxTokens: 8_192, maxToolCalls: 64 },
				},
			});

			if (!run.started) throw new Error(`Expected selected model admission, got ${run.skipReason}.`);
			expect(run.record?.status).toBe("succeeded");
			expect(seenModel).toBe("selected");
			expect(seenReasoning).toBe("low");
			expect(seenTools).toEqual(["read", "memory", STABLE_SHELL_TOOL_NAME, "delegate"]);
			expect(harness.settingsManager.getWorkerDelegationSettings().maxConcurrent).toBe(128);
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const attempt = Object.values(snapshot.attempts)[0];
			expect(attempt?.dispatch.executionContract?.worker).toMatchObject({
				modelBinding: { provider, modelId: "selected", thinkingLevel: "low" },
				authority: {
					capabilities: ["filesystem.read", "process.exec", "workflow.delegate", "memory.query"],
					toolNames: ["read", "bash", "delegate", "memory"],
				},
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("uses the selected model's supported reasoning default when authority omits it", async () => {
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 200_000, reasoning: true },
				{ id: "selected-no-reasoning", contextWindow: 200_000 },
			],
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"selected default accepted","status":"completed"}')]);
			const provider = harness.getModel("selected-no-reasoning")?.provider;
			if (!provider) throw new Error("Expected selected faux model.");

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Select the non-reasoning model without redundant reasoning configuration.",
				authority: {
					model: { provider, modelId: "selected-no-reasoning" },
					budget: { maxWallClockMs: Number.MAX_SAFE_INTEGER },
				},
			});

			if (!run.started) throw new Error(`Expected non-reasoning model admission, got ${run.skipReason}.`);
			expect(run.record?.status).toBe("succeeded");
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			expect(Object.values(snapshot.attempts)[0]?.dispatch.executionContract?.worker.modelBinding).toEqual({
				provider,
				modelId: "selected-no-reasoning",
				thinkingLevel: "off",
			});
			expect(Object.values(snapshot.attempts)[0]?.dispatch.executionContract?.worker.profile.leaseTtlMs).toBe(
				Number.MAX_SAFE_INTEGER,
			);
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects an unavailable shell alias before provider execution", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"must not execute"}')]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Try to request the other platform's shell.",
				authority: {
					capabilities: ["process.exec"],
					toolNames: [UNAVAILABLE_SHELL_TOOL_NAME],
				},
			});

			expect(run).toEqual({
				started: false,
				skipReason: `orchestration_tool_unavailable:${UNAVAILABLE_SHELL_TOOL_NAME}`,
			});
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("canonicalizes a legacy powershell authority to the stable shell contract", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			let tools: string[] = [];
			harness.setResponses([
				(context) => {
					tools = context.tools?.map((tool) => tool.name) ?? [];
					return fauxAssistantMessage('{"summary":"legacy shell canonicalized","status":"completed"}');
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use the stored legacy shell name.",
				authority: {
					capabilities: ["process.exec"],
					toolNames: ["powershell"],
				},
			});

			expect(run.record?.status).toBe("succeeded");
			expect(tools).toEqual(["memory", STABLE_SHELL_TOOL_NAME]);
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			expect(Object.values(snapshot.attempts)[0]?.dispatch.executionContract?.worker.authority.toolNames).toEqual([
				"bash",
				"memory",
			]);
		} finally {
			await harness.cleanup();
		}
	});

	it("uses the maximum host-permitted local surface when neither a profile nor authority override is supplied", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			let tools: string[] = [];
			harness.setResponses([
				(context) => {
					tools = context.tools?.map((tool) => tool.name) ?? [];
					return fauxAssistantMessage('{"summary":"adaptive defaults","status":"completed"}');
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use the strongest useful host-permitted surface.",
			});

			expect(run.record?.status).toBe("succeeded");
			expect(tools).toEqual(["read", "grep", "find", "ls", "memory", "write", "edit", STABLE_SHELL_TOOL_NAME]);
		} finally {
			await harness.cleanup();
		}
	});

	it("honors an explicit non-delegating leaf authority", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			let tools: string[] = [];
			harness.setResponses([
				(context) => {
					tools = context.tools?.map((tool) => tool.name) ?? [];
					return fauxAssistantMessage('{"summary":"leaf complete","status":"completed"}');
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Run as a non-delegating leaf.",
				authority: { capabilities: [] },
			});

			expect(run.record?.status).toBe("succeeded");
			expect(tools).toEqual(["memory"]);
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			expect(Object.values(snapshot.attempts)[0]?.grant?.allowedTools).toEqual(["memory"]);
			expect(Object.values(snapshot.attempts)[0]?.grant?.capabilities).toEqual(["memory.query"]);
		} finally {
			await harness.cleanup();
		}
	});

	it("debits descendant provider capacity from one cumulative root token budget", async () => {
		const treeTokenBudget = 8_000;
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "global-budget",
			model: { provider: "faux", id: "faux-1", maxTokens: treeTokenBudget },
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
		});
		profile.budget = { ...profile.budget, maxTokens: treeTokenBudget };
		const harness = await createHarness({ workerOrchestrationProfile: profile });
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"root spent tokens","status":"completed"}')]);
			const root = await harness.session.runWorkerDelegationOnce({ instructions: "Spend part of the tree budget." });
			if (!root.record) throw new Error("Expected root worker record.");
			const rootSnapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const rootAttempt = Object.values(rootSnapshot.attempts)[0];
			const rootUsage = [...(rootAttempt?.checkpointIds ?? [])]
				.reverse()
				.map((checkpointId) => rootSnapshot.checkpoints[checkpointId]?.usage)
				.find((usage) => usage !== undefined);
			if (!rootUsage) throw new Error("Expected durable root usage.");

			let childMaxTokens: number | undefined;
			harness.setResponses([
				(_context, options) => {
					childMaxTokens = options?.maxTokens;
					return fauxAssistantMessage('{"summary":"child respected remaining budget","status":"completed"}');
				},
			]);
			const child = await harness.session.runWorkerDelegationOnce({
				instructions: "Use only the remaining root budget.",
				parentAgentId: root.record.laneId,
			});

			expect(child.record?.status).toBe("succeeded");
			expect(childMaxTokens).toBe(treeTokenBudget - budgetedTokens(rootUsage));
		} finally {
			await harness.cleanup();
		}
	});

	it("materializes the requested host shell as executable local capability", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			const command = "printf '%70000sSHELL_CAPABILITY_OK' x";
			let managedOutputPath = "";
			let providerObservedShellMarker = false;
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall(STABLE_SHELL_TOOL_NAME, { command })], {
					stopReason: "toolUse",
				}),
				(context) => {
					const shellResult = context.messages.find(
						(message) => message.role === "toolResult" && message.toolName === STABLE_SHELL_TOOL_NAME,
					);
					const text =
						shellResult?.role === "toolResult"
							? shellResult.content
									.filter((content) => content.type === "text")
									.map((content) => content.text)
									.join("\n")
							: "";
					providerObservedShellMarker = text.includes("SHELL_CAPABILITY_OK");
					managedOutputPath = /Full output: ([^\]\n]+)/.exec(text)?.[1]?.trim() ?? "";
					return fauxAssistantMessage('{"summary":"shell executed","status":"completed"}');
				},
			]);
			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Prove the local shell capability.",
				authority: {
					capabilities: ["process.exec", "workflow.delegate"],
					toolNames: [STABLE_SHELL_TOOL_NAME, "delegate"],
				},
			});
			if (!run.record) throw new Error("Expected shell worker record.");

			expect(run.record.status).toBe("succeeded");
			const transcript = treeControl(harness.session).readWorkerAgentTranscript(run.record.laneId, {
				maxMessages: 64,
			});
			const shellResult = transcript.messages.find(
				(message) => message.role === "toolResult" && message.toolName === STABLE_SHELL_TOOL_NAME,
			);
			expect(shellResult).toBeUndefined();
			expect(transcript.omittedMessages).toBe(1);
			expect(providerObservedShellMarker).toBe(true);
			expect(managedOutputPath).not.toBe("");
			expect(isAbsolute(managedOutputPath)).toBe(true);
			expect(relative(harness.tempDir, managedOutputPath).startsWith("..")).toBe(false);
			expect(existsSync(managedOutputPath)).toBe(true);
		} finally {
			await harness.cleanup();
		}
	});

	it("lets descendants choose freely while immutable parent grants prevent escalation", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"root read grant","status":"completed"}')]);
			const root = await harness.session.runWorkerDelegationOnce({
				instructions: "Establish a read-only root grant.",
				authority: {
					capabilities: ["filesystem.read", "workflow.delegate"],
					toolNames: ["read", "delegate"],
				},
			});
			if (!root.record) throw new Error("Expected root worker record.");

			let childTools: string[] = [];
			harness.setResponses([
				(context) => {
					childTools = context.tools?.map((tool) => tool.name) ?? [];
					return fauxAssistantMessage('{"summary":"child stayed inherited","status":"completed"}');
				},
			]);
			const child = await harness.session.runWorkerDelegationOnce({
				instructions: "Request a shell but remain inside inherited authority.",
				parentAgentId: root.record.laneId,
				authority: {
					capabilities: ["process.exec", "workflow.delegate"],
					toolNames: [STABLE_SHELL_TOOL_NAME, "delegate"],
				},
			});

			expect(child.record?.status).toBe("succeeded");
			expect(childTools).toEqual(["memory", "delegate"]);
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const childAttempt = Object.values(snapshot.attempts).find(
				(attempt) => attempt.dispatch.parentAgentId === root.record?.laneId,
			);
			expect(childAttempt?.grant?.capabilities).toEqual(["workflow.delegate", "memory.query"]);
			expect(childAttempt?.grant?.allowedTools).toEqual(["delegate", "memory"]);
		} finally {
			await harness.cleanup();
		}
	});
});
