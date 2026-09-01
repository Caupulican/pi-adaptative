import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDeterministicCompaction,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
} from "@caupulican/pi-agent-core/compaction";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	DURABLE_LEARNING_MEMORY_POLICY_VERSION,
	DurableLearningState,
} from "../src/core/learning/durable-learning-state.ts";
import {
	ProviderRequestContextController,
	type ProviderRequestContextControllerDeps,
} from "../src/core/provider-request-context-controller.ts";
import {
	CURRENT_TURN_REFLECTION_CUSTOM_TYPE,
	CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE,
	ReflectionController,
	type ReflectionControllerDeps,
} from "../src/core/reflection-controller.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SkillVaultController } from "../src/core/skill-vault.ts";

const tempDirs: string[] = [];
const originalNativeReflection = process.env.PI_NATIVE_REFLECTION;

afterEach(() => {
	if (originalNativeReflection === undefined) delete process.env.PI_NATIVE_REFLECTION;
	else process.env.PI_NATIVE_REFLECTION = originalNativeReflection;
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function assistantReply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 20,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function appendTurn(sessionManager: SessionManager, text: string, timestamp: number): void {
	sessionManager.appendMessage({ role: "user", content: text, timestamp });
	sessionManager.appendMessage(assistantReply("ok"));
}

function compactSession(sessionManager: SessionManager): string {
	const preparation = prepareCompaction(sessionManager.getBranch(), {
		...DEFAULT_COMPACTION_SETTINGS,
		keepRecentTokens: 1,
	});
	if (!preparation) throw new Error("Expected a compaction preparation");
	const result = createDeterministicCompaction(preparation);
	return sessionManager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details);
}

function createCueController(
	sessionManager: SessionManager,
	settingsManager = SettingsManager.inMemory({ autoLearn: { enabled: true, reflectionReview: true } }),
	options: { agentDir?: string; isChildSession?: boolean; runtimeVersion?: string } = {},
): ReflectionController {
	const durableLearningState = options.agentDir
		? DurableLearningState.forAgentDir(options.agentDir, { leaseMs: 60_000 })
		: undefined;
	return new ReflectionController({
		getSettingsManager: () => settingsManager,
		getSessionManager: () => sessionManager,
		isChildSession: () => options.isChildSession ?? false,
		isDisposed: () => false,
		getDurableLearningState: () => durableLearningState,
		getRuntimeVersion: () => options.runtimeVersion ?? "0.96.5",
		getMemoryPolicyVersion: () => DURABLE_LEARNING_MEMORY_POLICY_VERSION,
		warn: () => undefined,
	} as unknown as ReflectionControllerDeps);
}

function cueMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.filter(
		(message) => message.role === "custom" && message.customType === CURRENT_TURN_REFLECTION_CUSTOM_TYPE,
	);
}

describe("durable current-turn reflection cue state", () => {
	it("merges duplicate evidence and restores the latest pending revision after compaction and reopen", () => {
		const directory = join(tmpdir(), `pi-reflection-cue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(directory);
		mkdirSync(directory, { recursive: true });
		const sessionManager = SessionManager.create(directory, directory);
		appendTurn(sessionManager, "old turn", 1);
		const controller = createCueController(sessionManager);

		expect(controller.queueCurrentTurnCue("corrective")).toBe(true);
		expect(controller.queueCurrentTurnCue("durable")).toBe(true);
		expect(controller.queueCurrentTurnCue("corrective")).toBe(false);
		expect(controller.getCurrentTurnCueState()).toMatchObject({
			status: "pending",
			revision: 2,
			triggers: ["corrective", "durable"],
		});
		appendTurn(sessionManager, "new turn", 2);
		const compactionId = compactSession(sessionManager);
		const branch = sessionManager.getBranch();
		const compaction = branch.find((entry) => entry.id === compactionId);
		const lastCueStateIndex = branch.findLastIndex(
			(entry) => entry.type === "custom" && entry.customType === CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE,
		);
		if (!compaction || compaction.type !== "compaction") throw new Error("Expected compaction entry");
		expect(branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)).toBeGreaterThan(lastCueStateIndex);

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile || !existsSync(sessionFile)) throw new Error("Expected persisted reflection session");
		const reopened = SessionManager.open(sessionFile, directory);
		const resumed = createCueController(reopened);
		expect(resumed.getCurrentTurnCueState()).toMatchObject({
			status: "pending",
			revision: 2,
			triggers: ["corrective", "durable"],
		});
		expect(cueMessages(reopened.buildSessionContext().messages)).toHaveLength(0);

		const preview = resumed.previewCurrentTurnCue();
		expect(preview?.isCurrent()).toBe(true);
		preview?.commit();
		expect(resumed.getCurrentTurnCueState()).toMatchObject({ status: "consumed", revision: 3 });
		const continuation = resumed.previewCurrentTurnCue();
		expect(continuation).toBeDefined();
		continuation?.commit();
		resumed.finishCurrentTurnCue([assistantReply("finished")], { willRetry: false });
		expect(resumed.previewCurrentTurnCue()).toBeUndefined();
	});

	it("rebuilds the previewed cue message byte-identically when nothing about the cue state has changed", () => {
		const sessionManager = SessionManager.inMemory();
		const reflection = createCueController(sessionManager);
		reflection.queueCurrentTurnCue("root-turn");

		// Two independent preview builds of the SAME pending cue, with no commit or other state change
		// between them (as happens across a discarded/retried provider-request plan). The A1 contract:
		// unchanged cue content must serialize to identical bytes, never differing only by a fresh
		// Date.now() read — otherwise the provider's prefix cache is invalidated on every request.
		const first = reflection.previewCurrentTurnCue();
		const second = reflection.previewCurrentTurnCue();
		expect(first?.message).toBeDefined();
		expect(JSON.stringify(second?.message)).toBe(JSON.stringify(first?.message));
	});

	it("keeps discarded replans pending and projects exactly one cue only until the accepted plan commits", async () => {
		const sessionManager = SessionManager.inMemory();
		const reflection = createCueController(sessionManager);
		reflection.queueCurrentTurnCue("root-turn");
		const skillVault = {
			previewSystemPromptSection: () => undefined,
			getContextRevision: () => 0,
			commitSystemPromptSection: () => undefined,
		} as unknown as SkillVaultController;
		const controller = new ProviderRequestContextController({
			transformExtensions: async (messages: AgentMessage[]) => ({ messages, transientMessages: [] }),
			runContextAudit: (_messages: AgentMessage[]) => ({}),
			runPromptPolicyPlanning: (_report: unknown) => ({}),
			runMemoryRetrieval: async (_messages: AgentMessage[]) => ({}),
			applyContextGc: (messages: AgentMessage[], _writePayloads: boolean) => ({ messages, report: {} }),
			correlatePromptPolicyWithContextGc: (_report: unknown) => undefined,
			runPromptEnforcement: (messages: AgentMessage[], _report: unknown) => ({ messages, report: {} }),
			enqueueRelevanceCuration: (_messages: AgentMessage[], _report: unknown) => undefined,
			maybeDrainBrainCuration: () => undefined,
			appendMemoryEvidence: (messages: AgentMessage[], _report: unknown) => messages,
			previewReflectionCue: () => reflection.previewCurrentTurnCue(),
			getGoalState: () => undefined,
			skillVault,
			applyPathAliases: (messages: AgentMessage[]) => ({ messages }),
		} as unknown as ProviderRequestContextControllerDeps);
		const source: AgentMessage[] = [{ role: "user", content: "ordinary", timestamp: 1 }];

		const discarded = await controller.plan(source, 0);
		expect(cueMessages(discarded.transientMessages ?? [])).toHaveLength(1);
		expect(cueMessages(discarded.messages)).toHaveLength(0);
		expect(reflection.getCurrentTurnCueState()).toMatchObject({ status: "pending", revision: 1 });

		const accepted = await controller.plan(source, 0);
		expect(cueMessages(accepted.transientMessages ?? [])).toHaveLength(1);
		expect(accepted.prepareCommit?.()).toBe(true);
		accepted.commit?.();
		expect(reflection.getCurrentTurnCueState()).toMatchObject({ status: "consumed", revision: 2 });
		expect(discarded.isCurrent?.()).toBe(false);

		const continuation = await controller.plan(source, 0);
		expect(cueMessages(continuation.transientMessages ?? [])).toHaveLength(1);
		expect(cueMessages(continuation.messages)).toHaveLength(0);
		expect(continuation.prepareCommit?.()).toBe(true);
		continuation.commit?.();

		reflection.finishCurrentTurnCue([assistantReply("finished")], { willRetry: false });
		const afterTerminal = await controller.plan(source, 0);
		expect(cueMessages(afterTerminal.transientMessages ?? [])).toHaveLength(0);
		expect(cueMessages(afterTerminal.messages)).toHaveLength(0);
	});

	it("dismisses pending evidence under the kill switch and never replays it after re-enable", () => {
		delete process.env.PI_NATIVE_REFLECTION;
		const sessionManager = SessionManager.inMemory();
		const reflection = createCueController(sessionManager);
		reflection.queueCurrentTurnCue("corrective");
		const staleCueId = reflection.getCurrentTurnCueState()?.cueId;

		process.env.PI_NATIVE_REFLECTION = "0";
		expect(reflection.queueCurrentTurnCue("root-turn")).toBe(false);
		expect(reflection.getCurrentTurnCueState()).toMatchObject({
			cueId: staleCueId,
			status: "dismissed",
			revision: 2,
			triggers: ["corrective"],
		});
		expect(reflection.previewCurrentTurnCue()).toBeUndefined();

		delete process.env.PI_NATIVE_REFLECTION;
		expect(reflection.queueCurrentTurnCue("root-turn")).toBe(true);
		const fresh = reflection.previewCurrentTurnCue();
		expect(fresh?.message).toMatchObject({
			details: { triggers: ["root-turn"] },
		});
		expect(reflection.getCurrentTurnCueState()?.cueId).not.toBe(staleCueId);
	});

	it("dismisses a pending cue at the settings transition even when no prompt occurs while disabled", () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory({
			autoLearn: { enabled: true, reflectionReview: true },
		});
		const reflection = createCueController(sessionManager, settingsManager);
		reflection.queueCurrentTurnCue("corrective");
		const staleCueId = reflection.getCurrentTurnCueState()?.cueId;

		settingsManager.setAutoLearnSettings({ enabled: false, reflectionReview: true });
		expect(reflection.getCurrentTurnCueState()).toMatchObject({
			cueId: staleCueId,
			status: "dismissed",
			revision: 2,
		});

		// No queue/preview/provider-planning operation occurs while disabled.
		settingsManager.setAutoLearnSettings({ enabled: true, reflectionReview: true });
		expect(reflection.previewCurrentTurnCue()).toBeUndefined();
		expect(reflection.getCurrentTurnCueState()).toMatchObject({
			cueId: staleCueId,
			status: "dismissed",
			revision: 2,
		});
	});

	it("attaches a provider-hidden version claim and completes only its exact successful cue-bearing run", () => {
		const directory = join(tmpdir(), `pi-version-cue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(directory);
		mkdirSync(directory, { recursive: true });
		const sessionManager = SessionManager.inMemory();
		const reflection = createCueController(
			sessionManager,
			SettingsManager.inMemory({ autoLearn: { enabled: true, reflectionReview: true } }),
			{ agentDir: directory },
		);

		expect(reflection.queueExternalRootTurnCue()).toBe("attached");
		const pending = reflection.getCurrentTurnCueState();
		expect(pending).toMatchObject({
			status: "pending",
			triggers: ["root-turn", "version-change"],
			versionChange: {
				metadata: {
					reason: "first-observation",
					runtimeVersion: "0.96.5",
					memoryPolicyVersion: DURABLE_LEARNING_MEMORY_POLICY_VERSION,
				},
			},
		});
		expect(pending?.versionChange?.token.claimId).toMatch(/^[0-9a-f-]{36}$/);
		const preview = reflection.previewCurrentTurnCue();
		const previewDetails = preview?.message.role === "custom" ? preview.message.details : undefined;
		expect(previewDetails).toMatchObject({
			versionChange: { reason: "first-observation", runtimeVersion: "0.96.5" },
		});
		expect(JSON.stringify(preview?.message)).not.toContain(pending?.versionChange?.token.claimId);
		preview?.commit();
		const continuationMessage = reflection.previewCurrentTurnCue()?.message;
		const continuationDetails = continuationMessage?.role === "custom" ? continuationMessage.details : undefined;
		expect(continuationDetails).toMatchObject({ cueId: pending?.cueId });

		reflection.finishCurrentTurnCue([assistantReply("Reviewed current semantics")], { willRetry: false });
		expect(reflection.previewCurrentTurnCue()).toBeUndefined();
		expect(DurableLearningState.forAgentDir(directory).readSnapshot()).toMatchObject({
			observedRuntimeVersion: "0.96.5",
			currentTransitionId: null,
			resolvedTransitions: 1,
		});
	});

	it("requeues the same claimed cue for retry and releases it on terminal failure", () => {
		const directory = join(tmpdir(), `pi-version-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(directory);
		mkdirSync(directory, { recursive: true });
		const reflection = createCueController(
			SessionManager.inMemory(),
			SettingsManager.inMemory({ autoLearn: { enabled: true, reflectionReview: true } }),
			{ agentDir: directory },
		);
		reflection.queueExternalRootTurnCue();
		const cueId = reflection.getCurrentTurnCueState()?.cueId;
		const claimId = reflection.getCurrentTurnCueState()?.versionChange?.token.claimId;
		reflection.previewCurrentTurnCue()?.commit();

		reflection.finishCurrentTurnCue([assistantReply("retryable failure")], { willRetry: true });
		expect(reflection.getCurrentTurnCueState()).toMatchObject({
			cueId,
			status: "pending",
			versionChange: { token: { claimId } },
		});
		reflection.previewCurrentTurnCue()?.commit();
		const failed = assistantReply("");
		failed.stopReason = "error";
		failed.errorMessage = "provider failed";
		reflection.finishCurrentTurnCue([failed], { willRetry: false });
		expect(DurableLearningState.forAgentDir(directory).readSnapshot()).toMatchObject({
			currentTransitionId: expect.any(String),
			currentClaimOwnerId: null,
			resolvedTransitions: 0,
		});
	});

	it("releases a mid-turn version claim when the kill switch changes and leaves child access at zero footprint", () => {
		const directory = join(tmpdir(), `pi-version-disable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(directory);
		mkdirSync(directory, { recursive: true });
		const settingsManager = SettingsManager.inMemory({ autoLearn: { enabled: true, reflectionReview: true } });
		const reflection = createCueController(SessionManager.inMemory(), settingsManager, { agentDir: directory });
		reflection.queueExternalRootTurnCue();
		reflection.previewCurrentTurnCue()?.commit();
		settingsManager.setAutoLearnSettings({ enabled: false, reflectionReview: true });
		expect(reflection.getCurrentTurnCueState()).toMatchObject({ status: "dismissed" });
		expect(DurableLearningState.forAgentDir(directory).readSnapshot()?.currentClaimOwnerId).toBeNull();

		const childDirectory = join(directory, "child");
		const child = createCueController(
			SessionManager.inMemory(),
			SettingsManager.inMemory({ autoLearn: { enabled: true, reflectionReview: true } }),
			{ agentDir: childDirectory, isChildSession: true },
		);
		expect(child.queueExternalRootTurnCue()).toBe("disabled");
		expect(existsSync(join(childDirectory, "state"))).toBe(false);
	});

	it("strips stale version metadata when another live root owns the transition", () => {
		const directory = join(tmpdir(), `pi-version-busy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(directory);
		mkdirSync(directory, { recursive: true });
		const sessionManager = SessionManager.inMemory();
		const settings = SettingsManager.inMemory({ autoLearn: { enabled: true, reflectionReview: true } });
		const owner = createCueController(sessionManager, settings, { agentDir: directory });
		expect(owner.queueExternalRootTurnCue()).toBe("attached");
		const ownedClaimId = owner.getCurrentTurnCueState()?.versionChange?.token.claimId;

		const competingRoot = createCueController(sessionManager, settings, { agentDir: directory });
		expect(competingRoot.queueExternalRootTurnCue()).toBe("replaced-stale");
		expect(competingRoot.getCurrentTurnCueState()).toMatchObject({
			status: "pending",
			triggers: ["root-turn"],
		});
		expect(competingRoot.getCurrentTurnCueState()?.versionChange).toBeUndefined();
		expect(DurableLearningState.forAgentDir(directory).readSnapshot()?.currentClaimOwnerId).toBe(
			owner.getCurrentTurnCueState()?.versionChange?.token.ownerId,
		);
		expect(JSON.stringify(competingRoot.previewCurrentTurnCue()?.message)).not.toContain(ownedClaimId);
	});

	it("releases the exact active version claim when branch navigation invalidates its cue", () => {
		const directory = join(tmpdir(), `pi-version-branch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(directory);
		mkdirSync(directory, { recursive: true });
		const reflection = createCueController(
			SessionManager.inMemory(),
			SettingsManager.inMemory({ autoLearn: { enabled: true, reflectionReview: true } }),
			{ agentDir: directory },
		);
		reflection.queueExternalRootTurnCue();
		reflection.previewCurrentTurnCue()?.commit();
		reflection.invalidateCurrentTurnCueStateCache({ releaseActiveClaim: true });

		expect(reflection.previewCurrentTurnCue()).toBeUndefined();
		expect(DurableLearningState.forAgentDir(directory).readSnapshot()).toMatchObject({
			currentTransitionId: expect.any(String),
			currentClaimOwnerId: null,
			resolvedTransitions: 0,
		});
	});
});
