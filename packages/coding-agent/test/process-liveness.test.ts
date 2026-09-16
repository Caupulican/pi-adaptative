import { describe, expect, it, vi } from "vitest";
import { isProcessAlive } from "../src/core/process-liveness.ts";

function errno(code?: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(code ? `mock ${code}` : "mock failure without a code");
	if (code) error.code = code;
	return error;
}

describe("isProcessAlive", () => {
	it("rejects missing and non-positive pids without probing", () => {
		const probe = vi.fn<(pid: number, signal: 0) => boolean>(() => true);
		expect(isProcessAlive(undefined, probe)).toBe(false);
		expect(isProcessAlive(0, probe)).toBe(false);
		expect(isProcessAlive(-1, probe)).toBe(false);
		expect(probe).not.toHaveBeenCalled();
	});

	it("treats a successful probe and EPERM as not proven absent", () => {
		const probe = vi.fn<(pid: number, signal: 0) => boolean>(() => true);
		expect(isProcessAlive(42, probe)).toBe(true);
		probe.mockImplementationOnce(() => {
			throw errno("EPERM");
		});
		expect(isProcessAlive(43, probe)).toBe(true);
	});

	it("treats ESRCH as proven absence", () => {
		const probe = vi.fn<(pid: number, signal: 0) => boolean>(() => {
			throw errno("ESRCH");
		});
		expect(isProcessAlive(44, probe)).toBe(false);
	});

	it.each([
		["EINVAL", "EINVAL"],
		["an error with no code", undefined],
	])("does not treat unclassified probe failure (%s) as death", (_label, code) => {
		const probe = vi.fn<(pid: number, signal: 0) => boolean>(() => {
			throw errno(code);
		});
		expect(isProcessAlive(45, probe)).toBe(true);
	});
});
