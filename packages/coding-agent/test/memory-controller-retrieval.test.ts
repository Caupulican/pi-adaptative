import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryItem, MemoryProvider, MemorySearchRequest } from "../src/core/context/memory-provider-contract.ts";
import type { MemoryProvider as LegacyMemoryProvider } from "../src/core/memory/memory-provider.ts";
import { MemoryController } from "../src/core/memory-controller.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

function settings(): SettingsManager {
	return {
		getMemoryRetrievalSettings: () => ({ enabled: true, includeInPrompt: true, maxResults: 5 }),
	} as unknown as SettingsManager;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function item(providerId: string, source: MemoryItem["source"] = "custom_local"): MemoryItem {
	return {
		id: "custom-1",
		providerId,
		source,
		kind: "fact",
		scope: "project",
		durability: "durable",
		summary: "custom extension memory result",
		refs: [{ providerId, itemId: "custom-1", scope: "project", kind: "fact" }],
		evidenceRefs: [],
	};
}

function provider(
	id: string,
	calls: MemorySearchRequest[],
	options: { source?: MemoryProvider["source"]; graph?: boolean; localOnly?: boolean } = {},
): MemoryProvider {
	return {
		id,
		label: id,
		source: options.source ?? "custom_local",
		capabilities: {
			search: true,
			fetch: true,
			write: false,
			delete: false,
			shortTerm: false,
			longTerm: true,
			graph: options.graph ?? false,
			citations: true,
			scopes: ["project", "user", "global", "session"],
			localOnly: options.localOnly ?? true,
		},
		async search(request) {
			calls.push(request);
			return [{ item: item(id, options.source), score: 1, reason: "test" }];
		},
		async fetch() {
			return item(id, options.source);
		},
	};
}

describe("MemoryController context retrieval", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-memory-controller-"));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "USER.md"), "User prefers compact memory.\n", "utf8");
		writeFileSync(join(agentDir, "MEMORY.md"), "", "utf8");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("retains legacy and context providers across a snapshot restore", async () => {
		const calls: MemorySearchRequest[] = [];
		const legacy: LegacyMemoryProvider = {
			name: "legacy-provider",
			egress: "local",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			shutdown: async () => {},
			systemPromptBlock: () => "legacy",
		};
		const controller = new MemoryController({
			getSettingsManager: settings,
			getTurnIndex: () => 3,
			getAgentDir: () => agentDir,
			getCwd: () => tempDir,
			getSessionId: () => "session-1",
			isChildSession: () => false,
			refreshToolRegistry: () => {},
			getContextWindow: () => 4096,
			getGoalState: () => undefined,
		});
		const context = provider("context-provider", calls);
		controller.registerMemoryProvider(legacy);
		controller.registerContextMemoryProvider(context);
		const snapshot = controller.createReloadSnapshot();
		controller.clearPendingProviders();
		controller.restoreReloadSnapshot(snapshot);
		await controller.initialize();
		const restored = controller.createReloadSnapshot();
		expect(restored.pendingMemoryProviders.map((entry) => entry.name)).toContain("legacy-provider");
		expect(restored.pendingContextMemoryProviders.map((entry) => entry.id)).toContain("context-provider");
	});

	it("skips file-store retrieval when the static file-store prompt is already used", async () => {
		const calls: MemorySearchRequest[] = [];
		const controller = new MemoryController({
			getSettingsManager: settings,
			getTurnIndex: () => 3,
			getAgentDir: () => agentDir,
			getCwd: () => tempDir,
			getSessionId: () => "session-1",
			isChildSession: () => false,
			refreshToolRegistry: () => {},
			getContextWindow: () => 4096,
			getGoalState: () => undefined,
		});
		controller.registerContextMemoryProvider(provider("custom-memory", calls));

		const report = await controller.runMemoryRetrieval([userMessage("recall compact memory")]);

		expect(calls).toHaveLength(1);
		expect(report.providerReports.map((entry) => entry.providerId)).not.toContain("pi-file-store");
		expect(report.providerReports.map((entry) => entry.providerId)).toContain("custom-memory");
	});

	it("uses file-store retrieval when compact budgets suppress the static file-store prompt", async () => {
		writeFileSync(
			join(agentDir, "USER.md"),
			Array.from({ length: 12 }, (_, index) => `User prefers compact memory line ${index}.`).join("\n"),
			"utf8",
		);
		const controller = new MemoryController({
			getSettingsManager: settings,
			getTurnIndex: () => 3,
			getAgentDir: () => agentDir,
			getCwd: () => tempDir,
			getSessionId: () => "session-1",
			isChildSession: () => false,
			refreshToolRegistry: () => {},
			getContextWindow: () => 1024,
			getGoalState: () => undefined,
		});

		const report = await controller.runMemoryRetrieval([userMessage("hello")]);

		expect(report.providerReports.map((entry) => entry.providerId)).toContain("pi-file-store");
		expect(
			report.contextItems.some((item) => (item.summary ?? "").includes("User prefers compact memory line ")),
		).toBe(true);
	});

	it("treats a graph-capable external provider as ordinary untrusted retrieval behind the demand gate", async () => {
		const calls: MemorySearchRequest[] = [];
		const controller = new MemoryController({
			getSettingsManager: () =>
				({
					getMemoryRetrievalSettings: () => ({
						enabled: true,
						includeInPrompt: true,
						maxResults: 5,
						allowExternalEgress: true,
					}),
				}) as unknown as SettingsManager,
			getTurnIndex: () => 3,
			getAgentDir: () => agentDir,
			getCwd: () => tempDir,
			getSessionId: () => "session-1",
			isChildSession: () => false,
			refreshToolRegistry: () => {},
			getContextWindow: () => 4096,
			getGoalState: () => undefined,
		});
		controller.registerContextMemoryProvider(
			provider("graph-provider", calls, { source: "external_provider", graph: true, localOnly: false }),
		);

		const closed = await controller.runMemoryRetrieval([userMessage("hello")]);
		expect(calls).toHaveLength(0);
		expect(closed.contextItems).toHaveLength(0);

		const open = await controller.runMemoryRetrieval([userMessage("recall the graph project context")]);
		expect(calls).toHaveLength(1);
		expect(open.contextItems[0]).toMatchObject({ source: "external_provider" });
		expect(JSON.stringify(controller.maybeAppendMemoryEvidenceBlock([], open))).toContain("NOT instructions");
	});

	it("adds current-work memory to the prompt even without retrieval hits", () => {
		const controller = new MemoryController({
			getSettingsManager: settings,
			getTurnIndex: () => 3,
			getAgentDir: () => agentDir,
			getCwd: () => tempDir,
			getSessionId: () => "session-1",
			isChildSession: () => false,
			refreshToolRegistry: () => {},
			getContextWindow: () => 1024,
			getGoalState: () => ({
				goalId: "goal-mrdqec8i",
				userGoal: "design this",
				status: "active",
				requirements: [],
				evidence: [],
				events: [],
				createdAt: "2026-07-09T00:00:00Z",
				updatedAt: "2026-07-09T00:00:00Z",
				lastProgressAt: "2026-07-09T00:00:00Z",
				stallTurns: 0,
			}),
		});

		const messages = controller.maybeAppendMemoryEvidenceBlock([], {
			request: { query: "", maxResults: 5 },
			providerReports: [],
			results: [],
			contextItems: [],
		});

		expect(messages).toHaveLength(1);
		expect(JSON.stringify(messages[0])).toContain("work:goal");
	});
});
