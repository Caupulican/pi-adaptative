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
): ReflectionController {
	return new ReflectionController({
		getSettingsManager: () => settingsManager,
		getSessionManager: () => sessionManager,
		isChildSession: () => false,
		isDisposed: () => false,
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
		expect(resumed.previewCurrentTurnCue()).toBeUndefined();
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
		} as unknown as ProviderRequestContextControllerDeps);
		const source: AgentMessage[] = [{ role: "user", content: "ordinary", timestamp: 1 }];

		const discarded = await controller.plan(source);
		expect(cueMessages(discarded.transientMessages ?? [])).toHaveLength(1);
		expect(cueMessages(discarded.messages)).toHaveLength(0);
		expect(reflection.getCurrentTurnCueState()).toMatchObject({ status: "pending", revision: 1 });

		const accepted = await controller.plan(source);
		expect(cueMessages(accepted.transientMessages ?? [])).toHaveLength(1);
		expect(accepted.prepareCommit?.()).toBe(true);
		accepted.commit?.();
		expect(reflection.getCurrentTurnCueState()).toMatchObject({ status: "consumed", revision: 2 });
		expect(discarded.isCurrent?.()).toBe(false);

		const afterCommit = await controller.plan(source);
		expect(cueMessages(afterCommit.transientMessages ?? [])).toHaveLength(0);
		expect(cueMessages(afterCommit.messages)).toHaveLength(0);
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
});
