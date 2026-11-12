import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { WorkerLaneIsolation } from "../src/core/delegation/worker-lane-isolation.ts";
import type { WorktreeSyncEngineDeps } from "../src/core/worktree-sync/git-engine.ts";
import { readLane, syncStorePaths, writeLane } from "../src/core/worktree-sync/store.ts";
import { findLaneByDirectory } from "../src/core/worktree-sync/worker-lane.ts";
import type { ExecutionContext } from "../src/kernel/index.ts";

const isolation = new WorkerLaneIsolation({
	engineDeps: () => undefined,
	isolateByDefault: () => false,
	notifyParent: () => {},
	warn: () => {},
});

const root = path.resolve(tmpdir(), "pi-lane-relocation-root");
const lane = join(root, ".pi", "worker-lanes", "lane-a");
const outside = path.resolve(tmpdir(), "pi-lane-relocation-outside");
const context = { cwd: lane } as ExecutionContext;

function relocated(path: string): string | undefined {
	const request: Pick<WorkerDelegationRequest, "authority" | "savedIntent"> = { authority: { path } };
	return isolation.relocateRequest(request, root, context).authority?.path;
}

describe("worker lane request relocation", () => {
	it.each([
		["src", join(lane, "src")],
		[join(root, "src"), join(lane, "src")],
		[join(root, "src", "nested"), join(lane, "src", "nested")],
		[outside, outside],
	])("moves authority path %s to %s when it is inside the source workspace", (path, expected) => {
		expect(relocated(path)).toBe(expected);
	});

	it("keeps an outside workspace path outside the lane for the admission containment check", () => {
		const relocatedOutside = relocated(outside);
		expect(relocatedOutside).toBe(outside);
		expect(isolation.isInsideLane(lane, relocatedOutside!)).toBe(false);
	});

	it("relocates the workspace path and each extra write path with the same root mapping", () => {
		const request: Pick<WorkerDelegationRequest, "authority" | "savedIntent"> = {
			authority: { path: "src", writePaths: ["src/a.ts", "other/b.ts", outside] },
		};
		expect(isolation.relocateRequest(request, root, context).authority).toEqual({
			path: join(lane, "src"),
			writePaths: [join(lane, "src", "a.ts"), join(lane, "other", "b.ts"), outside],
		});
	});

	it("uses the lane root when re-admitting from a nested workspace context", () => {
		const request: Pick<WorkerDelegationRequest, "authority" | "savedIntent"> = {
			authority: { path: join(root, "src"), writePaths: ["src/generated"] },
		};
		const nestedContext = { cwd: join(lane, "src") } as ExecutionContext;

		expect(isolation.relocateRequest(request, root, nestedContext, lane).authority).toEqual({
			path: join(lane, "src"),
			writePaths: [join(lane, "src", "generated")],
		});
	});
});

describe("worker lane lookup from a nested workspace", () => {
	it("resolves through the containing registered worktree and does not cross a nested repository", async () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-worker-lane-lookup-"));
		try {
			const hub = join(temp, "hub");
			const laneRoot = join(temp, "lanes", "lane-a");
			const nested = join(laneRoot, "src");
			const common = join(hub, ".git");
			mkdirSync(nested, { recursive: true });
			mkdirSync(common, { recursive: true });
			const lane = {
				laneKey: "lane-a",
				branch: "pi/wt/lane-a",
				worktreePath: laneRoot,
				status: "active" as const,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			};
			await writeLane(syncStorePaths(common), lane);

			const depsForTopLevel = (topLevel: string, dirty = false): WorktreeSyncEngineDeps => ({
				cwd: nested,
				worktreesBaseDir: join(temp, "lanes"),
				options: { maxLanes: 4 },
				exec: async (_command, args) => {
					const stdout =
						args[0] === "rev-parse" && args.includes("--show-toplevel")
							? `${topLevel}\n${common}\n`
							: args[0] === "rev-parse" && args[1] === "--verify"
								? "abc123\n"
								: args[0] === "worktree" && args[1] === "list"
									? `worktree ${hub}\nbranch refs/heads/main\n`
									: args[0] === "rev-list"
										? "0 1\n"
										: args[0] === "status" && dirty
											? " M file.txt\n"
											: "";
					return {
						stdout,
						stderr: "",
						code: 0,
						killed: false,
						stdoutTruncated: false,
						stderrTruncated: false,
					};
				},
			});

			expect(await findLaneByDirectory(depsForTopLevel(laneRoot), nested)).toEqual(lane);
			expect(await findLaneByDirectory(depsForTopLevel(nested), nested)).toBeUndefined();
			const isolationFor = (topLevel: string) =>
				new WorkerLaneIsolation({
					engineDeps: () => depsForTopLevel(topLevel),
					isolateByDefault: () => false,
					notifyParent: () => {},
					warn: () => {},
				});
			expect(await isolationFor(laneRoot).laneRootAt(nested)).toBe(laneRoot);
			expect(await isolationFor(nested).laneRootAt(nested)).toBeUndefined();

			const notices: string[] = [];
			const isolation = new WorkerLaneIsolation({
				engineDeps: () => depsForTopLevel(laneRoot, true),
				isolateByDefault: () => false,
				notifyParent: (text) => notices.push(text),
				warn: () => {},
			});
			await isolation.bind(nested, "worker-a");
			expect((await readLane(syncStorePaths(common), lane.laneKey))?.boundLaneId).toBe("worker-a");
			expect((await isolation.claimFinding(nested, "worker-a"))?.text).toContain(lane.worktreePath);
			expect(await isolation.release(nested, "worker-a", "attempt-a")).toMatchObject({ kind: "abandoned" });
			expect((await readLane(syncStorePaths(common), lane.laneKey))?.status).toBe("active");
			expect(notices).toHaveLength(1);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});
