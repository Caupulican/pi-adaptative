import { describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
	closeSync: vi.fn(),
	openSync: vi.fn(() => 123),
	writeSync: vi.fn(),
}));

vi.mock("node:fs", () => fsMocks);

const { OutputAccumulator } = await import("../src/core/tools/output-accumulator.ts");

describe("OutputAccumulator temp-file I/O errors", () => {
	it("does not throw or leak an open descriptor when full-output writes fail", async () => {
		fsMocks.closeSync.mockReset();
		fsMocks.openSync.mockReset().mockReturnValue(123);
		fsMocks.writeSync.mockReset().mockImplementation(() => {
			throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		});

		const output = new OutputAccumulator({ maxLines: 1, maxBytes: 4 });

		expect(() => output.append(Buffer.from("abcdef", "utf-8"))).not.toThrow();
		expect(() => output.finish()).not.toThrow();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		await expect(output.closeTempFile()).resolves.toBeUndefined();

		expect(fsMocks.closeSync).toHaveBeenCalledWith(123);
		expect(snapshot.truncation.truncated).toBe(true);
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect(snapshot.fullOutputError).toContain("ENOSPC");
	});

	it("does not throw if closing the temp descriptor fails", async () => {
		fsMocks.closeSync.mockReset().mockImplementation(() => {
			throw Object.assign(new Error("bad file descriptor"), { code: "EBADF" });
		});
		fsMocks.openSync.mockReset().mockReturnValue(456);
		fsMocks.writeSync.mockReset().mockReturnValue(0);

		const output = new OutputAccumulator({ maxLines: 1, maxBytes: 4 });
		output.append(Buffer.from("abcdef", "utf-8"));

		await expect(output.closeTempFile()).resolves.toBeUndefined();
		await expect(output.closeTempFile()).resolves.toBeUndefined();

		expect(fsMocks.closeSync).toHaveBeenCalledTimes(1);
		const snapshot = output.snapshot({ persistIfTruncated: true });
		expect(snapshot.fullOutputError).toContain("EBADF");
	});
});
