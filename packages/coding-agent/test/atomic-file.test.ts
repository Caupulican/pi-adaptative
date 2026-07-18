import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { withFileLock, withFileLockSync, writeFileAtomic, writeFileAtomicSync } from "../src/core/util/atomic-file.ts";

/**
 * Shared lock+tmp+rename primitive: every on-disk store that does a read-modify-write now
 * routes through this helper instead of hand-rolling its own (mostly-unlocked, mostly-non-atomic) copy.
 */

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-atomic-file-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomicSync / writeFileAtomic", () => {
	it("writes content, creating the parent directory, and leaves no .tmp file behind", () => {
		const dir = tempDir();
		const filePath = join(dir, "nested", "data.json");
		writeFileAtomicSync(filePath, '{"a":1}');
		expect(readFileSync(filePath, "utf-8")).toBe('{"a":1}');
		expect(existsSync(`${filePath}.tmp`)).toBe(false);
	});

	it("async variant round-trips the same way", async () => {
		const dir = tempDir();
		const filePath = join(dir, "nested", "data.json");
		await writeFileAtomic(filePath, '{"a":2}');
		expect(readFileSync(filePath, "utf-8")).toBe('{"a":2}');
		expect(existsSync(`${filePath}.tmp`)).toBe(false);
	});

	it("a second write fully replaces the first (no partial/torn content)", () => {
		const dir = tempDir();
		const filePath = join(dir, "data.json");
		writeFileAtomicSync(filePath, "x".repeat(10_000));
		writeFileAtomicSync(filePath, "y".repeat(5));
		expect(readFileSync(filePath, "utf-8")).toBe("y".repeat(5));
	});
});

describe("withFileLockSync / withFileLock", () => {
	it("holds an exclusive lock for the duration of the sync callback", () => {
		const dir = tempDir();
		const filePath = join(dir, "data.json");
		let observedContention = false;
		withFileLockSync(filePath, () => {
			expect(() => lockfile.lockSync(filePath, { realpath: false })).toThrow(
				expect.objectContaining({ code: "ELOCKED" }),
			);
			observedContention = true;
		});
		expect(observedContention).toBe(true);

		// Lock released after the callback returns — a fresh acquisition now succeeds immediately.
		const release = lockfile.lockSync(filePath, { realpath: false });
		release();
	});

	it("releases the lock even when the sync callback throws (no lock left held on throw)", () => {
		const dir = tempDir();
		const filePath = join(dir, "data.json");
		expect(() =>
			withFileLockSync(filePath, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");

		const release = lockfile.lockSync(filePath, { realpath: false });
		release();
	});

	it("holds an exclusive lock for the duration of the async callback", async () => {
		const dir = tempDir();
		const filePath = join(dir, "data.json");
		let observedContention = false;
		await withFileLock(filePath, async () => {
			await expect(lockfile.lock(filePath, { realpath: false, retries: 0 })).rejects.toMatchObject({
				code: "ELOCKED",
			});
			observedContention = true;
		});
		expect(observedContention).toBe(true);

		const release = await lockfile.lock(filePath, { realpath: false });
		await release();
	});

	it("releases the lock even when the async callback rejects (no lock left held on throw)", async () => {
		const dir = tempDir();
		const filePath = join(dir, "data.json");
		await expect(
			withFileLock(filePath, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		const release = await lockfile.lock(filePath, { realpath: false });
		await release();
	});

	it("async: two logically-concurrent read-modify-writes never lose an update", async () => {
		const dir = tempDir();
		const filePath = join(dir, "counter.json");
		writeFileAtomicSync(filePath, JSON.stringify({ count: 0 }));

		const bumpOnce = () =>
			withFileLock(
				filePath,
				async () => {
					const current = JSON.parse(readFileSync(filePath, "utf-8")) as { count: number };
					// Force a genuine interleaving window: without the lock, both callers would read the
					// same `current.count` before either writes back.
					await new Promise((resolve) => setTimeout(resolve, 0));
					await writeFileAtomic(filePath, JSON.stringify({ count: current.count + 1 }));
				},
				// 20 promises racing the same lock "at once" queues up to 19-deep; bump retries well past
				// the production default (which assumes realistic 2-3-way contention) so every one of them
				// eventually gets a turn instead of a mid-test ELOCKED — the point under test is that NONE
				// of the eventual acquisitions loses an update, not the retry budget itself.
				{ retries: 60 },
			);

		await Promise.all(Array.from({ length: 20 }, () => bumpOnce()));

		expect((JSON.parse(readFileSync(filePath, "utf-8")) as { count: number }).count).toBe(20);
	});
});

describe("concurrent writers across real OS threads", () => {
	function writeCounterWorker(dir: string): string {
		const atomicFileModule = fileURLToPathLike(new URL("../src/core/util/atomic-file.ts", import.meta.url));
		const workerPath = join(dir, "counter-worker.mjs");
		writeFileSync(
			workerPath,
			`import { withFileLockSync, writeFileAtomicSync } from ${JSON.stringify(atomicFileModule)};
import { existsSync, readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
const { filePath, iterations } = workerData;
for (let i = 0; i < iterations; i++) {
	withFileLockSync(filePath, () => {
		const current = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf-8")).count : 0;
		writeFileAtomicSync(filePath, JSON.stringify({ count: current + 1 }));
	});
}
parentPort.postMessage({ done: true });
`,
			"utf-8",
		);
		return workerPath;
	}

	function fileURLToPathLike(url: URL): string {
		return url.pathname;
	}

	it("two worker threads hammering the same file via withFileLockSync never tear or lose a write", async () => {
		const dir = tempDir();
		const workerPath = writeCounterWorker(dir);
		const filePath = join(dir, "counter.json");
		const iterationsPerWorker = 150;

		const workers = [1, 2].map(
			() => new Worker(pathToFileURL(workerPath), { workerData: { filePath, iterations: iterationsPerWorker } }),
		);
		await Promise.all(
			workers.map(
				(worker) =>
					new Promise<void>((resolve, reject) => {
						worker.on("message", () => resolve());
						worker.on("error", reject);
					}),
			),
		);
		await Promise.all(workers.map((worker) => worker.terminate()));

		// Every increment landed — a torn or lost write would leave the count short of the total.
		const final = JSON.parse(readFileSync(filePath, "utf-8")) as { count: number };
		expect(final.count).toBe(iterationsPerWorker * 2);
	}, 20_000);
});
