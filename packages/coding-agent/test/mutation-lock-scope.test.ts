import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLaneToolSurface, type LaneToolSurface } from "../src/core/autonomy/lane-tool-surface.ts";
import type { NormalizedProfile } from "../src/core/profile-registry.ts";
import type { ResourceProfileSettings } from "../src/core/settings-manager.ts";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";
import {
	announceToolCall,
	DEFAULT_MUTATION_SCOPE,
	disposeMutationLockScope,
	getMutationLockScope,
	mutationScopeForWorktree,
	retainMutationLockScope,
	retireToolCall,
	withExclusiveMutationBarrier,
	withFileMutationQueue,
} from "../src/core/tools/file-mutation-queue.ts";

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("condition was not reached");
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Settled only once nothing else in this microtask/timer burst can still resolve it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
	const marker = Symbol("pending");
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 1));
	return (await Promise.race([promise.then(() => marker), Promise.resolve(undefined)])) === marker;
}

function profile(resources: ResourceProfileSettings): NormalizedProfile {
	return { name: "lane", resources, source: "inline" };
}

describe("per-session mutation lock scopes", () => {
	it("an exclusive run in one scope does not block a file mutation in another", async () => {
		const order: string[] = [];
		const gate = deferred();
		const exclusive = withExclusiveMutationBarrier(
			async () => {
				order.push("a-run-start");
				await gate.promise;
				order.push("a-run-end");
			},
			{ scope: "session-a" },
		);
		await waitUntil(() => order.includes("a-run-start"));
		await withFileMutationQueue(
			"/tmp/scope-cross-run.txt",
			async () => {
				order.push("b-mutation");
			},
			undefined,
			{ scope: "session-b" },
		);
		expect(order).toEqual(["a-run-start", "b-mutation"]);
		gate.resolve();
		await exclusive;
		expect(order).toEqual(["a-run-start", "b-mutation", "a-run-end"]);
	});

	it("a file mutation in one scope does not block an exclusive run in another", async () => {
		const order: string[] = [];
		const gate = deferred();
		const mutation = withFileMutationQueue(
			"/tmp/scope-cross-mutation.txt",
			async () => {
				order.push("b-mutation-start");
				await gate.promise;
				order.push("b-mutation-end");
			},
			undefined,
			{ scope: "session-b" },
		);
		await waitUntil(() => order.includes("b-mutation-start"));
		await withExclusiveMutationBarrier(
			async () => {
				order.push("a-run");
			},
			{ scope: "session-a" },
		);
		expect(order).toEqual(["b-mutation-start", "a-run"]);
		gate.resolve();
		await mutation;
	});

	it("an exclusive run still blocks a file mutation inside its own scope", async () => {
		const order: string[] = [];
		const gate = deferred();
		const exclusive = withExclusiveMutationBarrier(
			async () => {
				order.push("run-start");
				await gate.promise;
				order.push("run-end");
			},
			{ scope: "session-same" },
		);
		await waitUntil(() => order.includes("run-start"));
		const mutation = withFileMutationQueue(
			"/tmp/scope-same.txt",
			async () => {
				order.push("mutation");
			},
			undefined,
			{ scope: "session-same" },
		);
		expect(await settled(mutation)).toBe(false);
		gate.resolve();
		await Promise.all([exclusive, mutation]);
		expect(order).toEqual(["run-start", "run-end", "mutation"]);
	});

	it("a batch switch in one scope leaves another scope's announcements pending", async () => {
		const started: string[] = [];
		announceToolCall("b-write", 0, true, "batch-b", "session-b");
		announceToolCall("b-bash", 1, false, "batch-b", "session-b");
		announceToolCall("a-write", 0, true, "batch-a1", "session-a");

		// A new wave in session A retires session A's leftovers only.
		announceToolCall("a2-write", 0, true, "batch-a2", "session-a");

		const bRun = withExclusiveMutationBarrier(
			async () => {
				started.push("b-bash");
			},
			{ holdId: "b-bash", scope: "session-b" },
		);
		expect(await settled(bRun)).toBe(false);
		expect(started).toEqual([]);

		// Session A's own run is free: its earlier-emitted write was retired by A's batch switch.
		const aRun = withExclusiveMutationBarrier(
			async () => {
				started.push("a-bash");
			},
			{ holdId: "a-write", scope: "session-a" },
		);
		await aRun;
		expect(started).toEqual(["a-bash"]);

		retireToolCall("b-write", "session-b");
		await bRun;
		expect(started).toEqual(["a-bash", "b-bash"]);
		retireToolCall("b-bash", "session-b");
		retireToolCall("a2-write", "session-a");
	});

	it("two sessions in one worktree: a wave switch in one leaves the other's announcements pending", async () => {
		const scope = `worktree-shared-${Math.random().toString(36).slice(2)}`;
		announceToolCall("b-write", 0, true, "batch-b", scope, "session-b");
		announceToolCall("b-bash", 1, false, "batch-b", scope, "session-b");
		announceToolCall("a-write", 0, true, "batch-a1", scope, "session-a");
		// Session A moves to its next wave; B's calls are still in flight.
		announceToolCall("a2-write", 0, true, "batch-a2", scope, "session-a");
		const bBash = withExclusiveMutationBarrier(async () => "b-ran", { holdId: "b-bash", scope });
		// B's bash waits for B's earlier write, which is still pending, so it must not have run yet.
		expect(await settled(bBash)).toBe(false);
		retireToolCall("b-write", scope);
		expect(await bBash).toBe("b-ran");
		retireToolCall("b-bash", scope);
		retireToolCall("a2-write", scope);
	});

	it("two sessions in one worktree: emission order is compared only among one session's calls", async () => {
		const scope = `worktree-order-${Math.random().toString(36).slice(2)}`;
		// Session A has a pending write at index 0; session B's bash is index 1 of ITS OWN wave.
		announceToolCall("a-write", 0, true, "batch-a", scope, "session-a");
		announceToolCall("b-bash", 1, false, "batch-b", scope, "session-b");
		const bBash = withExclusiveMutationBarrier(async () => "b-ran", { holdId: "b-bash", scope });
		// A's index-0 write is not "earlier" for B: B's bash runs without waiting for it.
		expect(await bBash).toBe("b-ran");
		retireToolCall("a-write", scope);
		retireToolCall("b-bash", scope);
	});

	it("two sessions in one worktree still interlock: one's exclusive run blocks the other's write", async () => {
		const scope = `worktree-interlock-${Math.random().toString(36).slice(2)}`;
		const gate = deferred();
		const order: string[] = [];
		const run = withExclusiveMutationBarrier(
			async () => {
				order.push("a-run-start");
				await gate.promise;
				order.push("a-run-end");
			},
			{ scope },
		);
		await waitUntil(() => order.includes("a-run-start"));
		const write = withFileMutationQueue(
			path.join(tmpdir(), "pi-scope-b.txt"),
			async () => {
				order.push("b-write");
			},
			undefined,
			{ scope },
		);
		expect(await settled(write)).toBe(false);
		gate.resolve();
		await Promise.all([run, write]);
		expect(order).toEqual(["a-run-start", "a-run-end", "b-write"]);
	});

	it("a retained scope survives until its last holder releases it", () => {
		const key = `worktree-retain-${Math.random().toString(36).slice(2)}`;
		retainMutationLockScope(key);
		retainMutationLockScope(key);
		const scope = getMutationLockScope(key);
		disposeMutationLockScope(key);
		expect(getMutationLockScope(key)).toBe(scope);
		disposeMutationLockScope(key);
		expect(getMutationLockScope(key)).not.toBe(scope);
	});

	it("two scopes writing the same path still serialize through the per-path queue", async () => {
		const order: string[] = [];
		const gate = deferred();
		const target = "/tmp/scope-shared-path.txt";
		const first = withFileMutationQueue(
			target,
			async () => {
				order.push("a-start");
				await gate.promise;
				order.push("a-end");
			},
			undefined,
			{ scope: "session-a" },
		);
		await waitUntil(() => order.includes("a-start"));
		const second = withFileMutationQueue(
			target,
			async () => {
				order.push("b");
			},
			undefined,
			{ scope: "session-b" },
		);
		expect(await settled(second)).toBe(false);
		gate.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["a-start", "a-end", "b"]);
	});

	it("callers that pass no scope share the default scope exactly as before", async () => {
		const order: string[] = [];
		const gate = deferred();
		const exclusive = withExclusiveMutationBarrier(async () => {
			order.push("run-start");
			await gate.promise;
			order.push("run-end");
		});
		await waitUntil(() => order.includes("run-start"));
		const mutation = withFileMutationQueue("/tmp/scope-default.txt", async () => {
			order.push("mutation");
		});
		expect(await settled(mutation)).toBe(false);
		gate.resolve();
		await Promise.all([exclusive, mutation]);
		expect(order).toEqual(["run-start", "run-end", "mutation"]);
	});

	it("the default scope constant names the same scope an unscoped caller uses", async () => {
		const order: string[] = [];
		const gate = deferred();
		const exclusive = withExclusiveMutationBarrier(
			async () => {
				order.push("run-start");
				await gate.promise;
				order.push("run-end");
			},
			{ scope: DEFAULT_MUTATION_SCOPE },
		);
		await waitUntil(() => order.includes("run-start"));
		const mutation = withFileMutationQueue("/tmp/scope-default-constant.txt", async () => {
			order.push("mutation");
		});
		expect(await settled(mutation)).toBe(false);
		gate.resolve();
		await Promise.all([exclusive, mutation]);
		expect(order).toEqual(["run-start", "run-end", "mutation"]);
	});

	it("disposing an idle scope drops it, and a live one only once its last holder leaves", async () => {
		const idle = getMutationLockScope("session-idle");
		disposeMutationLockScope("session-idle");
		expect(getMutationLockScope("session-idle")).not.toBe(idle);

		const live = getMutationLockScope("session-live");
		const gate = deferred();
		const mutation = withFileMutationQueue(
			"/tmp/scope-dispose.txt",
			async () => {
				await gate.promise;
			},
			undefined,
			{ scope: "session-live" },
		);
		await waitUntil(() => !live.idle);
		disposeMutationLockScope("session-live");
		// Dropping it here would hand the next caller a fresh lock while this write is still running.
		expect(getMutationLockScope("session-live")).toBe(live);
		gate.resolve();
		await mutation;
		expect(getMutationLockScope("session-live")).not.toBe(live);
	});
});

describe("mutation scope wiring", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(path.join(tmpdir(), "pi-mutation-scope-"));
		mkdirSync(path.join(cwd, "src"), { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("FileMutationIntentController takes the lock in the scope it was constructed with", async () => {
		const scoped = new FileMutationIntentController({ mutationScope: "session-controller" });
		const foreign = new FileMutationIntentController({ mutationScope: "session-other" });
		const gate = deferred();
		const order: string[] = [];
		const exclusive = withExclusiveMutationBarrier(
			async () => {
				order.push("run-start");
				await gate.promise;
				order.push("run-end");
			},
			{ scope: "session-controller" },
		);
		await waitUntil(() => order.includes("run-start"));

		await foreign.withMutationQueue(path.join(cwd, "src", "foreign.txt"), async () => {
			order.push("foreign-mutation");
		});
		const blocked = scoped.withMutationQueue(path.join(cwd, "src", "scoped.txt"), async () => {
			order.push("scoped-mutation");
		});
		expect(await settled(blocked)).toBe(false);

		gate.resolve();
		await Promise.all([exclusive, blocked]);
		expect(order).toEqual(["run-start", "foreign-mutation", "run-end", "scoped-mutation"]);
	});

	it("a lane's write tool takes its worktree's lock: another worktree's run never blocks it, its own does", async () => {
		const otherCwd = mkdtempSync(path.join(tmpdir(), "pi-mutation-scope-other-"));
		mkdirSync(path.join(otherCwd, "src"), { recursive: true });
		const surfaces: LaneToolSurface[] = [];
		const createLane = (laneCwd: string, shellSessionKey: string): LaneToolSurface => {
			const surface = createLaneToolSurface({
				cwd: laneCwd,
				profile: profile({ tools: { allow: ["write"] } }),
				writeEnabled: true,
				writePaths: ["src"],
				shellSessionKey,
			});
			surfaces.push(surface);
			return surface;
		};
		const laneA = createLane(cwd, "lane-shell-a");
		const laneB = createLane(otherCwd, "lane-shell-b");
		const writeA = laneA.tools.find((tool) => tool.name === "write");
		const writeB = laneB.tools.find((tool) => tool.name === "write");
		if (!writeA || !writeB) throw new Error("Expected lane write tools.");

		const gate = deferred();
		const order: string[] = [];
		// A command run in lane A's worktree (the parent session's `npm run build`, say).
		const exclusive = withExclusiveMutationBarrier(
			async () => {
				order.push("lane-a-run-start");
				await gate.promise;
				order.push("lane-a-run-end");
			},
			{ scope: mutationScopeForWorktree(cwd) },
		);
		await waitUntil(() => order.includes("lane-a-run-start"));

		await writeB.execute("write-b", { path: "src/b.txt", content: "b\n" } as never);
		order.push("lane-b-write");
		const blocked = writeA
			.execute("write-a", { path: "src/a.txt", content: "a\n" } as never)
			.then(() => order.push("lane-a-write"));
		expect(await settled(blocked)).toBe(false);

		gate.resolve();
		await Promise.all([exclusive, blocked]);
		expect(order).toEqual(["lane-a-run-start", "lane-b-write", "lane-a-run-end", "lane-a-write"]);

		for (const surface of surfaces) await surface.dispose();
		rmSync(otherCwd, { recursive: true, force: true });
	});
});
