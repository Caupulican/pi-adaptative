import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type WorkerWriteReservationLease,
	WorkerWriteReservationStore,
} from "../src/core/delegation/worker-write-reservation.ts";
import { createDirectoryLink } from "./helpers/filesystem-links.ts";

describe("WorkerWriteReservationStore", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	function fixture(): { agentDir: string; workspace: string; source: string; docs: string; isolated: string } {
		const root = mkdtempSync(join(tmpdir(), "pi-worker-write-reservation-"));
		tempDirs.push(root);
		const workspace = join(root, "workspace");
		const source = join(workspace, "src");
		const docs = join(workspace, "docs");
		const isolated = join(root, "isolated-worktree");
		for (const directory of [source, docs, isolated]) {
			mkdirSync(directory, { recursive: true });
		}
		return { agentDir: join(root, "agent"), workspace, source, docs, isolated };
	}

	function request(
		paths: ReturnType<typeof fixture>,
		overrides: Partial<{
			parentSessionId: string;
			ownerId: string;
			taskId: string;
			attemptId: string;
			fencingToken: number;
			access: "read" | "write";
			writeScopes: string[];
			executionRoot: string;
			isolatedWorktreeId: string;
		}> = {},
	) {
		return {
			parentSessionId: overrides.parentSessionId ?? "parent-1",
			ownerId: overrides.ownerId ?? "pi-worker:123:11111111-1111-4111-8111-111111111111",
			taskId: overrides.taskId ?? "task-1",
			attemptId: overrides.attemptId ?? "attempt-1",
			fencingToken: overrides.fencingToken ?? 1,
			access: overrides.access ?? "write",
			workspace: {
				repositoryRoot: paths.workspace,
				executionRoot: overrides.executionRoot ?? paths.workspace,
				...(overrides.isolatedWorktreeId ? { isolatedWorktreeId: overrides.isolatedWorktreeId } : {}),
			},
			writeScopes: overrides.writeScopes ?? [paths.source],
		};
	}

	function grantedLease(result: ReturnType<WorkerWriteReservationStore["acquire"]>): WorkerWriteReservationLease {
		expect(result.kind).toBe("granted");
		if (result.kind !== "granted" || !result.lease) throw new Error("Expected a write reservation lease.");
		return result.lease;
	}

	it("allows read-only overlap while rejecting overlapping write scopes across store instances", () => {
		const paths = fixture();
		const first = new WorkerWriteReservationStore({ agentDir: paths.agentDir });
		const second = new WorkerWriteReservationStore({ agentDir: paths.agentDir });

		expect(first.acquire(request(paths, { access: "read", taskId: "read-1" }))).toMatchObject({ kind: "granted" });
		const lease = grantedLease(first.acquire(request(paths)));
		expect(second.acquire(request(paths, { taskId: "task-2", attemptId: "attempt-2" }))).toMatchObject({
			kind: "blocked",
			reasonCode: "overlapping_write_scope",
		});
		expect(first.release(lease)).toMatchObject({ kind: "released" });
	});

	it("permits disjoint write scopes in one workspace", () => {
		const paths = fixture();
		const store = new WorkerWriteReservationStore({ agentDir: paths.agentDir });
		grantedLease(store.acquire(request(paths, { writeScopes: [paths.source] })));
		expect(
			store.acquire(request(paths, { taskId: "task-2", attemptId: "attempt-2", writeScopes: [paths.docs] })),
		).toMatchObject({
			kind: "granted",
		});
	});

	it("allows an explicitly separate worktree but rejects an identity that aliases the shared workspace", () => {
		const paths = fixture();
		const store = new WorkerWriteReservationStore({ agentDir: paths.agentDir });
		grantedLease(store.acquire(request(paths)));
		expect(
			store.acquire(
				request(paths, {
					taskId: "task-2",
					attemptId: "attempt-2",
					executionRoot: paths.isolated,
					isolatedWorktreeId: "worktree-2",
					writeScopes: [paths.isolated],
				}),
			),
		).toMatchObject({ kind: "granted" });
		expect(() =>
			store.acquire(
				request(paths, {
					taskId: "invalid",
					attemptId: "invalid",
					isolatedWorktreeId: "pretend-worktree",
				}),
			),
		).toThrow(/execution root/i);
	});

	it("uses resolved scopes and refuses a stale fencing token release after a fresh reservation", () => {
		const paths = fixture();
		const store = new WorkerWriteReservationStore({ agentDir: paths.agentDir });
		const sourceAlias = join(paths.workspace, "source-alias");
		createDirectoryLink(paths.source, sourceAlias);
		const oldLease = grantedLease(store.acquire(request(paths, { writeScopes: [sourceAlias] })));
		expect(store.release(oldLease)).toMatchObject({ kind: "released" });
		const newLease = grantedLease(
			store.acquire(request(paths, { fencingToken: 2, attemptId: "attempt-2", writeScopes: [paths.source] })),
		);
		expect(store.release(oldLease)).toMatchObject({ kind: "stale_fence" });
		expect(
			store.recover({
				workspace: request(paths).workspace,
				evidence: [{ reservationId: newLease.reservationId, state: "live" }],
			}),
		).toMatchObject({
			outcomes: [{ kind: "active", reservationId: newLease.reservationId }],
		});
	});

	it("persists the exact local owner identity and refuses a release forged by another owner", () => {
		const paths = fixture();
		const store = new WorkerWriteReservationStore({ agentDir: paths.agentDir });
		const lease = grantedLease(store.acquire(request(paths)));
		expect(lease.ownerId).toBe("pi-worker:123:11111111-1111-4111-8111-111111111111");

		expect(
			store.release({
				...lease,
				ownerId: "pi-worker:124:22222222-2222-4222-8222-222222222222",
			}),
		).toMatchObject({ kind: "stale_fence" });
		expect(store.release(lease)).toMatchObject({ kind: "released" });
	});

	it("keeps Windows drive and UNC scope comparison case-insensitive through the shared scope helpers", () => {
		const paths = fixture();
		const store = new WorkerWriteReservationStore({ agentDir: paths.agentDir });
		expect(
			store.acquire({
				...request(paths),
				workspace: {
					repositoryRoot: String.raw`C:\Repository`,
					executionRoot: String.raw`c:\repository`,
				},
				writeScopes: [String.raw`C:\Repository\src`],
			}),
		).toMatchObject({ kind: "granted" });
		expect(
			store.acquire({
				...request(paths, { taskId: "task-2", attemptId: "attempt-2" }),
				workspace: {
					repositoryRoot: String.raw`c:\repository`,
					executionRoot: String.raw`C:\REPOSITORY`,
				},
				writeScopes: [String.raw`c:\repository\src\nested`],
			}),
		).toMatchObject({ kind: "blocked", reasonCode: "overlapping_write_scope" });
		expect(
			store.acquire({
				...request(paths, { taskId: "task-3", attemptId: "attempt-3" }),
				workspace: {
					repositoryRoot: String.raw`\\Server\Share\Repository`,
					executionRoot: String.raw`\\server\share\repository`,
				},
				writeScopes: [String.raw`\\SERVER\SHARE\REPOSITORY\src`],
			}),
		).toMatchObject({ kind: "granted" });
	});

	it("fails closed once the bounded durable reservation record limit is reached", () => {
		const paths = fixture();
		const store = new WorkerWriteReservationStore({ agentDir: paths.agentDir });
		for (let index = 0; index < 64; index++) {
			expect(
				store.acquire(
					request(paths, {
						taskId: `task-${index}`,
						attemptId: `attempt-${index}`,
						writeScopes: [join(paths.workspace, `scope-${index}`)],
					}),
				),
			).toMatchObject({ kind: "granted" });
		}
		expect(
			store.acquire(
				request(paths, {
					taskId: "overflow",
					attemptId: "overflow",
					writeScopes: [join(paths.workspace, "scope-overflow")],
				}),
			),
		).toMatchObject({ kind: "blocked", reasonCode: "reservation_capacity_reached" });
	});

	it("keeps only bounded agent-owned state and requires explicit stale recovery release", () => {
		const paths = fixture();
		const store = new WorkerWriteReservationStore({ agentDir: paths.agentDir });
		const lease = grantedLease(store.acquire(request(paths)));
		expect(relative(paths.workspace, lease.filePath).startsWith("..")).toBe(true);
		expect(existsSync(lease.filePath)).toBe(true);
		expect(readFileSync(lease.filePath, "utf-8").length).toBeLessThan(128 * 1024);

		expect(store.recover({ workspace: request(paths).workspace, evidence: [] })).toMatchObject({
			outcomes: [{ kind: "inspection_required", reservationId: lease.reservationId }],
		});
		expect(
			store.recover({
				workspace: request(paths).workspace,
				evidence: [{ reservationId: lease.reservationId, state: "not_live" }],
			}),
		).toMatchObject({ outcomes: [{ kind: "stale", reservationId: lease.reservationId }] });
		expect(existsSync(lease.filePath)).toBe(true);
		expect(store.release(lease)).toMatchObject({ kind: "released" });
		expect(existsSync(lease.filePath)).toBe(false);
	});

	it("fails closed when a persisted owner identity is malformed", () => {
		const paths = fixture();
		const store = new WorkerWriteReservationStore({ agentDir: paths.agentDir });
		const lease = grantedLease(store.acquire(request(paths)));
		const stored = JSON.parse(readFileSync(lease.filePath, "utf-8")) as {
			reservations: Array<Record<string, unknown>>;
		};
		stored.reservations[0]!.ownerId = "not-a-local-owner";
		// The next admission parses the existing durable record before making a side effect.
		// Direct fixture mutation is isolated under the temporary agent state directory.
		writeFileSync(lease.filePath, `${JSON.stringify(stored)}\n`, "utf-8");
		expect(() => store.acquire(request(paths, { taskId: "second", attemptId: "second" }))).toThrow(/owner/i);
	});

	it("notifies availability on an explicit release and stops after disposal", async () => {
		const paths = fixture();
		const store = new WorkerWriteReservationStore({ agentDir: paths.agentDir });
		const first = grantedLease(store.acquire(request(paths)));
		let notifications = 0;
		const dispose = store.watchAvailability(request(paths).workspace, () => {
			notifications += 1;
		});
		expect(store.release(first)).toMatchObject({ kind: "released" });
		await vi.waitFor(() => expect(notifications).toBeGreaterThan(0));
		dispose();
		const seenBeforeDispose = notifications;
		const second = grantedLease(store.acquire(request(paths, { attemptId: "attempt-2", fencingToken: 2 })));
		expect(store.release(second)).toMatchObject({ kind: "released" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(notifications).toBe(seenBeforeDispose);
	});

	it("wakes queued admission for Windows null and Buffer watcher filenames", async () => {
		const paths = fixture();
		let watcherListener: ((eventType: string, fileName: string | Buffer | null) => void) | undefined;
		const close = vi.fn();
		const store = new WorkerWriteReservationStore({
			agentDir: paths.agentDir,
			watchDirectory: (_directory, _options, listener) => {
				watcherListener = listener;
				return { close } as never;
			},
		});
		const notifications: string[] = [];
		let disposeFirst!: () => void;
		const firstWake = new Promise<void>((resolve) => {
			disposeFirst = store.watchAvailability(request(paths).workspace, () => {
				notifications.push("wake");
				resolve();
			});
		});
		if (!watcherListener) throw new Error("Expected injected watcher listener.");

		watcherListener("rename", null);
		await firstWake;
		disposeFirst();

		const lease = grantedLease(store.acquire(request(paths)));
		const secondWake = new Promise<void>((resolve) => {
			const dispose = store.watchAvailability(request(paths).workspace, () => {
				notifications.push("buffer");
				dispose();
				resolve();
			});
		});
		watcherListener("change", Buffer.from("irrelevant.json"));
		// The store filename is hashed; a matching Buffer basename is obtained from its own lease path.
		watcherListener("change", Buffer.from(lease.filePath.split(/[/\\]/).at(-1) ?? ""));
		await secondWake;

		expect(notifications).toEqual(["wake", "buffer"]);
		expect(close).toHaveBeenCalled();
	});
});
