import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import type { Context } from "@caupulican/pi-ai";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileStoreProvider } from "../../src/core/memory/providers/file-store.ts";
import { IcmProvider } from "../../src/core/memory/providers/icm.ts";
import type { MemorySystem } from "../../src/core/settings-manager.ts";
import { createHarness } from "./harness.ts";

describe("AgentSession memory-system switching", () => {
	afterEach(() => vi.restoreAllMocks());

	it("starts ICM without initializing legacy managed memory", async () => {
		const initializeLegacy = vi.spyOn(FileStoreProvider.prototype, "initialize");
		const harness = await createHarness({ settings: { memorySystem: "icm" } });
		await harness.session.initializeMemory();
		expect(initializeLegacy).not.toHaveBeenCalled();
		expect(harness.session.getMemorySystem()).toBe("icm");
		expect(harness.session.getActiveToolNames()).not.toContain("memory");
		expect(harness.session.systemPrompt).toContain("ICM memory:");
		expect(harness.session.systemPrompt).toContain(
			`User ICM catalog: ${JSON.stringify(join(harness.tempDir, "memory"))}`,
		);
		expect(harness.session.systemPrompt).toContain(`Workspace: ${JSON.stringify(harness.tempDir)}`);
		expect(harness.session.systemPrompt).toContain("Root reflection is disabled.");
		expect(harness.session.systemPrompt).not.toContain("Query memory");
		expect(harness.session.systemPrompt).not.toContain("=== Persistent Memory (file-store) ===");
	});

	it("switches both ways without modifying legacy file contents", async () => {
		const harness = await createHarness();
		const memoryPath = join(harness.tempDir, "MEMORY.md");
		const stored = "Legacy-only sentinel: release channel is amber.\n";
		writeFileSync(memoryPath, stored);
		await harness.session.initializeMemory();
		expect(harness.session.getMemorySystem()).toBe("okf");
		expect(harness.session.systemPrompt).toContain("Legacy-only sentinel");

		expect(await harness.session.setMemorySystem("icm")).toMatchObject({ ok: true });
		expect(harness.settingsManager.getMemorySystem()).toBe("icm");
		expect(harness.session.getActiveToolNames()).not.toContain("memory");
		expect(harness.session.systemPrompt).not.toContain("Legacy-only sentinel");
		expect(readFileSync(memoryPath, "utf8")).toBe(stored);

		let captured: Context | undefined;
		harness.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("recall the release channel");
		expect(JSON.stringify(captured)).not.toContain("Legacy-only sentinel");
		expect(harness.session.getMemoryRetrievalReport().providerReports).toEqual([]);
		expect(readFileSync(memoryPath, "utf8")).toBe(stored);

		expect(await harness.session.setMemorySystem("okf")).toMatchObject({ ok: true });
		expect(harness.settingsManager.getMemorySystem()).toBe("okf");
		expect(harness.session.getActiveToolNames()).toContain("memory");
		expect(harness.session.systemPrompt).toContain("Legacy-only sentinel");
		expect(readFileSync(memoryPath, "utf8")).toBe(stored);
	});

	it("restores the previous mode when provider activation fails", async () => {
		const harness = await createHarness();
		await harness.session.initializeMemory();
		vi.spyOn(IcmProvider.prototype, "initialize").mockRejectedValueOnce(new Error("activation tripwire"));
		expect(await harness.session.setMemorySystem("icm")).toMatchObject({ ok: false });
		expect(harness.settingsManager.getMemorySystem()).toBe("okf");
		expect(harness.session.getActiveToolNames()).toContain("memory");
	});

	it("restores the previous mode when settings persistence reports failure", async () => {
		const harness = await createHarness();
		await harness.session.initializeMemory();
		vi.spyOn(harness.settingsManager, "drainErrors").mockReturnValueOnce([
			{ scope: "global", error: new Error("persistence tripwire") },
		]);
		expect(await harness.session.setMemorySystem("icm")).toMatchObject({ ok: false });
		expect(harness.settingsManager.getMemorySystem()).toBe("okf");
		expect(harness.session.getActiveToolNames()).toContain("memory");
	});

	it("holds the submission lease until provider initialization settles", async () => {
		const harness = await createHarness();
		await harness.session.initializeMemory();
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const initialize = IcmProvider.prototype.initialize;
		vi.spyOn(IcmProvider.prototype, "initialize").mockImplementation(async function (this: IcmProvider, ...args) {
			entered();
			await gate;
			await initialize.apply(this, args);
		});
		const switching = harness.session.setMemorySystem("icm");
		await started;
		try {
			expect(await harness.session.setMemorySystem("okf")).toMatchObject({ ok: false });
		} finally {
			release();
		}
		expect(await switching).toMatchObject({ ok: true });
		expect(await harness.session.setMemorySystem("okf")).toMatchObject({ ok: true });
	});

	it("refuses unknown systems and busy-session switches without changing settings", async () => {
		const harness = await createHarness();
		expect(await harness.session.setMemorySystem("unknown" as MemorySystem)).toMatchObject({ ok: false });
		expect(harness.settingsManager.getMemorySystem()).toBe("okf");
		vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);
		expect(await harness.session.setMemorySystem("icm")).toMatchObject({ ok: false });
		expect(harness.settingsManager.getMemorySystem()).toBe("okf");
	});

	it("excludes historical generated legacy context from ICM requests without deleting history", async () => {
		const harness = await createHarness({ settings: { memorySystem: "icm" } });
		await harness.session.initializeMemory();
		const historical = createCustomMessage(
			"memory_context",
			"OLD_PREFETCH_SENTINEL",
			false,
			undefined,
			new Date(0).toISOString(),
		);
		harness.session.agent.state.messages.push(historical);
		let captured: Context | undefined;
		harness.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("inspect the workspace");
		expect(JSON.stringify(captured)).not.toContain("OLD_PREFETCH_SENTINEL");
		expect(harness.session.agent.state.messages).toContain(historical);
	});
});
