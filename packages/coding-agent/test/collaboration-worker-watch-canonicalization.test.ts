/**
 * Collaboration worker CLI: report watcher is handed a non-canonical directory.
 *
 * `subscribeReport` (collaboration-worker.ts:57-72) calls `watch(directory, ...)` on the raw CLI
 * argument. Every other directory watch in this package goes through `canonicalizeWatchDir`
 * (`utils/fs-watch.ts:27`): collaboration/extension.ts:273, collaboration/herdr-runtime.ts:149,
 * delegation/worker-write-reservation.ts:454 and fs-watch.ts's own `watchWithErrorHandler`. This is
 * the only remaining site that does not.
 *
 * That helper exists because of a documented Windows failure mode: libuv's fs-event backend
 * hard-aborts the whole process (`Assertion failed: !_wcsnicmp(filename, dir, dirlen)`) when the
 * watched directory is reached through a non-canonical alias such as an 8.3 short path. The worker's
 * admission check (`resolve(directory) !== join(lease.path, "jobs")`) does not close this: `resolve`
 * normalizes separators and relative segments but never expands a junction, symlink or short name,
 * so an aliased path passes admission and reaches `watch` intact.
 *
 * `node:fs.watch` is stubbed here rather than called: the point is which path the production code
 * hands to the OS boundary, and actually opening a native watcher on an aliased directory is the
 * very thing that would abort the runner on Windows. The alias itself is real - a junction on
 * Windows, a directory symlink elsewhere - via the existing portable helper.
 */
import type * as NodeFs from "node:fs";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCollaborationWorker } from "../src/cli/collaboration-worker.ts";
import { createDirectoryLink } from "./helpers/filesystem-links.ts";

const ports = vi.hoisted(() => ({
	claim: vi.fn(),
	load: vi.fn(),
	finish: vi.fn(),
	backend: vi.fn(),
	execute: vi.fn(),
	stop: vi.fn(),
	release: vi.fn(),
	// Set per test; `vi.hoisted` runs before this file's imports, so it cannot call path helpers here.
	leasePath: { value: "" },
	watchPaths: [] as string[],
	watchCloses: { value: 0 },
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return {
		...actual,
		// Never open a native watcher: on Windows an aliased directory is precisely what aborts libuv.
		watch: vi.fn((path: string) => {
			ports.watchPaths.push(path);
			return {
				close: () => {
					ports.watchCloses.value += 1;
				},
				on: () => undefined,
			};
		}),
	};
});
vi.mock("../src/config.ts", () => ({ getAgentDir: () => "agent" }));
vi.mock("../src/utils/work-directory.ts", () => ({
	acquireWorkRun: () => ({ path: ports.leasePath.value, release: ports.release }),
}));
vi.mock("../src/core/collaboration/herdr-runtime.ts", () => ({ createHerdrBackend: ports.backend }));
vi.mock("../src/core/collaboration/turn-runner.ts", () => ({ executeCollaborationTurn: ports.execute }));
vi.mock("../src/core/collaboration/coordinator.ts", () => ({ stopCollaborationAgent: ports.stop }));
vi.mock("../src/core/collaboration/job-store.ts", () => ({
	CollaborationJobStore: class {
		claimTurn = ports.claim;
		load = ports.load;
		finishTurn = ports.finish;
	},
}));

/** Position of `subscribeReport` in the executeCollaborationTurn call (collaboration-worker.ts:73). */
const SUBSCRIBE_REPORT_ARG_INDEX = 6;

type SubscribeReport = (listener: () => void) => () => void;

const roots: string[] = [];
let exitCode: typeof process.exitCode;

beforeEach(() => {
	exitCode = process.exitCode;
	ports.claim.mockReset().mockReturnValue(true);
	ports.finish.mockReset();
	ports.stop.mockReset().mockResolvedValue(undefined);
	ports.release.mockReset();
	ports.backend.mockReset().mockResolvedValue({});
	ports.watchPaths.length = 0;
	ports.watchCloses.value = 0;
	ports.load.mockReset().mockReturnValue({
		sessionName: "session",
		peerCommand: "pi --collaboration-peer",
		deadlineSeconds: 30,
		agents: [
			{
				id: "agent",
				backendName: "native",
				terminalId: "terminal",
				turnId: "turn",
				status: "running",
				deadlineAt: Date.now() + 30000,
				prompt: "work",
			},
		],
	});
	// Drive the production subscribeReport exactly as the real turn runner does.
	ports.execute.mockReset().mockImplementation(async (...callArgs: unknown[]) => {
		const subscribe = callArgs[SUBSCRIBE_REPORT_ARG_INDEX] as SubscribeReport;
		const unsubscribe = subscribe(() => {});
		unsubscribe();
		return { status: "done", evidence: "verified", usage: { tokens: 1 } };
	});
	vi.spyOn(process, "send").mockImplementation(() => true);
	vi.spyOn(process, "disconnect").mockImplementation(() => {});
});

afterEach(() => {
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

/** A real jobs directory plus a real directory alias pointing at its parent. */
async function aliasedJobsDirectory(): Promise<{ canonical: string; aliased: string; aliasRoot: string }> {
	const base = mkdtempSync(join(tmpdir(), "pi-worker-watch-"));
	roots.push(base);
	const target = join(base, "target");
	const jobs = join(target, "jobs");
	await mkdir(jobs, { recursive: true });
	const aliasRoot = join(base, "alias");
	createDirectoryLink(target, aliasRoot);
	return { canonical: realpathSync.native(jobs), aliased: join(aliasRoot, "jobs"), aliasRoot };
}

describe("collaboration worker report watcher path", () => {
	it("watches the canonical directory when the state root is reached through a directory alias", async () => {
		const { canonical, aliased, aliasRoot } = await aliasedJobsDirectory();
		ports.leasePath.value = aliasRoot;

		await runCollaborationWorker([aliased, "parent", "job", "agent", "turn", "null"]);

		expect(ports.watchPaths).toHaveLength(1);
		expect(ports.watchPaths[0]).toBe(canonical);
	});

	it("negative control: an already-canonical state root is watched unchanged and closed once", async () => {
		const base = mkdtempSync(join(tmpdir(), "pi-worker-watch-canonical-"));
		roots.push(base);
		const root = realpathSync.native(base);
		const jobs = join(root, "jobs");
		await mkdir(jobs, { recursive: true });
		ports.leasePath.value = root;

		await runCollaborationWorker([jobs, "parent", "job", "agent", "turn", "null"]);

		expect(ports.watchPaths).toEqual([jobs]);
		expect(ports.watchCloses.value).toBe(1);
		expect(ports.finish).toHaveBeenCalledTimes(1);
	});
});
