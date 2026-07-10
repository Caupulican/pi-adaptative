import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	MemoryProvider as ContextMemoryProvider,
	MemoryItem,
	MemorySearchRequest,
} from "../src/core/context/memory-provider-contract.ts";
import type { MemoryProvider, MemoryProviderEgress } from "../src/core/memory/memory-provider.ts";
import { MemoryController } from "../src/core/memory-controller.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

type ResolvedMemorySettings = ReturnType<SettingsManager["getMemoryRetrievalSettings"]>;

function legacyProvider(
	name: string,
	egress?: MemoryProviderEgress,
): {
	provider: MemoryProvider;
	prefetch: ReturnType<typeof vi.fn<(query: string) => Promise<string>>>;
} {
	const prefetch = vi.fn(async (query: string) => `<memory_context>${query}</memory_context>`);
	return {
		provider: {
			name,
			...(egress === undefined ? {} : { egress }),
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			shutdown: async () => {},
			prefetch,
		},
		prefetch,
	};
}

function contextItem(providerId: string): MemoryItem {
	return {
		id: "external-1",
		providerId,
		source: "external_provider",
		kind: "fact",
		scope: "project",
		durability: "durable",
		summary: "external memory result",
		refs: [{ providerId, itemId: "external-1", scope: "project", kind: "fact" }],
		evidenceRefs: [],
	};
}

function externalContextProvider(calls: MemorySearchRequest[]): ContextMemoryProvider {
	return {
		id: "external-context",
		label: "External context",
		source: "external_provider",
		capabilities: {
			search: true,
			fetch: true,
			write: false,
			delete: false,
			shortTerm: false,
			longTerm: true,
			graph: false,
			citations: true,
			scopes: ["project"],
			localOnly: false,
		},
		async search(request) {
			calls.push(request);
			return [{ item: contextItem("external-context"), score: 1, reason: "test" }];
		},
		async fetch() {
			return contextItem("external-context");
		},
	};
}

describe("memory retrieval egress policy", () => {
	const controllers: MemoryController[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const controller of controllers.splice(0)) {
			await controller.getMemoryManager().shutdownAll();
		}
		for (const tempDir of tempDirs.splice(0)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createController(settings: ResolvedMemorySettings): Promise<MemoryController> {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-memory-egress-"));
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		tempDirs.push(tempDir);
		const settingsManager = {
			getMemoryRetrievalSettings: () => settings,
		} as unknown as SettingsManager;
		const controller = new MemoryController({
			getSettingsManager: () => settingsManager,
			getTurnIndex: () => 1,
			getAgentDir: () => agentDir,
			getCwd: () => tempDir,
			getSessionId: () => "session-1",
			isChildSession: () => false,
			refreshToolRegistry: () => {},
			getContextWindow: () => 4096,
			getGoalState: () => undefined,
		});
		controllers.push(controller);
		return controller;
	}

	it("hard-disables legacy prefetch when memory retrieval is disabled", async () => {
		const controller = await createController({
			enabled: false,
			maxResults: 5,
			includeInPrompt: true,
			allowExternalEgress: true,
		});
		const legacy = legacyProvider("local-extension", "local");
		controller.registerMemoryProvider(legacy.provider);
		await controller.initialize();

		const query = "where is the deployment plan stored";
		expect(controller.shouldAttemptRecall(query)).toBe(false);
		expect(await controller.prefetchRecall(query)).toBe("");
		expect(legacy.prefetch).not.toHaveBeenCalled();
	});

	it("treats an opaque legacy extension provider as external and denies raw prompt egress", async () => {
		const controller = await createController({
			enabled: true,
			maxResults: 5,
			includeInPrompt: true,
			allowExternalEgress: false,
		});
		const legacy = legacyProvider("opaque-extension");
		controller.registerMemoryProvider(legacy.provider);
		await controller.initialize();

		await controller.prefetchRecall("where is the deployment plan stored");

		expect(legacy.prefetch).not.toHaveBeenCalled();
	});

	it("safe-auto queries an explicitly local legacy provider", async () => {
		const controller = await createController({
			enabled: true,
			maxResults: 5,
			includeInPrompt: true,
			allowExternalEgress: false,
		});
		const legacy = legacyProvider("local-extension", "local");
		controller.registerMemoryProvider(legacy.provider);
		await controller.initialize();
		const query = "where is the deployment plan stored";

		const recall = await controller.prefetchRecall(query);
		expect(recall).toContain(query);
		expect(recall).toContain('source="memory:local-extension"');
		expect(recall.match(/<untrusted_content\b/g)).toHaveLength(1);
		expect(legacy.prefetch).toHaveBeenCalledWith(query);
	});

	it.each([
		"recall Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
		"recall sk-proj-abcdefghijklmnopqrstuvwxyz",
		"recall sk-ant-abcdefghijklmnopqrstuvwxyz",
		"recall ghp_abcdefghijklmnopqrstuvwxyz123456",
		"recall https://store.example/file?X-Amz-Signature=abcdef1234567890",
		"recall client_secret=abcdefghijklmnopqrstuvwxyz",
	])("blocks common secret-bearing external query form: %s", async (query) => {
		const controller = await createController({
			enabled: true,
			maxResults: 5,
			includeInPrompt: true,
			allowExternalEgress: true,
		});
		const legacy = legacyProvider("external-extension", "external");
		const contextCalls: MemorySearchRequest[] = [];
		controller.registerMemoryProvider(legacy.provider);
		controller.registerContextMemoryProvider(externalContextProvider(contextCalls));
		await controller.initialize();

		expect(await controller.prefetchRecall(query)).toBe("");
		await controller.runMemoryRetrieval([{ role: "user", content: [{ type: "text", text: query }], timestamp: 0 }]);

		expect(legacy.prefetch).not.toHaveBeenCalled();
		expect(contextCalls).toHaveLength(0);
	});

	it("uses the explicit external-egress switch for legacy and context providers", async () => {
		const settings: ResolvedMemorySettings = {
			enabled: true,
			maxResults: 5,
			includeInPrompt: true,
			allowExternalEgress: true,
		};
		const controller = await createController(settings);
		const legacy = legacyProvider("external-extension", "external");
		const contextCalls: MemorySearchRequest[] = [];
		controller.registerMemoryProvider(legacy.provider);
		controller.registerContextMemoryProvider(externalContextProvider(contextCalls));
		await controller.initialize();
		const query = "recall the compact external deployment memory";

		await controller.prefetchRecall("recall api_key=super-secret from deployment memory");
		expect(legacy.prefetch).not.toHaveBeenCalled();
		await controller.prefetchRecall(query);
		const report = await controller.runMemoryRetrieval([
			{ role: "user", content: [{ type: "text", text: query }], timestamp: 0 },
		]);

		expect(legacy.prefetch).toHaveBeenCalledWith(query);
		expect(contextCalls).toHaveLength(1);
		expect(report.providerReports).toContainEqual(
			expect.objectContaining({ providerId: "external-context", status: "queried" }),
		);
	});
});
