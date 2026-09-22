import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { enforceSessionEdgeOperation, type SessionEdgeDeps } from "../src/core/agent-session-edge.ts";
import { EDGE_CLASSES } from "../src/core/autonomy/edge-policy.ts";
import { resolveAutoLearnSettings } from "../src/core/learning/auto-learn-settings.ts";
import { AUTHORITY_CONTEXT_CUSTOM_TYPE } from "../src/core/provider-request-context-controller.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { formatAutonomyStatus } from "../src/modes/interactive/autonomy-commands.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

describe("autonomous default authority", () => {
	it("grants every registered edge by default and retains it across settings reload", async () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getEdgeSettings().allow).toEqual(EDGE_CLASSES);
		settings.getEdgeSettings().allow.length = 0;
		await settings.reload();
		expect(settings.getEdgeSettings().allow).toEqual(EDGE_CLASSES);
	});

	it.each([[], ["git.publish"], ["git.publish", "unknown", "git.publish"]].map((allow: string[]) => ({ allow })))(
		"honors an explicit restricted allowlist $allow",
		({ allow }) => {
			const settings = SettingsManager.inMemory({ edge: { allow } });
			expect(settings.getEdgeSettings().allow).toEqual(allow.includes("git.publish") ? ["git.publish"] : []);
		},
	);

	it("retains project restrictions over the machine grant", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ edge: { allow: EDGE_CLASSES } }));
		storage.withLock("project", () => JSON.stringify({ edge: { allow: [] } }));
		expect(SettingsManager.fromStorage(storage).getEdgeSettings().allow).toEqual([]);
	});

	it.each(
		[null, false, [], "restricted", { allow: null }, { allow: "git.publish" }].map((edge: unknown) => ({ edge })),
	)("does not treat malformed edge configuration $edge as an omitted policy", ({ edge }) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ edge }));
		expect(SettingsManager.fromStorage(storage).getEdgeSettings().allow).toEqual([]);
	});

	it.each(["global", "project", "directoryProfile"] as const)(
		"does not turn unreadable %s policy into a default grant",
		async (scope) => {
			const storage = new InMemorySettingsStorage();
			storage.withLock(scope, () => "{");
			const settings = SettingsManager.fromStorage(storage);
			expect(settings.drainErrors()).toHaveLength(1);
			expect(settings.getEdgeSettings().allow).toEqual([]);
			storage.withLock(scope, () => JSON.stringify({ edge: { allow: ["git.publish"] } }));
			await settings.reload();
			expect(settings.getEdgeSettings().allow).toEqual(["git.publish"]);
		},
	);

	it("retains the execution grant after compaction and session reload", async () => {
		const harness = await createHarness({
			baseToolsOverride: [],
			settings: { edge: {}, modelCapability: { mode: "off" } },
		});
		harness.setResponses([fauxAssistantMessage("Work complete")]);
		await harness.session.prompt("Finish the task autonomously.");
		const grants = harness.session.getEdgeGrants();
		expect(grants.map((grant) => grant.class)).toEqual(EDGE_CLASSES);
		harness.setResponses([fauxAssistantMessage("Task completed; retain the standing grants.")]);
		await harness.session.compact();
		await harness.session.reload();
		expect(harness.session.getEdgeGrants()).toEqual(grants);
	});

	it("keeps diagnostic turns running after a settings load failure and recovers without confirmation", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "settings diagnostic" }],
			details: {},
		}));
		const harness = await createHarness({
			settings: { edge: {} },
			baseToolsOverride: [
				{
					name: "read",
					label: "Read",
					description: "Simulated diagnostic read",
					parameters: Type.Object({ path: Type.String() }),
					execute,
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("Ready")]);
		await harness.session.prompt("Diagnose the harness.");
		const valid = harness.settingsManager.createReloadSnapshot();
		harness.settingsManager.restoreReloadSnapshot({
			...valid,
			projectSettingsLoadError: new Error("malformed settings"),
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "settings.json" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Diagnostic complete"),
		]);
		await harness.session.prompt("Inspect the broken settings.");
		expect(execute).toHaveBeenCalledOnce();
		expect(harness.session.getEdgeGrants()).toEqual([]);
		harness.settingsManager.restoreReloadSnapshot(valid);
		expect(harness.session.getEdgeGrants().map((grant) => grant.class)).toEqual(EDGE_CLASSES);
	});

	it("keeps worker decisions current when an owner explicitly changes the allowlist", async () => {
		const settings = SettingsManager.inMemory();
		const confirmation = vi.fn(async () => "allow-once" as const);
		const deps: SessionEdgeDeps = {
			getBranch: () => [],
			getSettingsAllow: () => settings.getEdgeSettings().allow,
			appendCustomEntry: vi.fn(),
			getCwd: () => "/workspace",
			isChildSession: () => true,
			getConfirmation: () => confirmation,
		};
		for (const allow of [[], ["git.publish"], [], [...EDGE_CLASSES], ["toolkit.script"], []]) {
			settings.applyOverrides({ edge: { allow } });
			for (const edgeClass of EDGE_CLASSES) {
				const result = await enforceSessionEdgeOperation(deps, {
					class: edgeClass,
					operation: "simulated",
					reason: "test",
				});
				expect(result.authorized).toBe(allow.includes(edgeClass));
			}
		}
		expect(confirmation).not.toHaveBeenCalled();
	});

	it.each([false, true])("never asks for granted operations (child=%s)", async (child) => {
		const settings = SettingsManager.inMemory();
		const confirmation = vi.fn(async () => "deny" as const);
		const deps: SessionEdgeDeps = {
			getBranch: () => [],
			getSettingsAllow: () => settings.getEdgeSettings().allow,
			appendCustomEntry: vi.fn(),
			getCwd: () => "/workspace",
			isChildSession: () => child,
			getConfirmation: () => confirmation,
		};
		for (const edgeClass of EDGE_CLASSES) {
			expect(
				await enforceSessionEdgeOperation(deps, {
					class: edgeClass,
					operation: "test operation; no side effects",
					reason: "task prerequisite",
					scopeKey: "test-exact-scope",
				}),
			).toEqual({ authorized: true });
		}
		expect(confirmation).not.toHaveBeenCalled();
		expect(deps.appendCustomEntry).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"uses the same grants in tool execution and model context (restricted=%s)",
		async (restricted) => {
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "simulated operation" }],
				details: {},
			}));
			const bash: AgentTool = {
				name: "bash",
				label: "Bash",
				description: "Simulate execution without launching a process",
				parameters: Type.Object({ command: Type.String() }),
				execute,
			};
			const harness = await createHarness({
				baseToolsOverride: [bash],
				settings: { modelCapability: { mode: "off" }, edge: restricted ? { allow: [] } : {} },
			});
			const confirmation = vi.fn(async () => "deny" as const);
			harness.session.setEdgeConfirmation(confirmation);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "npm publish" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Finished"),
			]);
			await harness.session.prompt("Perform the requested publication.");
			expect(execute).toHaveBeenCalledTimes(restricted ? 0 : 1);
			expect(confirmation).toHaveBeenCalledTimes(restricted ? 1 : 0);
			const authority = harness.session.messages
				.filter((message) => message.role === "custom" && message.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE)
				.map(getMessageText)
				.join("\n");
			if (!restricted) {
				for (const edgeClass of EDGE_CLASSES) expect(authority).toContain(edgeClass);
				expect(authority).toContain("Do not ask for permission again");
			}
		},
	);

	it.each(["off", "full"] as const)(
		"does not inject a competing settings approval rule in autonomy=%s",
		async (mode) => {
			const harness = await createHarness({
				settings: {
					modelCapability: { mode: "off" },
					autonomy: { mode },
					selfModification: { enabled: true, sourcePath: process.cwd() },
				},
			});
			const prompt = harness.session.agent.state.systemPrompt;
			expect(prompt).toContain("standing owner authorization");
			expect(prompt).not.toContain("Ask for explicit approval before changing global settings");
			expect(prompt).not.toContain("Ask before credential disclosure");
			expect(prompt).not.toContain("Explicit approval required: destructive deletion");
			expect(prompt).not.toContain("push/tag/release/publish stays owner-gated");
		},
	);

	it("describes learning separately from execution permission", () => {
		const status = formatAutonomyStatus({
			settingsManager: SettingsManager.inMemory({ autonomy: { mode: "full" } }),
			getEffectiveAutoLearnSettings: () => resolveAutoLearnSettings("full"),
			getPrunedAutoLearnState: () => ({}),
			getAutoLearnTenantKey: () => "test",
			getAutoLearnDataDir: () => "/test/logs",
			getAutoLearnTenantDataDir: () => "/test/logs/tenant",
		});
		expect(status).not.toContain("hard stops still require explicit foreground approval");
		expect(status).toContain("Execution authority: /edge list");
	});
});
