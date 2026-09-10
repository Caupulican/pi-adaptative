import { describe, expect, it, vi } from "vitest";
import { handleMemoryCommand, MEMORY_COMMAND_USAGE } from "../src/modes/interactive/memory-commands.ts";

function host(
	entries: Parameters<typeof handleMemoryCommand>[0]["memoryDriftReport"] extends () => Promise<infer T> ? T : never,
) {
	return {
		memoryDriftReport: vi.fn(async () => entries),
		memoryAcceptDrift: vi.fn(async (target: string) => ({ ok: true, message: `accepted ${target}` })),
		memoryRestoreManaged: vi.fn(async (target: string) => ({ ok: false, message: `cannot restore ${target}` })),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showText: vi.fn(),
	};
}

describe("/memory", () => {
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
});
