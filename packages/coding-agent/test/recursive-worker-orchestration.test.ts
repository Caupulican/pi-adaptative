import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import type { AssistantMessage, Message } from "@caupulican/pi-ai/types";
import { describe, expect, it, vi } from "vitest";
import { workerConversationSessionsDir } from "../src/core/agent-paths.ts";
import { STABLE_SHELL_TOOL_NAME } from "../src/core/default-tool-surface.ts";
import type { WorkerAgentView } from "../src/core/delegation/worker-agent-control.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { DEFAULT_WORKER_FLEET_LIMITS } from "../src/core/delegation/worker-fleet-limits.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { DEFAULT_LANE_MAX_OUTPUT_TOKENS } from "../src/core/model-capability.ts";
import { ORCHESTRATION_SCHEMA_VERSION } from "../src/core/orchestration/contracts.ts";
import { loadedSuiteTimeout } from "./loaded-suite-timeout.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./suite/test-resources.ts";

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
	startWorkerDelegation(
		request: WorkerDelegationRequest,
	): { started: false; skipReason: string } | { started: true; record: { laneId: string } };
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

describe("leaf worker orchestration", () => {
	it("strips delegate from a worker even when a legacy profile requests it", async () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "legacy-recursive-profile",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
		});
		const harness = await createHarness({ workerOrchestrationProfile: profile });
		try {
			harness.setResponses([
				(context) => {
					expect(context.tools?.map((tool) => tool.name)).toEqual(["read"]);
					return fauxAssistantMessage('{"summary":"leaf completed","status":"completed"}');
				},
			]);

			const worker = await harness.session.runWorkerDelegationOnce({
				instructions: "Work independently without spawning descendants.",
			});

			expect(worker.record?.status).toBe("succeeded");
			expect(treeControl(harness.session).listWorkerAgents()).toEqual([
				expect.objectContaining({ agentId: "worker-1", rootAgentId: "worker-1", depth: 0 }),
			]);
			const attempt = Object.values(
				new WorkerLifecycle({
					agentDir: harness.tempDir,
					sessionId: harness.session.sessionId,
				}).getTaskRuntimeSnapshot().attempts,
			)[0];
			expect(attempt?.grant?.allowedTools).not.toContain("delegate");
			expect(attempt?.grant?.capabilities).not.toContain("workflow.delegate");
			expect(attempt?.dispatch.executionContract?.worker.profile.delegationLimits).toEqual({
				maxDepth: 0,
				maxChildrenPerAgent: 0,
				maxNestedAgentsPerSession: 0,
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects a child before creating task or conversation state", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"root ready","status":"completed"}')]);
			const root = await harness.session.runWorkerDelegationOnce({ instructions: "Create one leaf worker." });
			if (!root.record) throw new Error("Expected root worker record.");
			const lifecycle = new WorkerLifecycle({ agentDir: harness.tempDir, sessionId: harness.session.sessionId });
			const before = durableEntityCounts(lifecycle);
			const beforeConversations = conversationEntries(harness.tempDir, harness.session.sessionId);
			harness.setResponses([fauxAssistantMessage('{"summary":"must not execute","status":"completed"}')]);

			const rejected = await harness.session.runWorkerDelegationOnce({
				instructions: "Attempt a forbidden descendant.",
				parentAgentId: root.record.laneId,
			});

			expect(rejected).toEqual({ started: false, skipReason: "worker_leaf_delegation_forbidden" });
			expect(durableEntityCounts(lifecycle)).toEqual(before);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			expect(harness.getPendingResponseCount()).toBe(1);
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

	it("lets the owning root list top-level workers without exposing private resume paths", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage('{"summary":"first peer ready","status":"completed"}'),
				fauxAssistantMessage('{"summary":"second peer ready","status":"completed"}'),
			]);
			const first = await harness.session.runWorkerDelegationOnce({ instructions: "Become the first peer." });
			if (!first.record) throw new Error("Expected first worker record.");

			const second = await harness.session.runWorkerDelegationOnce({ instructions: "Discover the first peer." });
			if (!second.record) throw new Error("Expected second worker record.");

			const serialized = JSON.stringify(treeControl(harness.session).listWorkerAgents());
			expect(serialized).toContain(first.record.laneId);
			expect(serialized).toContain(second.record.laneId);
			expect(serialized).not.toContain("resumeContext");
			expect(serialized).not.toContain("sessionFile");
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects an exact ancestor task replay at the leaf depth gate", async () => {
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

			expect(replay).toEqual({ started: false, skipReason: "worker_leaf_delegation_forbidden" });
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

			expect(rejected).toEqual({ started: false, skipReason: "worker_leaf_delegation_forbidden" });
			expect(durableEntityCounts(lifecycle)).toEqual(before);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps workers leaf-only even when a legacy profile authors recursive limits", async () => {
		const profile = Object.assign(
			createTestWorkerOrchestrationProfile({
				profileId: "legacy-authored-recursion",
				model: { provider: "faux", id: "faux-1" },
				capabilityCeiling: ["filesystem.read", "workflow.delegate"],
				toolNames: ["read", "delegate"],
			}),
			{ delegationLimits: { maxDepth: 8, maxChildrenPerAgent: 8, maxNestedAgentsPerSession: 8 } },
		);
		const harness = await createHarness({ workerOrchestrationProfile: profile });
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"legacy root ready","status":"completed"}')]);
			const root = await harness.session.runWorkerDelegationOnce({
				instructions: "Create the authored-limit root.",
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
				instructions: "Attempt a descendant despite authored recursive limits.",
				parentAgentId: root.record.laneId,
			});

			expect(rejected).toEqual({ started: false, skipReason: "worker_leaf_delegation_forbidden" });
			expect(durableEntityCounts(lifecycle)).toEqual(before);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			expect(harness.getPendingResponseCount()).toBe(1);
			const attempt = lifecycle.getLatestAgentAttempt(root.record.laneId);
			expect(attempt?.dispatch.executionContract?.worker.profile.delegationLimits).toEqual({
				maxDepth: 0,
				maxChildrenPerAgent: 0,
				maxNestedAgentsPerSession: 0,
			});
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
		loadedSuiteTimeout(5000) + 10_000,
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

	it("rejects a descendant preset before it can introduce resources or soul", async () => {
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

			expect(rejected).toEqual({ started: false, skipReason: "worker_leaf_delegation_forbidden" });
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

	it("rejects a descendant before its required verifier can introduce context", async () => {
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

			expect(rejected).toEqual({ started: false, skipReason: "worker_leaf_delegation_forbidden" });
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
			toolNames: ["delegate"],
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
			expect(run.record?.profileId).toMatch(/^adaptive-/);
			expect(run.record?.profileId).not.toBe(alternate.profileId);
		} finally {
			await harness.cleanup();
		}
	});

	it("compiles lightweight model, thinking, tool, and path overrides into a durable host grant", async () => {
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
				instructions: "Exercise the lightweight worker override contract.",
				authority: {
					model: { provider, modelId: "selected" },
					thinkingLevel: "low",
					toolNames: ["read", STABLE_SHELL_TOOL_NAME],
					path: harness.tempDir,
				},
			});

			if (!run.started) throw new Error(`Expected selected model admission, got ${run.skipReason}.`);
			expect(run.record?.status).toBe("succeeded");
			expect(seenModel).toBe("selected");
			expect(seenReasoning).toBe("low");
			expect(seenTools).toEqual(["read", STABLE_SHELL_TOOL_NAME]);
			expect(harness.settingsManager.getWorkerDelegationSettings().maxConcurrent).toBe(128);
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const attempt = Object.values(snapshot.attempts)[0];
			expect(attempt?.dispatch.executionContract?.worker).toMatchObject({
				modelBinding: { provider, modelId: "selected", thinkingLevel: "low" },
				authority: {
					capabilities: ["filesystem.read", "process.exec"],
					toolNames: ["read", "bash"],
					cwd: harness.tempDir,
					readPaths: [harness.tempDir],
					writePaths: [],
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
					toolNames: ["powershell"],
				},
			});

			expect(run.record?.status).toBe("succeeded");
			expect(tools).toEqual([STABLE_SHELL_TOOL_NAME]);
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			expect(Object.values(snapshot.attempts)[0]?.dispatch.executionContract?.worker.authority.toolNames).toEqual([
				"bash",
			]);
		} finally {
			await harness.cleanup();
		}
	});

	it("inherits the compatible active foreground surface when neither a profile nor authority override is supplied", async () => {
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
			expect(tools).toEqual([
				"read",
				"write",
				"edit",
				"python",
				STABLE_SHELL_TOOL_NAME,
				"artifact_retrieve",
				"run_toolkit_script",
				"skill",
				"skill_audit",
			]);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps an inherited profile-free worker leaf-only", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"leaf complete","status":"completed"}')]);

			const root = await harness.session.runWorkerDelegationOnce({
				instructions: "Exercise inherited leaf orchestration.",
			});
			if (!root.record) throw new Error("Expected root worker record.");
			expect(root.record.status).toBe("succeeded");
			const lifecycle = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			const beforeCounts = durableEntityCounts(lifecycle);
			const beforeConversations = conversationEntries(harness.tempDir, harness.session.sessionId);
			const child = await harness.session.runWorkerDelegationOnce({
				instructions: "Attempt one inherited descendant.",
				parentAgentId: root.record.laneId,
			});

			expect(child).toEqual({ started: false, skipReason: "worker_leaf_delegation_forbidden" });
			expect(durableEntityCounts(lifecycle)).toEqual(beforeCounts);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			expect(treeControl(harness.session).listWorkerAgents()).toEqual([
				expect.objectContaining({ agentId: "worker-1", depth: 0 }),
			]);
		} finally {
			await harness.cleanup();
		}
	});

	it("admits independent top-level leaves while rejecting descendants under each", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage('{"summary":"first root ready","status":"completed"}'),
				fauxAssistantMessage('{"summary":"second root ready","status":"completed"}'),
				fauxAssistantMessage('{"summary":"must not execute","status":"completed"}'),
			]);
			const firstRoot = await harness.session.runWorkerDelegationOnce({ instructions: "Create first root." });
			if (!firstRoot.record) throw new Error("Expected first root worker.");
			const secondRoot = await harness.session.runWorkerDelegationOnce({ instructions: "Create second root." });
			if (!secondRoot.record) throw new Error("Expected second root worker.");
			const lifecycle = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			});
			const before = durableEntityCounts(lifecycle);
			const beforeConversations = conversationEntries(harness.tempDir, harness.session.sessionId);

			const rejected = await harness.session.runWorkerDelegationOnce({
				instructions: "Attempt a descendant under the second root.",
				parentAgentId: secondRoot.record.laneId,
			});

			expect(rejected).toEqual({
				started: false,
				skipReason: "worker_leaf_delegation_forbidden",
			});
			expect(durableEntityCounts(lifecycle)).toEqual(before);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			expect(treeControl(harness.session).listWorkerAgents()).toEqual([
				expect.objectContaining({ agentId: firstRoot.record.laneId, depth: 0 }),
				expect.objectContaining({ agentId: secondRoot.record.laneId, depth: 0 }),
			]);
		} finally {
			await harness.cleanup();
		}
	});

	it("overrides explicitly authored recursive depth and fan-out with a hard leaf contract", async () => {
		const profile = Object.assign(
			createTestWorkerOrchestrationProfile({
				profileId: "explicit-recursion",
				model: { provider: "faux", id: "faux-1" },
				capabilityCeiling: ["filesystem.read", "workflow.delegate"],
				toolNames: ["read", "delegate"],
			}),
			{ delegationLimits: { maxDepth: 2, maxChildrenPerAgent: 2, maxNestedAgentsPerSession: 3 } },
		);
		const harness = await createHarness({
			workerOrchestrationProfile: profile,
			settings: { workerDelegation: { maxConcurrent: 4 } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage('{"summary":"explicit root complete","status":"completed"}'),
				fauxAssistantMessage('{"summary":"must not execute","status":"completed"}'),
			]);
			const control = treeControl(harness.session);
			const root = control.startWorkerDelegation({ instructions: "Create the explicit root." });
			if (!root.started) throw new Error(`Explicit root rejected: ${root.skipReason}`);
			const child = control.startWorkerDelegation({
				instructions: "Attempt an explicitly configured child.",
				parentAgentId: root.record.laneId,
				forkTurns: "none",
			});
			expect(child).toEqual({ started: false, skipReason: "worker_leaf_delegation_forbidden" });
			expect(control.listWorkerAgents()).toEqual([
				expect.objectContaining({ agentId: root.record.laneId, depth: 0 }),
			]);
		} finally {
			await harness.cleanup();
		}
	});

	it("prevents a leaf from selecting a broader profile to gain descendants", async () => {
		const broadProfile = Object.assign(
			createTestWorkerOrchestrationProfile({
				profileId: "broad-descendant",
				model: { provider: "faux", id: "faux-1" },
				capabilityCeiling: ["filesystem.read", "workflow.delegate"],
				toolNames: ["read", "delegate"],
			}),
			{ delegationLimits: { maxDepth: 8, maxChildrenPerAgent: 8, maxNestedAgentsPerSession: 8 } },
		);
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
			additionalOrchestrationProfiles: [broadProfile],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage('{"summary":"lean root ready","status":"completed"}'),
				fauxAssistantMessage('{"summary":"must not execute","status":"completed"}'),
			]);
			const root = await harness.session.runWorkerDelegationOnce({ instructions: "Create the lean root." });
			if (!root.record) throw new Error("Expected lean root worker record.");
			const rejected = await harness.session.runWorkerDelegationOnce({
				instructions: "Select the broad routing preset.",
				parentAgentId: root.record.laneId,
				profileId: broadProfile.profileId,
			});

			expect(rejected).toEqual({ started: false, skipReason: "worker_leaf_delegation_forbidden" });
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const rootAttempt = Object.values(snapshot.attempts)[0];
			expect(rootAttempt?.dispatch.executionContract?.worker.profile).toMatchObject({
				delegationLimits: { maxDepth: 0, maxChildrenPerAgent: 0, maxNestedAgentsPerSession: 0 },
			});
			expect(treeControl(harness.session).listWorkerAgents()).toHaveLength(1);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	it("honors an explicitly narrowed leaf tool surface even when inherited adapters are active", async () => {
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
				authority: { toolNames: ["read"] },
			});

			expect(run.record?.status).toBe("succeeded");
			expect(tools).toEqual(["read"]);
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			expect(Object.values(snapshot.attempts)[0]?.grant?.allowedTools).toEqual(["read"]);
			expect(Object.values(snapshot.attempts)[0]?.grant?.capabilities).toEqual(["filesystem.read"]);
			expect(
				Object.values(snapshot.attempts)[0]?.dispatch.executionContract?.worker.profile.delegationLimits,
			).toEqual({
				maxDepth: 0,
				maxChildrenPerAgent: 0,
				maxNestedAgentsPerSession: 0,
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("gives independent top-level leaves the configured provider token ceiling", async () => {
		const workerTokenBudget = 8_000;
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "independent-leaf-budget",
			model: { provider: "faux", id: "faux-1", maxTokens: workerTokenBudget },
			capabilityCeiling: ["filesystem.read"],
			toolNames: ["read"],
		});
		profile.budget = { ...profile.budget, maxTokens: workerTokenBudget };
		const harness = await createHarness({ workerOrchestrationProfile: profile });
		try {
			const requestCaps: Array<number | undefined> = [];
			harness.setResponses([
				(_context, options) => {
					requestCaps.push(options?.maxTokens);
					return fauxAssistantMessage('{"summary":"first leaf complete","status":"completed"}');
				},
				(_context, options) => {
					requestCaps.push(options?.maxTokens);
					return fauxAssistantMessage('{"summary":"second leaf complete","status":"completed"}');
				},
			]);
			const first = await harness.session.runWorkerDelegationOnce({ instructions: "Run the first leaf." });
			const second = await harness.session.runWorkerDelegationOnce({ instructions: "Run the second leaf." });

			expect(first.record?.status).toBe("succeeded");
			expect(second.record?.status).toBe("succeeded");
			expect(requestCaps).toEqual([DEFAULT_LANE_MAX_OUTPUT_TOKENS, DEFAULT_LANE_MAX_OUTPUT_TOKENS]);
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
					toolNames: [STABLE_SHELL_TOOL_NAME],
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

	it("rejects an explicit delegate tool override instead of silently ignoring it", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"must not execute","status":"completed"}')]);
			const lifecycle = new WorkerLifecycle({ agentDir: harness.tempDir, sessionId: harness.session.sessionId });
			const before = durableEntityCounts(lifecycle);
			const beforeConversations = conversationEntries(harness.tempDir, harness.session.sessionId);

			const rejected = await harness.session.runWorkerDelegationOnce({
				instructions: "Try to retain descendant spawning.",
				authority: {
					toolNames: ["read", "delegate"],
				},
			});

			expect(rejected).toEqual({ started: false, skipReason: "orchestration_tool_unavailable:delegate" });
			expect(durableEntityCounts(lifecycle)).toEqual(before);
			expect(conversationEntries(harness.tempDir, harness.session.sessionId)).toEqual(beforeConversations);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});
});
