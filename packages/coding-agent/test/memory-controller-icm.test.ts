import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryProvider } from "../src/core/memory/memory-provider.ts";
import { FileStoreProvider } from "../src/core/memory/providers/file-store.ts";
import { IcmProvider } from "../src/core/memory/providers/icm.ts";
import { TranscriptRecallProvider } from "../src/core/memory/providers/transcript-recall.ts";
import { MemoryController } from "../src/core/memory-controller.ts";
import type { MemorySystem, SettingsManager } from "../src/core/settings-manager.ts";

describe("MemoryController system isolation", () => {
	let root: string;
	let system: MemorySystem;
	let controller: MemoryController;
	let refresh: () => void;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-memory-isolation-"));
		system = "icm";
		refresh = vi.fn(() => {});
		const settings = {
			getMemorySystem: () => system,
			getMemoryRetrievalSettings: () => ({ enabled: true, includeInPrompt: true, maxResults: 5 }),
		} as unknown as SettingsManager;
		controller = new MemoryController({
			getSettingsManager: () => settings,
			getTurnIndex: () => 0,
			getAgentDir: () => join(root, "agent"),
			getCwd: () => root,
			getSessionId: () => "isolation",
			isChildSession: () => false,
			refreshToolRegistry: refresh,
			getContextWindow: () => 128_000,
			getGoalState: () => undefined,
			emitWarning: () => {},
		});
	});

	afterEach(async () => {
		await controller.shutdown();
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it("ICM startup and all retrieval ports leave legacy providers and disk untouched", async () => {
		const fileInit = vi.spyOn(FileStoreProvider.prototype, "initialize");
		const recallInit = vi.spyOn(TranscriptRecallProvider.prototype, "initialize");
		const extensionInit = vi.fn(async () => {});
		const extension: MemoryProvider = {
			name: "extension-memory",
			egress: "local",
			getCapabilities: () => ({ surfaces: ["context"] }),
			isAvailable: () => true,
			initialize: extensionInit,
			shutdown: async () => {},
		};
		controller.registerMemoryProvider(extension);
		await controller.initialize();
		expect(controller.getActiveMemorySystem()).toBe("icm");
		expect(controller.getMemoryManager().getToolDefinitions()).toEqual([]);
		expect(controller.getFileStoreWriter()).toBeUndefined();
		expect(controller.shouldAttemptRecall("Recall our previous architecture decisions")).toBe(false);
		expect(await controller.prefetchRecall("architecture decisions")).toBe("");
		const report = await controller.runMemoryRetrieval([
			{ role: "user", content: "Recall architecture decisions", timestamp: 0 },
		]);
		expect(report.contextItems).toEqual([]);
		expect(controller.appendPromptMemory([], report)).toEqual([]);
		expect(controller.getFreshOkfMemoryForReflection()).toBe("");
		expect(controller.getHandoffPersonaGuidance()).toBeUndefined();
		expect(await controller.readMemoryForLane("architecture")).toMatch(/ICM|offline/);
		expect(await controller.memoryDriftReport()).toEqual([]);
		controller.scheduleTurnSync("user", "assistant");
		expect(await controller.onPreCompress()).toBe("");
		await controller.shutdown();
		expect(fileInit).not.toHaveBeenCalled();
		expect(recallInit).not.toHaveBeenCalled();
		expect(extensionInit).not.toHaveBeenCalled();
		expect(readdirSync(root)).toEqual([]);
	});

	it("switches both ways and retains extension registrations without activating them in ICM", async () => {
		mkdirSync(join(root, "agent"));
		writeFileSync(join(root, "agent", "MEMORY.md"), "A durable memory fact.\n");
		const extensionInit = vi.fn(async () => {});
		controller.registerMemoryProvider({
			name: "extension-memory",
			egress: "local",
			getCapabilities: () => ({ surfaces: ["context"] }),
			isAvailable: () => true,
			initialize: extensionInit,
			shutdown: async () => {},
		});
		system = "okf";
		await controller.initialize();
		expect(controller.getActiveMemorySystem()).toBe("okf");
		expect(controller.getFileStoreWriter()).toBeDefined();
		expect(extensionInit).toHaveBeenCalledTimes(1);
		system = "icm";
		await controller.initialize();
		expect(controller.getActiveMemorySystem()).toBe("icm");
		expect(controller.getFileStoreWriter()).toBeUndefined();
		expect(controller.getMemoryManager().getToolDefinitions()).toEqual([]);
		expect(extensionInit).toHaveBeenCalledTimes(1);
		system = "okf";
		await controller.initialize();
		expect(controller.getActiveMemorySystem()).toBe("okf");
		expect(controller.getFileStoreWriter()).toBeDefined();
		expect(extensionInit).toHaveBeenCalledTimes(2);
	});

	it("does not claim activation when the required provider fails or is unavailable", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const initialize = vi.spyOn(IcmProvider.prototype, "initialize").mockRejectedValue(new Error("broken provider"));
		await controller.initialize();
		expect(controller.getActiveMemorySystem()).toBeUndefined();
		expect(refresh).toHaveBeenCalled();
		expect(controller.getMemoryManager().getToolDefinitions()).toEqual([]);
		initialize.mockRestore();
		vi.spyOn(IcmProvider.prototype, "isAvailable").mockReturnValue(false);
		await controller.initialize();
		expect(controller.getActiveMemorySystem()).toBeUndefined();
	});
});
