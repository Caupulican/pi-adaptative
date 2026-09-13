import { describe, expect, it, vi } from "vitest";
import { handleMemoryCommand, MEMORY_COMMAND_USAGE } from "../src/modes/interactive/memory-commands.ts";

function host(
	entries: Parameters<typeof handleMemoryCommand>[0]["memoryDriftReport"] extends () => Promise<infer T> ? T : never,
) {
	return {
		memoryDriftReport: vi.fn(async () => entries),
		memoryAcceptDrift: vi.fn(async (target: string) => ({ ok: true, message: `accepted ${target}` })),
		memoryRestoreManaged: vi.fn(async (target: string) => ({ ok: false, message: `cannot restore ${target}` })),
		getMemorySystem: vi.fn<() => "okf" | "icm">(() => "okf"),
		setMemorySystem: vi.fn(async (system: string) => ({ ok: true, message: `switched to ${system}` })),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showText: vi.fn(),
	};
}

describe("/memory", () => {
	it("reports current memory system via /memory system", async () => {
		const h = host([]);
		h.getMemorySystem.mockReturnValue("okf");
		await handleMemoryCommand(h, "/memory system");
		expect(h.showStatus).toHaveBeenCalledWith("Memory system: okf");
	});

	it("switches memory system via /memory system icm", async () => {
		const h = host([]);
		await handleMemoryCommand(h, "/memory system icm");
		expect(h.setMemorySystem).toHaveBeenCalledWith("icm");
		expect(h.showStatus).toHaveBeenCalledWith("switched to icm");
	});

	it("switches memory system via /memory system okf", async () => {
		const h = host([]);
		await handleMemoryCommand(h, "/memory system okf");
		expect(h.setMemorySystem).toHaveBeenCalledWith("okf");
		expect(h.showStatus).toHaveBeenCalledWith("switched to okf");
	});

	it("rejects unknown memory system names", async () => {
		const h = host([]);
		await handleMemoryCommand(h, "/memory system xyz");
		expect(h.showError).toHaveBeenCalledWith(MEMORY_COMMAND_USAGE);
		expect(h.setMemorySystem).not.toHaveBeenCalled();
	});

	it("reports drift per managed file and routes accept/restore to the session", async () => {
		const h = host([
			{
				target: "memory",
				label: "MEMORY.md (general)",
				path: "/a/MEMORY.md",
				drift: true,
				emptyOnDisk: true,
				currentChars: 0,
				currentDigest: "e3b0",
				managedDigest: "abcd",
				managedChars: 120,
				stateStatus: "valid",
			},
			{
				target: "user",
				label: "USER.md",
				path: "/a/USER.md",
				drift: false,
				emptyOnDisk: false,
				currentChars: 40,
				currentDigest: "1111",
				managedDigest: "1111",
				managedChars: 40,
				stateStatus: "valid",
			},
		]);
		await handleMemoryCommand(h, "/memory");
		const text = h.showText.mock.calls[0]?.[0] as string;
		expect(text).toContain("1 managed memory file drifted");
		expect(text).toContain("EMPTY on disk — drifted");
		expect(text).toContain("managed 120 chars stored");
		expect(text).toContain("- user: USER.md — in sync");
		await handleMemoryCommand(h, "/memory accept project");
		expect(h.memoryAcceptDrift).toHaveBeenCalledWith("project");
		expect(h.showStatus).toHaveBeenLastCalledWith("accepted project");
		await handleMemoryCommand(h, "/memory restore user");
		expect(h.showError).toHaveBeenLastCalledWith("cannot restore user");
		await handleMemoryCommand(h, "/memory accept nowhere");
		expect(h.showError).toHaveBeenLastCalledWith(MEMORY_COMMAND_USAGE);
		await handleMemoryCommand(host([]), "/memory drift");
	});

	it("reports ICM status without switching", async () => {
		const h = host([]);
		h.getMemorySystem.mockReturnValue("icm");
		await handleMemoryCommand(h, "/memory system");
		expect(h.showStatus).toHaveBeenCalledWith("Memory system: icm");
	});
});
