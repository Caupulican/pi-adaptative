import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeRuntimeEnvelope, RUNTIME_SUPERVISOR_ENV, RuntimeChildChannel } from "../src/cli/runtime-channel.ts";

afterEach(() => vi.useRealTimers());

function channel() {
	return new RuntimeChildChannel({
		parentPid: process.ppid,
		origin: "/runtime",
		stableTarget: null,
		handoff: { id: "update", sessionId: "session", sessionFile: "/session.jsonl", disposition: "candidate" },
	});
}

describe("runtime acknowledgement recovery", () => {
	it("consumes a bounded stable launcher only on its exact parent channel", () => {
		const origin = resolve("runtime-original");
		const entrypoint = join(origin, "cli.ts");
		const stableTarget = {
			executable: join(origin, "node"),
			argsPrefix: ["--conditions=pi-source", entrypoint],
			environment: { PI_PACKAGE_DIR: join(origin, "package"), TSX_TSCONFIG_PATH: join(origin, "tsconfig.json") },
		};
		const encoded = JSON.stringify({ parentPid: 12, origin, stableTarget });
		const env = { [RUNTIME_SUPERVISOR_ENV]: encoded };
		expect(consumeRuntimeEnvelope(env, 12, true)?.stableTarget).toEqual(stableTarget);
		expect(env).toEqual({});
		for (const mutation of [
			{ executable: "relative-node" },
			{ executable: `${stableTarget.executable}\0bad` },
			{ argsPrefix: ["--import", "unresolved-package", entrypoint] },
			{ argsPrefix: ["./relative-cli.ts"] },
			{ argsPrefix: Array.from({ length: 33 }, () => entrypoint) },
			{ environment: { ...stableTarget.environment, OTHER: "unowned" } },
			{ environment: { ...stableTarget.environment, TSX_TSCONFIG_PATH: "relative.json" } },
		]) {
			const invalid = {
				[RUNTIME_SUPERVISOR_ENV]: JSON.stringify({
					parentPid: 12,
					origin,
					stableTarget: { ...stableTarget, ...mutation },
				}),
			};
			expect(() => consumeRuntimeEnvelope(invalid, 12, true)).toThrow();
			expect(invalid).toEqual({});
		}
		expect(() => consumeRuntimeEnvelope({ [RUNTIME_SUPERVISOR_ENV]: encoded }, 13, true)).toThrow();
		expect(() => consumeRuntimeEnvelope({ [RUNTIME_SUPERVISOR_ENV]: encoded }, 12, false)).toThrow();
	});

	it("replays only the same idempotent commit when its acknowledgement is lost", async () => {
		vi.useFakeTimers();
		const host = channel();
		const send = vi.spyOn(host, "send").mockImplementation(async () => {
			if (send.mock.calls.length === 2) process.emit("message", { type: "committed", id: "update" }, undefined);
		});
		const pending = host.request({ type: "commit", id: "update" });
		process.emit("message", { type: "committed", id: "stale" }, undefined);
		expect(host.needsRollback()).toBe(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(send.mock.calls).toEqual([[{ type: "commit", id: "update" }], [{ type: "commit", id: "update" }]]);
		await pending;
		expect(host.needsRollback()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds acknowledgement retries and never retries capture or explicit rejection", async () => {
		vi.useFakeTimers();
		const host = channel();
		const send = vi.spyOn(host, "send").mockResolvedValue();
		const commit = expect(host.request({ type: "commit", id: "update" })).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(send).toHaveBeenCalledTimes(3);
		await commit;
		expect(host.needsRollback()).toBe(true);
		send.mockClear();
		const prepare = expect(
			host.request({
				type: "prepare",
				request: { id: "update", sessionId: "session", sessionFile: "/session.jsonl" },
			}),
		).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(120_000);
		await prepare;
		expect(send).toHaveBeenCalledTimes(1);
		send.mockClear();
		const rejected = expect(host.request({ type: "commit", id: "update" })).rejects.toThrow("not admitted");
		process.emit("message", { type: "rejected", id: "update", error: "not admitted" }, undefined);
		await rejected;
		await vi.advanceTimersByTimeAsync(15_000);
		expect(send).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
