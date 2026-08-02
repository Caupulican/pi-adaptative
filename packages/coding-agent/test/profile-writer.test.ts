import { SessionManager } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { OrchestrationProfile } from "../src/core/orchestration/contracts.ts";
import {
	MAX_SESSION_TASK_PROFILES,
	SESSION_TASK_PROFILE_CUSTOM_TYPE,
	SessionTaskProfileStore,
} from "../src/core/orchestration/session-task-profile-store.ts";
import type { ProfileWriterToolDetails } from "../src/core/tools/profile-writer.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";
import { createHarness } from "./suite/harness.ts";

const WORKER_RESULT =
	'{"summary":"The scoped task completed.","status":"completed","findings":[{"summary":"The requested scope was preserved","confidence":0.9}]}';

function workerProfile(profileId: string, modelId: string): OrchestrationProfile {
	return createTestWorkerOrchestrationProfile({
		profileId,
		model: { provider: "faux", id: modelId, maxTokens: 8_192 },
		capabilityCeiling: ["filesystem.read", "filesystem.write"],
		toolNames: ["read", "grep", "write"],
	});
}

function taskProfile(profileId: string): OrchestrationProfile {
	const base = workerProfile("base-profile", "base-worker");
	return {
		...base,
		profileId,
		description: `Task-scoped ${profileId}`,
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "faux", modelId: "fast-worker", thinkingLevel: "low" }],
		},
		toolNames: ["read"],
		budget: { ...base.budget, maxTokens: 1_024, maxToolCalls: 2 },
	};
}

describe("profile_writer", () => {
	it("creates one immutable session profile and dispatches the selected fast model with only requested tools", async () => {
		const base = workerProfile("base-profile", "base-worker");
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "base-worker", contextWindow: 128_000 },
				{ id: "fast-worker", contextWindow: 128_000, reasoning: true },
			],
			workerOrchestrationProfile: base,
		});
		try {
			const tool = harness.session.getToolDefinition("profile_writer");
			expect(tool).toBeDefined();
			if (!tool) return;

			const created = await tool.execute(
				"profile-call-1",
				{
					action: "create",
					task: "Search the owned source and implement the smallest verified fix.",
					baseProfileId: base.profileId,
					model: { provider: "faux", modelId: "fast-worker", thinkingLevel: "low" },
					toolNames: ["read", "grep"],
					resourceProfileNames: [],
					budget: { maxTokens: 1_024, maxToolCalls: 2 },
				},
				undefined,
				undefined,
				undefined as never,
			);
			const details = created.details as ProfileWriterToolDetails;
			expect(details).toMatchObject({ created: true, baseProfileId: base.profileId });
			expect(details.profileId).toMatch(/^task-/);
			expect(details.changedFields).toEqual(["description", "model", "tools", "budget"]);
			const persisted = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === SESSION_TASK_PROFILE_CUSTOM_TYPE);
			expect(persisted).toHaveLength(1);

			let selectedModel = "";
			let selectedTools: string[] = [];
			harness.setResponses([
				(context, _options, _state, model) => {
					selectedModel = model.id;
					selectedTools = context.tools?.map((candidate) => candidate.name) ?? [];
					return fauxAssistantMessage(WORKER_RESULT);
				},
			]);
			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Perform the bounded task.",
				profileId: details.profileId,
			});

			expect(run.started).toBe(true);
			expect(selectedModel).toBe("fast-worker");
			expect(selectedTools.sort()).toEqual(["grep", "read"]);
			expect(run.record?.profileId).toBe(details.profileId);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects authority, resource, model, and budget expansion before persistence", async () => {
		const base = workerProfile("bounded-base", "base-worker");
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "base-worker", contextWindow: 128_000 },
				{ id: "fast-worker", contextWindow: 128_000, reasoning: true },
			],
			workerOrchestrationProfile: base,
		});
		try {
			const tool = harness.session.getToolDefinition("profile_writer");
			expect(tool).toBeDefined();
			if (!tool) return;
			const invalidInputs = [
				{ task: "Escalate tools", baseProfileId: base.profileId, toolNames: ["read", "edit"] },
				{
					task: "Escalate resources",
					baseProfileId: base.profileId,
					resourceProfileNames: ["unapproved-resource"],
				},
				{
					task: "Use an unavailable model",
					baseProfileId: base.profileId,
					model: { provider: "faux", modelId: "missing-model", thinkingLevel: "off" },
				},
				{
					task: "Use unsupported thinking",
					baseProfileId: base.profileId,
					model: { provider: "faux", modelId: "base-worker", thinkingLevel: "ultra" },
				},
				{ task: "Expand budget", baseProfileId: base.profileId, budget: { maxTokens: 16_384 } },
			] as const;

			for (const [index, input] of invalidInputs.entries()) {
				const result = await tool.execute(
					`invalid-profile-${index}`,
					{ action: "create", ...input },
					undefined,
					undefined,
					undefined as never,
				);
				expect(result.details).toMatchObject({ created: false });
			}
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === SESSION_TASK_PROFILE_CUSTOM_TYPE),
			).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});

	it("lets an active orchestrator derive only from its owner allowlist", async () => {
		const allowed = workerProfile("allowed-base", "base-worker");
		const denied = workerProfile("denied-base", "base-worker");
		const now = new Date().toISOString();
		const architect: OrchestrationProfile = {
			...createTestWorkerOrchestrationProfile({
				profileId: "architect",
				model: { provider: "faux", id: "foreground", maxTokens: 8_192 },
				role: "orchestrator",
				capabilityCeiling: ["workflow.delegate"],
				toolNames: ["delegate", "delegate_status", "profile_writer"],
			}),
			dispatchProfileIds: [allowed.profileId],
			createdAt: now,
			updatedAt: now,
		};
		const harness = await createHarness({
			models: [
				{ id: "foreground", contextWindow: 128_000 },
				{ id: "base-worker", contextWindow: 128_000 },
			],
			workerOrchestrationProfile: allowed,
			additionalOrchestrationProfiles: [denied],
			orchestrationProfile: architect,
		});
		try {
			const tool = harness.session.getToolDefinition("profile_writer");
			expect(tool).toBeDefined();
			if (!tool) return;
			const rejected = await tool.execute(
				"profile-denied",
				{ action: "create", task: "Attempt forbidden base", baseProfileId: denied.profileId },
				undefined,
				undefined,
				undefined as never,
			);
			expect(rejected.details).toMatchObject({
				created: false,
				reason: "task_profile_base_not_authorized",
			});

			const accepted = await tool.execute(
				"profile-allowed",
				{ action: "create", task: "Use the allowed base", baseProfileId: allowed.profileId },
				undefined,
				undefined,
				undefined as never,
			);
			expect(accepted.details).toMatchObject({ created: true, baseProfileId: allowed.profileId });
		} finally {
			harness.cleanup();
		}
	});
});

describe("session task profile store", () => {
	it("degrades reads explicitly and blocks writes when branch storage is unavailable", () => {
		const partialSessionManager = {
			appendCustomEntry: () => "entry-1",
		} as unknown as SessionManager;
		const store = new SessionTaskProfileStore(partialSessionManager);

		expect(store.load()).toEqual({
			records: [],
			registry: new Map(),
			diagnostics: ["session task profiles require branch-aware session storage"],
		});
		expect(() => store.append({ baseProfileId: "base-profile", profile: taskProfile("task-blocked") })).toThrow(
			"session task profiles require branch-aware session storage",
		);
	});

	it("rehydrates immutable profiles on the active branch and excludes abandoned branches", () => {
		const sessionManager = SessionManager.inMemory();
		const branchPoint = sessionManager.appendCustomEntry("branch-point", { ok: true });
		const store = new SessionTaskProfileStore(sessionManager);
		store.append({ baseProfileId: "base-profile", profile: taskProfile("task-persisted") });
		sessionManager.appendCustomEntry("after-profile", { ok: true });

		expect(
			new SessionTaskProfileStore(sessionManager).load().records.map((record) => record.profile.profileId),
		).toEqual(["task-persisted"]);
		sessionManager.branch(branchPoint);
		expect(new SessionTaskProfileStore(sessionManager).load().records).toEqual([]);
	});

	it("enforces a fixed per-session bound without rewriting prior profiles", () => {
		const sessionManager = SessionManager.inMemory();
		const store = new SessionTaskProfileStore(sessionManager);
		for (let index = 0; index < MAX_SESSION_TASK_PROFILES; index++) {
			store.append({ baseProfileId: "base-profile", profile: taskProfile(`task-${index}`) });
		}

		expect(() => store.append({ baseProfileId: "base-profile", profile: taskProfile("task-overflow") })).toThrow(
			`session task profile limit (${MAX_SESSION_TASK_PROFILES})`,
		);
		expect(store.load().records).toHaveLength(MAX_SESSION_TASK_PROFILES);
	});
});
