import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import type { Message } from "@caupulican/pi-ai/types";
import { describe, expect, it } from "vitest";
import { STABLE_SHELL_TOOL_NAME } from "../src/core/default-tool-surface.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { type AgentBindingContract, ORCHESTRATION_SCHEMA_VERSION } from "../src/core/orchestration/contracts.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";
import { createHarness } from "./suite/harness.ts";

const UNAVAILABLE_SHELL_TOOL_NAME = "cmd";

interface AgentTranscriptPage {
	agentId: string;
	cursor: number;
	totalMessages: number;
	messages: Message[];
	nextCursor?: number;
}

interface AgentTreeControl {
	listWorkerAgents(): AgentBindingContract[];
	readWorkerAgentTranscript(agentId: string, options?: { cursor?: number; maxMessages?: number }): AgentTranscriptPage;
}

function treeControl(session: object): AgentTreeControl {
	return (session as { _backgroundLanes: AgentTreeControl })._backgroundLanes;
}

describe("recursive worker orchestration", () => {
	it("rejects subagent start calls with subagent_delegation_disabled under 1-level nesting maximum", async () => {
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
				fauxAssistantMessage('{"summary":"handled disabled subagent delegation","status":"completed"}'),
			]);

			const parent = await harness.session.runWorkerDelegationOnce({
				instructions: "Attempt nested delegation.",
			});

			expect(parent.record?.status).toBe("succeeded");
			const parentTranscript = treeControl(harness.session).readWorkerAgentTranscript("worker-1", {
				maxMessages: 64,
			});
			expect(JSON.stringify(parentTranscript.messages)).toContain("subagent_delegation_disabled");
		} finally {
			await harness.cleanup();
		}
	});

	it("prevents subagents from spawning nested worker agents", async () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "recursive-handoff",
			model: { provider: "faux", id: "faux-1", maxTokens: 100_000 },
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
		});
		const harness = await createHarness({
			workerOrchestrationProfile: profile,
			settings: { workerDelegation: { enabled: true, maxConcurrent: 3 } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("delegate", { instructions: "Attempt child spawn" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage('{"summary":"subagent complete","status":"completed"}'),
			]);

			const parent = await harness.session.runWorkerDelegationOnce({
				instructions: "Delegate worker.",
			});
			expect(parent.record?.status).toBe("succeeded");
			expect(harness.session.getLaneRecords().filter((record) => record.type === "worker")).toHaveLength(1);
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
			expect(control.listWorkerAgents()).toEqual([
				expect.objectContaining({ agentId: run.record.laneId, rootAgentId: run.record.laneId, depth: 0 }),
			]);
			const first = control.readWorkerAgentTranscript(run.record.laneId, { cursor: 0, maxMessages: 1 });
			expect(first).toMatchObject({
				agentId: run.record.laneId,
				cursor: 0,
				totalMessages: 2,
				nextCursor: 1,
			});
			expect(first.messages).toHaveLength(1);
			expect(first.messages[0]).toMatchObject({ role: "user" });
			expect(JSON.stringify(first.messages[0])).toContain("Preserve this exact request.");
			const second = control.readWorkerAgentTranscript(run.record.laneId, {
				cursor: first.nextCursor,
				maxMessages: 1,
			});
			expect(second.messages[0]).toMatchObject({ role: "assistant" });
			expect(JSON.stringify(second.messages[0])).toContain("exact transcript");
			expect(second.nextCursor).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects an exact ancestor task replay without imposing a depth limit", async () => {
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
			expect(seenTools).toEqual(["read", STABLE_SHELL_TOOL_NAME, "delegate"]);
			expect(harness.settingsManager.getWorkerDelegationSettings().maxConcurrent).toBe(128);
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const attempt = Object.values(snapshot.attempts)[0];
			expect(attempt?.dispatch.executionContract?.worker).toMatchObject({
				modelBinding: { provider, modelId: "selected", thinkingLevel: "low" },
				authority: {
					capabilities: ["filesystem.read", "process.exec", "workflow.delegate"],
					toolNames: ["read", STABLE_SHELL_TOOL_NAME, "delegate"],
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
			expect(tools).toEqual([STABLE_SHELL_TOOL_NAME]);
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			expect(Object.values(snapshot.attempts)[0]?.dispatch.executionContract?.worker.authority.toolNames).toEqual([
				STABLE_SHELL_TOOL_NAME,
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
			expect(tools).toEqual([]);
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			expect(Object.values(snapshot.attempts)[0]?.grant?.allowedTools).toEqual([]);
			expect(Object.values(snapshot.attempts)[0]?.grant?.capabilities).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	});

	it("debits descendant provider capacity from one cumulative root token budget", async () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "global-budget",
			model: { provider: "faux", id: "faux-1", maxTokens: 6_000 },
			capabilityCeiling: ["filesystem.read", "workflow.delegate"],
			toolNames: ["read", "delegate"],
		});
		profile.budget = { ...profile.budget, maxTokens: 6_000 };
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
			expect(childMaxTokens).toBe(6_000 - rootUsage.totalTokens);
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
			expect(shellResult).toMatchObject({ role: "toolResult", isError: false });
			expect(JSON.stringify(shellResult?.content)).toContain("SHELL_CAPABILITY_OK");
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
			expect(childTools).toEqual(["delegate"]);
			const snapshot = new WorkerLifecycle({
				agentDir: harness.tempDir,
				sessionId: harness.session.sessionId,
			}).getTaskRuntimeSnapshot();
			const childAttempt = Object.values(snapshot.attempts).find(
				(attempt) => attempt.dispatch.parentAgentId === root.record?.laneId,
			);
			expect(childAttempt?.grant?.capabilities).toEqual(["workflow.delegate"]);
			expect(childAttempt?.grant?.allowedTools).toEqual(["delegate"]);
		} finally {
			await harness.cleanup();
		}
	});
});
