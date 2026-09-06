import { describe, expect, it, vi } from "vitest";
import { createRemoteIntentOps } from "../examples/extensions/ssh.ts";

describe("SSH mutation queue resource port", () => {
	it("gets canonical identity from the remote and preserves whitespace", async () => {
		const execute = vi.fn(async () => Buffer.from("/fixture/remote/name \n\0"));
		const operations = createRemoteIntentOps("fixture-host", "/fixture/remote", "/fixture/local", execute);
		await expect(operations.mutationQueue.resolveKey("/fixture/local/a'b.txt")).resolves.toBe(
			"/fixture/remote/name \n",
		);
		expect(execute).toHaveBeenCalledExactlyOnceWith(
			"fixture-host",
			"realpath -mz -- '/fixture/remote/a'\"'\"'b.txt'",
		);
	});
	it.each(["", "/fixture/no-terminator", "/fixture/one\0/fixture/two\0"])(
		"rejects malformed canonical output %j",
		async (output) => {
			const operations = createRemoteIntentOps("fixture-host", "/fixture/remote", "/fixture/local", async () =>
				Buffer.from(output),
			);
			await expect(operations.mutationQueue.resolveKey("/fixture/local/file")).rejects.toThrow(/identity/i);
		},
	);
	it("propagates transport failure instead of borrowing a local queue identity", async () => {
		const failure = new Error("synthetic transport failure");
		const operations = createRemoteIntentOps("fixture-host", "/fixture/remote", "/fixture/local", async () => {
			throw failure;
		});
		await expect(operations.mutationQueue.resolveKey("/fixture/local/file")).rejects.toBe(failure);
	});
});
