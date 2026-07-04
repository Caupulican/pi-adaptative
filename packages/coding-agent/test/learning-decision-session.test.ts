import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	appendLearningDecisionSnapshot,
	getLearningDecisionSnapshots,
	LEARNING_DECISION_CUSTOM_TYPE,
} from "../src/core/learning/session-learning-decision.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("Phase 9D: Learning Decision Session Persistence", () => {
	it("appendLearningDecisionSnapshot stores a custom entry with LEARNING_DECISION_CUSTOM_TYPE", () => {
		const sessionManager = SessionManager.inMemory();
		const decision = {
			kind: "proposal" as const,
			reasonCode: "test",
			confidence: 100,
			summary: "Test",
			requiresApproval: false,
		};

		const entryId = appendLearningDecisionSnapshot(sessionManager, decision);
		expect(typeof entryId).toBe("string");

		const entries = sessionManager.getEntries();
		expect(entries.length).toBe(1);
		const entry = entries[0];
		expect(entry?.type).toBe("custom");
		if (entry?.type !== "custom") throw new Error("Expected custom entry");
		expect(entry.customType).toBe(LEARNING_DECISION_CUSTOM_TYPE);
	});

	it("getLearningDecisionSnapshots returns all valid snapshots in chronological order", () => {
		const sessionManager = SessionManager.inMemory();
		appendLearningDecisionSnapshot(sessionManager, {
			kind: "proposal" as const,
			reasonCode: "1",
			confidence: 10,
			summary: "First",
			requiresApproval: true,
		});

		appendLearningDecisionSnapshot(sessionManager, {
			kind: "apply" as const,
			reasonCode: "2",
			confidence: 20,
			summary: "Second",
			requiresApproval: false,
		});

		const snapshots = getLearningDecisionSnapshots(sessionManager.getEntries());
		expect(snapshots.length).toBe(2);
		expect(snapshots[0].reasonCode).toBe("1");
		expect(snapshots[1].reasonCode).toBe("2");
	});

	it("malformed learning_decision entries are ignored and do not throw", () => {
		const sessionManager = SessionManager.inMemory();

		sessionManager.appendCustomEntry(LEARNING_DECISION_CUSTOM_TYPE, null);
		sessionManager.appendCustomEntry(LEARNING_DECISION_CUSTOM_TYPE, []);
		sessionManager.appendCustomEntry(LEARNING_DECISION_CUSTOM_TYPE, { version: 1 });
		sessionManager.appendCustomEntry(LEARNING_DECISION_CUSTOM_TYPE, { version: 2, decision: {} });
		sessionManager.appendCustomEntry(LEARNING_DECISION_CUSTOM_TYPE, "malformed");

		const validDecision = {
			kind: "apply" as const,
			reasonCode: "valid",
			confidence: 90,
			summary: "Valid",
			requiresApproval: false,
		};
		appendLearningDecisionSnapshot(sessionManager, validDecision);

		sessionManager.appendCustomEntry(LEARNING_DECISION_CUSTOM_TYPE, {
			version: 1,
			decision: { invalid: true },
		});

		const snapshots = getLearningDecisionSnapshots(sessionManager.getEntries());
		expect(snapshots.length).toBe(1);
		expect(snapshots[0].reasonCode).toBe("valid");
	});

	it("invalid/non-plain decision object is ignored while an older valid decision remains", () => {
		const sessionManager = SessionManager.inMemory();

		const validDecision = {
			kind: "apply" as const,
			reasonCode: "valid",
			confidence: 90,
			summary: "Valid",
			requiresApproval: false,
		};
		appendLearningDecisionSnapshot(sessionManager, validDecision);

		const nonPlainDecision = Object.assign(new Date(0), {
			kind: "proposal",
			reasonCode: "bad_prototype",
			confidence: 99,
			summary: "Invalid non-plain",
			requiresApproval: true,
		});
		sessionManager.appendCustomEntry(LEARNING_DECISION_CUSTOM_TYPE, { version: 1, decision: nonPlainDecision });

		const validDecision2 = {
			kind: "apply" as const,
			reasonCode: "valid-2",
			confidence: 90,
			summary: "Valid 2",
			requiresApproval: false,
		};
		const payload = Object.assign(new Date(0), { version: 1, decision: validDecision2 });
		sessionManager.appendCustomEntry(LEARNING_DECISION_CUSTOM_TYPE, payload);

		const snapshots = getLearningDecisionSnapshots(sessionManager.getEntries());
		expect(snapshots.length).toBe(1);
		expect(snapshots[0].reasonCode).toBe("valid");
	});

	it("non-finite confidence is ignored while an older valid decision remains", () => {
		const sessionManager = SessionManager.inMemory();

		const validDecision = {
			kind: "apply" as const,
			reasonCode: "valid",
			confidence: 90,
			summary: "Valid",
			requiresApproval: false,
		};
		appendLearningDecisionSnapshot(sessionManager, validDecision);

		sessionManager.appendCustomEntry(LEARNING_DECISION_CUSTOM_TYPE, {
			version: 1,
			decision: {
				kind: "proposal",
				reasonCode: "nan_confidence",
				confidence: Number.NaN,
				summary: "NaN confidence",
				requiresApproval: true,
			},
		});

		sessionManager.appendCustomEntry(LEARNING_DECISION_CUSTOM_TYPE, {
			version: 1,
			decision: {
				kind: "proposal",
				reasonCode: "inf_confidence",
				confidence: Infinity,
				summary: "Infinity confidence",
				requiresApproval: true,
			},
		});

		const snapshots = getLearningDecisionSnapshots(sessionManager.getEntries());
		expect(snapshots.length).toBe(1);
		expect(snapshots[0].reasonCode).toBe("valid");
	});

	it("returned snapshots are copies", () => {
		const sessionManager = SessionManager.inMemory();
		const decision = {
			kind: "apply" as const,
			reasonCode: "orig",
			confidence: 90,
			summary: "Orig",
			requiresApproval: false,
		};

		appendLearningDecisionSnapshot(sessionManager, decision);

		const snapshots1 = getLearningDecisionSnapshots(sessionManager.getEntries());
		const snapshot = snapshots1[0];
		snapshot.reasonCode = "mutated";
		snapshot.confidence = 100;

		const snapshots2 = getLearningDecisionSnapshots(sessionManager.getEntries());
		expect(snapshots2[0].reasonCode).toBe("orig");
		expect(snapshots2[0].confidence).toBe(90);
	});

	it("AgentSession accessors save and restore snapshots with an in-memory SessionManager", () => {
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");

		const agent = new Agent({
			getApiKey: () => "test",
			initialState: {
				model,
				systemPrompt: "test",
				tools: [],
				thinkingLevel: "off",
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			resourceLoader: createTestResourceLoader(),
			cwd: process.cwd(),
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		});

		session.saveLearningDecisionSnapshot({
			kind: "proposal",
			reasonCode: "accessor_test",
			confidence: 88,
			summary: "Accessor Test",
			requiresApproval: true,
		});

		const snapshots = session.getLearningDecisionSnapshots();
		expect(snapshots.length).toBe(1);
		expect(snapshots[0].summary).toBe("Accessor Test");
	});
});
