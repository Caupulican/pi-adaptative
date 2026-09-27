import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MemoryProvider } from "../src/core/memory/memory-provider.ts";
import { MemoryController } from "../src/core/memory-controller.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { tempDir } from "./temp-dir.ts";

function createController(): MemoryController {
	const root = tempDir("pi-memory-lane-snapshot-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "MEMORY.md"), "Shared standing fact.\n", "utf8");
	writeFileSync(join(agentDir, "USER.md"), "", "utf8");
	const settings = {
		getMemorySystem: () => "okf" as const,
		getMemoryRetrievalSettings: () => ({
			enabled: true,
			includeInPrompt: true,
			maxResults: 5,
			allowExternalEgress: false,
		}),
	} as unknown as SettingsManager;
	return new MemoryController({
		getSettingsManager: () => settings,
		getTurnIndex: () => 1,
		getAgentDir: () => agentDir,
		getCwd: () => root,
		getSessionId: () => "lane-snapshot-session",
		isChildSession: () => false,
		refreshToolRegistry: () => {},
		getContextWindow: () => 4_096,
		getGoalState: () => undefined,
		emitWarning: () => {},
	});
}

describe("delegated memory read snapshots", () => {
	it("shares one in-flight retrieval between concurrent readers of the same source revision", async () => {
		const controller = createController();
		await controller.initialize();
		let releaseRecall: () => void = () => {};
		const recallReleased = new Promise<void>((resolve) => {
			releaseRecall = resolve;
		});
		let notifyRecallStarted: () => void = () => {};
		const recallStarted = new Promise<void>((resolve) => {
			notifyRecallStarted = resolve;
		});
		const prefetch = vi.spyOn(controller, "prefetchRecall").mockImplementation(async () => {
			notifyRecallStarted();
			await recallReleased;
			return "Shared recalled fact.";
		});

		const first = controller.readMemorySnapshotForLane("same query");
		await recallStarted;
		const second = controller.readMemorySnapshotForLane("same query");

		expect(prefetch).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
		releaseRecall();
		const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
		expect(secondSnapshot).toBe(firstSnapshot);
		expect(firstSnapshot.content).toContain("Shared recalled fact.");
		expect(firstSnapshot.snapshotId).toMatch(/^[a-f0-9]{32}$/);
	});

	it("does not coalesce different capability queries or cache a completed read", async () => {
		const controller = createController();
		await controller.initialize();
		const prefetch = vi
			.spyOn(controller, "prefetchRecall")
			.mockImplementation(async (query) => `Recall for ${query}.`);

		const [alpha, beta] = await Promise.all([
			controller.readMemorySnapshotForLane("alpha query"),
			controller.readMemorySnapshotForLane("beta query"),
		]);
		expect(prefetch).toHaveBeenCalledTimes(2);
		expect(alpha.content).toContain("Recall for alpha query.");
		expect(beta.content).toContain("Recall for beta query.");

		await controller.readMemorySnapshotForLane("alpha query");
		expect(prefetch).toHaveBeenCalledTimes(3);
	});

	it("rejects an in-flight snapshot after a durable memory write changes its source revision", async () => {
		const controller = createController();
		await controller.initialize();
		let releaseRecall: () => void = () => {};
		const recallReleased = new Promise<void>((resolve) => {
			releaseRecall = resolve;
		});
		let notifyRecallStarted: () => void = () => {};
		const recallStarted = new Promise<void>((resolve) => {
			notifyRecallStarted = resolve;
		});
		vi.spyOn(controller, "prefetchRecall").mockImplementation(async () => {
			notifyRecallStarted();
			await recallReleased;
			return "Stale recalled fact.";
		});

		const staleRead = controller.readMemoryForLane("same query");
		await recallStarted;
		await expect(
			controller.applyStructuredReflectionWrite({
				kind: "okf_add",
				type: "Implementation Note",
				title: "New durable fact",
				description: "Changes the memory source revision while a delegated read is active.",
				text: "Fresh content supersedes any snapshot already being assembled.",
				evidenceRefs: ["test:lane-snapshot-revision"],
			}),
		).resolves.toMatchObject({ applied: true, created: true });
		releaseRecall();

		await expect(staleRead).rejects.toThrow("memory_snapshot_stale");
	});

	it("rejects an in-flight snapshot when the memory subsystem restarts", async () => {
		const controller = createController();
		await controller.initialize();
		let releaseRecall: () => void = () => {};
		const recallReleased = new Promise<void>((resolve) => {
			releaseRecall = resolve;
		});
		let notifyRecallStarted: () => void = () => {};
		const recallStarted = new Promise<void>((resolve) => {
			notifyRecallStarted = resolve;
		});
		vi.spyOn(controller, "prefetchRecall").mockImplementation(async () => {
			notifyRecallStarted();
			await recallReleased;
			return "Old generation recall.";
		});

		const staleRead = controller.readMemoryForLane("generation query");
		await recallStarted;
		const restarted = controller.initialize();
		releaseRecall();

		await expect(staleRead).rejects.toThrow("memory_snapshot_stale");
		await restarted;
	});

	it("waits for an admitted provider turn write before reading that provider", async () => {
		const controller = createController();
		let memory = "Old extension memory.";
		let releaseSync: () => void = () => {};
		const syncReleased = new Promise<void>((resolve) => {
			releaseSync = resolve;
		});
		let notifySyncStarted: () => void = () => {};
		const syncStarted = new Promise<void>((resolve) => {
			notifySyncStarted = resolve;
		});
		const prefetch = vi.fn(async () => memory);
		const provider: MemoryProvider = {
			name: "mutable-extension-memory",
			egress: "local",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			shutdown: async () => {},
			prefetch,
			syncTurn: async () => {
				notifySyncStarted();
				await syncReleased;
				memory = "Fresh extension memory.";
			},
		};
		controller.registerMemoryProvider(provider);
		await controller.initialize();

		controller.scheduleTurnSync("new user turn", "new assistant turn");
		const read = controller.readMemoryForLane("extension state");
		await syncStarted;
		await new Promise((resolve) => setTimeout(resolve, 0));
		try {
			expect(prefetch).not.toHaveBeenCalled();
		} finally {
			releaseSync();
		}

		await expect(read).resolves.toContain("Fresh extension memory.");
	});
});
