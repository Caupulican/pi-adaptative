import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLaneToolSurface, type LaneToolSurface } from "../src/core/autonomy/lane-tool-surface.ts";
import type { SessionConfinement } from "../src/core/autonomy/session-confinement.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { relocatedInto, WorkerLaneIsolation } from "../src/core/delegation/worker-lane-isolation.ts";
import { workerCeilingOf } from "../src/core/delegation/worker-parent-ceiling.ts";
import type { ExecutionGrant, ToolCapabilityManifest } from "../src/core/orchestration/contracts.ts";
import { releaseLane, type WorktreeSyncEngineDeps } from "../src/core/worktree-sync/git-engine.ts";
import { readLane, syncStorePaths, writeLane } from "../src/core/worktree-sync/store.ts";
import { findLaneByDirectory } from "../src/core/worktree-sync/worker-lane.ts";
import { AgentToolPolicyDeniedError, type ExecutionContext } from "../src/kernel/index.ts";

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

			// Only one successor may acquire the source's dirty checkout. Its predecessor's delayed
			// release and an unused-lane cleanup that previously saw no owner must both leave it intact.
			const marker = join(nested, "pending.txt");
			writeFileSync(marker, "pending edit");
			const successors = ["worker-b", "worker-c"];
			const transfers = await Promise.allSettled(successors.map((id) => isolation.transfer(nested, "worker-a", id)));
			expect(transfers.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const successor = successors[transfers.findIndex((result) => result.status === "fulfilled")]!;
			await isolation.transfer(nested, "worker-a", successor);
			expect(await isolation.release(nested, "worker-a", "attempt-a")).toMatchObject({ kind: "superseded" });
			expect(
				await releaseLane(depsForTopLevel(laneRoot), { laneKey: lane.laneKey, expectBoundLaneId: null }),
			).toMatchObject({ code: "lane_bound_elsewhere" });
			expect(await readLane(syncStorePaths(common), lane.laneKey)).toMatchObject({
				status: "active",
				boundLaneId: successor,
			});
			expect(await isolation.claimFinding(nested, "worker-a")).toBeUndefined();
			expect((await isolation.claimFinding(nested, successor))?.text).toContain(laneRoot);
			expect(readFileSync(marker, "utf8")).toBe("pending edit");
			await isolation.transfer(nested, successor, "worker-a");
			expect((await readLane(syncStorePaths(common), lane.laneKey))?.boundLaneId).toBe("worker-a");
			expect(notices).toHaveLength(1);

			const gitDir = join(common, "worktrees", "lane-a");
			mkdirSync(gitDir, { recursive: true });
			writeFileSync(join(gitDir, "commondir"), "../..");
			writeFileSync(join(laneRoot, ".git"), `gitdir: ${gitDir}\n`);
			const relocatedRoot = new WorkerLaneIsolation({
				engineDeps: () => ({ ...depsForTopLevel(laneRoot), worktreesBaseDir: join(temp, "new-lanes") }),
				isolateByDefault: () => false,
				notifyParent: () => {},
				warn: () => {},
			});
			await expect(relocatedRoot.transfer(nested, "worker-a", "worker-d")).rejects.toThrow(
				"configured worktree root",
			);
			expect((await readLane(syncStorePaths(common), lane.laneKey))?.boundLaneId).toBe("worker-a");
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});

describe("the scope lent by an SDK owner session", () => {
	const tools = ["read", "write", "edit"];
	const base = { deniedPaths: [], credentialExposure: "deny" as const, shellEnvironment: () => ({}) };
	const source = (confinement: SessionConfinement) => ({
		getSessionConfinement: () => confinement,
		getForegroundToolNames: () => tools,
		getCapabilityEnvelope: () => undefined,
	});

	it("preserves host reach for an unconfined owner", () => {
		expect(workerCeilingOf({ lendsOwnerReach: true }, source(base))).toBe("unbounded");
	});

	it("holds child grants to explicit read and write roots and process capabilities", () => {
		const scope = {
			...base,
			readScope: { cwd: root, readRoots: [root], deniedPaths: [outside] },
			writeRoots: [root],
			deniedPaths: [outside],
		};
		const ceiling = workerCeilingOf({ lendsOwnerReach: true }, source(scope));
		expect(ceiling).toMatchObject({ readRoots: [root], writeRoots: [root], deniedPaths: [outside] });
		expect(ceiling !== "unbounded" && ceiling.capabilities.includes("process.exec")).toBe(false);
	});
});

describe("worker read counterpart guidance", () => {
	async function withLane(
		confined: boolean,
		check: (fixture: { source: string; lane: string; cwd: string; surface: LaneToolSurface }) => Promise<void>,
	): Promise<void> {
		const temp = mkdtempSync(join(tmpdir(), "pi-worker-read-counterpart-"));
		const source = join(temp, "parent");
		const lane = join(temp, "lane");
		const cwd = join(lane, "src", "nested");
		for (const directory of [join(source, "src"), cwd]) mkdirSync(directory, { recursive: true });
		writeFileSync(join(source, "src", "owned.ts"), "parent-checkout-content\n");
		writeFileSync(join(lane, "src", "owned.ts"), "worker-copy-content\n");
		const deniedPaths = [join(source, "source-private.txt"), join(lane, "lane-private.txt")];
		const tools = ["read", "write", "edit"];
		const grant: ExecutionGrant = {
			schemaVersion: 1,
			grantId: "worker-read-counterpart",
			objectiveId: "objective",
			taskId: "task",
			attemptId: "attempt",
			subjectId: "worker",
			role: "implementer",
			capabilities: ["filesystem.read", "filesystem.write"],
			allowedTools: tools,
			resources: [],
			readPaths: [lane],
			writePaths: [lane],
			deniedPaths,
			budget: { maxToolCalls: 20 },
			policyVersion: "fixture",
			decisionTrace: [],
			issuedAt: "2026-01-01T00:00:00.000Z",
		};
		const manifests: ToolCapabilityManifest[] = tools.map((toolName) => ({
			toolName,
			moduleSpecifier: `builtin:${toolName}`,
			capabilities: [toolName === "read" ? "filesystem.read" : "filesystem.write"],
			roles: ["implementer"],
			enforcements: ["path-scope"],
		}));
		const surface = createLaneToolSurface({
			cwd,
			grant,
			toolManifests: manifests,
			writeEnabled: true,
			writePaths: [lane],
			deniedPaths,
			...(confined ? { readScopeRoots: [lane] } : {}),
			laneReadCounterpart: (target) => relocatedInto(source, lane, target),
		});
		try {
			await check({ source, lane, cwd, surface });
		} finally {
			await surface.dispose();
			rmSync(temp, { recursive: true, force: true });
		}
	}

	it.each([true, false])("retries the worker copy from nested cwd, with read confinement %s", async (confined) => {
		await withLane(confined, async ({ source, lane, cwd, surface }) => {
			const read = surface.tools.find((tool) => tool.name === "read")!;
			const original = join(source, "src", "owned.ts");
			const retry = path.relative(cwd, join(lane, "src", "owned.ts"));
			const refusal = await surface.admitHostCall("read", { path: original });
			expect(refusal).toMatchObject({ block: true });
			expect(refusal?.correction).toContain(`retry read with path ${JSON.stringify(retry)}`);
			await expect(read.execute("original", { path: original })).rejects.toMatchObject({
				name: "AgentToolPolicyDeniedError",
				correction: refusal?.correction,
			});
			expect(await surface.admitHostCall("read", { path: retry })).toBeUndefined();
			const result = await read.execute("retry", { path: retry });
			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			expect(text).toContain("worker-copy-content");
			expect(text).not.toContain("parent-checkout-content");
			expect(readFileSync(original, "utf8")).toBe("parent-checkout-content\n");
		});
	});

	it.each(["source-private", "lane-private", "missing", "symlink-escape", "unrelated", "write", "edit"] as const)(
		"keeps %s refused without a counterpart hint",
		async (kind) => {
			await withLane(true, async ({ source, lane, surface }) => {
				let target = join(source, "src", "owned.ts");
				let toolName = "read";
				if (kind === "source-private") {
					target = join(source, "source-private.txt");
					writeFileSync(target, "source-private-content");
					writeFileSync(join(lane, "source-private.txt"), "mapped-public-copy");
				} else if (kind === "lane-private") {
					target = join(source, "lane-private.txt");
					writeFileSync(target, "source-public-copy");
					writeFileSync(join(lane, "lane-private.txt"), "worker-private-content");
				} else if (kind === "missing") {
					target = join(source, "missing.txt");
					writeFileSync(target, "only-present-in-parent");
				} else if (kind === "symlink-escape") {
					target = join(source, "linked.txt");
					writeFileSync(target, "parent-link-name");
					symlinkSync(join(source, "src", "owned.ts"), join(lane, "linked.txt"), "file");
				} else if (kind === "unrelated") {
					target = join(path.dirname(source), "unrelated.txt");
					writeFileSync(target, "unrelated-content");
				} else if (kind === "write" || kind === "edit") {
					toolName = kind;
				}
				const args = { path: target, content: "refused replacement", oldText: "parent", newText: "changed" };
				const refusal = await surface.admitHostCall(toolName, args);
				expect(refusal).toMatchObject({ block: true });
				expect(refusal?.correction).toBeUndefined();
				expect(refusal?.reason).not.toContain("retry read");
				const tool = surface.tools.find((candidate) => candidate.name === toolName)!;
				const error = await tool.execute(`refused-${kind}`, args).catch((error: unknown) => error);
				expect(error).toBeInstanceOf(AgentToolPolicyDeniedError);
				expect((error as AgentToolPolicyDeniedError).correction).toBeUndefined();
				expect(readFileSync(join(source, "src", "owned.ts"), "utf8")).toBe("parent-checkout-content\n");
				expect(readFileSync(join(lane, "src", "owned.ts"), "utf8")).toBe("worker-copy-content\n");
			});
		},
	);
});
