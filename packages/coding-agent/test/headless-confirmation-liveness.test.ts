import { describe, expect, it, vi } from "vitest";
import { promptConfirm } from "../src/main.ts";
import { showDeprecationWarnings } from "../src/migrations.ts";

async function withHeadlessStreams<T>(run: () => Promise<T>): Promise<T> {
	const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
	try {
		return await run();
	} finally {
		if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
	}
}

async function expectQuickSettlement<T>(operation: Promise<T>): Promise<T> {
	let guard: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				guard = setTimeout(() => reject(new Error("headless confirmation did not settle")), 250);
			}),
		]);
	} finally {
		if (guard) clearTimeout(guard);
	}
}

describe("headless confirmation liveness", () => {
	it("fails a yes/no safety confirmation closed without reading stdin", async () => {
		await withHeadlessStreams(async () => {
			await expect(expectQuickSettlement(promptConfirm("Proceed?"))).resolves.toBe(false);
		});
	});

	it("prints migration warnings without waiting for a keypress", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await withHeadlessStreams(async () => {
				await expect(expectQuickSettlement(showDeprecationWarnings(["deprecated path"]))).resolves.toBeUndefined();
			});
			expect(log).toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});
});
