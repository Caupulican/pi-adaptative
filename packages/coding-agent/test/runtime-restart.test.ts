import { describe, expect, it, vi } from "vitest";
import { consumeRuntimeEnvelope, RUNTIME_SUPERVISOR_ENV } from "../src/cli/runtime-channel.ts";
import { createRuntimeRestartHandler } from "../src/cli/runtime-restart.ts";

describe("supervised core restart adapter", () => {
	const request = { id: "update", sessionId: "session", sessionFile: "/session.jsonl" };

	it("keeps the live host when candidate capture fails", async () => {
		const shutdown = vi.fn(async () => {});
		const handler = createRuntimeRestartHandler({
			prepare: async () => {
				throw new Error("capture failed");
			},
			discard: async () => {},
			handoff: async () => {},
			assertQuiescent: () => {},
			shutdown,
			exit: () => {
				throw new Error("must not exit");
			},
		});
		await expect(handler(request)).rejects.toThrow("capture failed");
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("persists the handoff after teardown, then exits instead of opening another writer", async () => {
		const events: string[] = [];
		const handler = createRuntimeRestartHandler({
			prepare: async () => {
				events.push("prepare");
			},
			discard: async () => {
				events.push("discard");
			},
			handoff: async () => {
				events.push("handoff");
			},
			assertQuiescent: () => {
				events.push("quiescent");
			},
			shutdown: async () => {
				events.push("shutdown");
			},
			exit: (code) => {
				events.push(`exit:${code}`);
				throw new Error("terminal");
			},
		});
		await expect(handler(request)).rejects.toThrow("terminal");
		expect(events).toEqual(["quiescent", "prepare", "quiescent", "shutdown", "handoff", "exit:0"]);
	});

	it("exits for autonomous rollback if teardown fails, and never continues disposed resources", async () => {
		const handoff = vi.fn(async () => {});
		const exit = vi.fn((_code: number): never => {
			throw new Error("supervisor takes over");
		});
		const handler = createRuntimeRestartHandler({
			prepare: async () => {},
			discard: async () => {},
			handoff,
			assertQuiescent: () => {},
			shutdown: async () => {
				throw new Error("dispose failed");
			},
			exit,
		});
		await expect(handler(request)).rejects.toThrow("supervisor takes over");
		expect(exit).toHaveBeenCalledWith(1);
		expect(handoff).not.toHaveBeenCalled();
	});

	it("consumes exact parent IPC handoffs and rejects inherited or malformed ones", () => {
		const encoded = JSON.stringify({
			parentPid: 12,
			origin: "/source",
			stableTarget: null,
			handoff: { ...request, disposition: "candidate" },
		});
		const env = { [RUNTIME_SUPERVISOR_ENV]: encoded };
		expect(consumeRuntimeEnvelope(env, 12, true)?.handoff).toMatchObject(request);
		expect(env[RUNTIME_SUPERVISOR_ENV]).toBeUndefined();
		for (const [value, parent, connected] of [
			["not-json", 12, true],
			["{}", 12, true],
			[encoded, 13, true],
			[encoded, 12, false],
		] as const) {
			const inherited = { [RUNTIME_SUPERVISOR_ENV]: value };
			expect(() => consumeRuntimeEnvelope(inherited, parent, connected)).toThrow();
			expect(inherited[RUNTIME_SUPERVISOR_ENV]).toBeUndefined();
		}
	});

	it("admits a maximally escaped bounded handoff and rejects NUL filesystem paths", () => {
		const handoff = {
			...request,
			sessionFile: `/${"\t".repeat(4090)}`,
			disposition: "rollback",
			error: "\n".repeat(2000),
		};
		const env = {
			[RUNTIME_SUPERVISOR_ENV]: JSON.stringify({
				parentPid: 12,
				origin: `/${"\t".repeat(4090)}`,
				handoff,
				stableTarget: null,
			}),
		};
		expect(consumeRuntimeEnvelope(env, 12, true)?.handoff).toMatchObject(handoff);
		const invalid = {
			[RUNTIME_SUPERVISOR_ENV]: JSON.stringify({
				parentPid: 12,
				origin: "/source\0escape",
				handoff,
				stableTarget: null,
			}),
		};
		expect(() => consumeRuntimeEnvelope(invalid, 12, true)).toThrow();
	});
});
