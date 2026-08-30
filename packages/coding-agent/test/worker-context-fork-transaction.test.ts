import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { workerContextForkFile } from "../src/core/agent-paths.ts";
import {
	WorkerContextForkStore,
	WorkerContextForkStoreError,
} from "../src/core/delegation/worker-context-fork-store.ts";
import type { WorkerContextForkReference } from "../src/core/orchestration/worker-context-fork-reference.ts";

const tempDirectories: string[] = [];
const workerContextForkStoreModuleUrl = new URL("../src/core/delegation/worker-context-fork-store.ts", import.meta.url)
	.href;

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(parentSessionId = "parent-session"): {
	agentDir: string;
	parentSessionId: string;
	store: WorkerContextForkStore;
} {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-fork-transaction-"));
	tempDirectories.push(agentDir);
	return {
		agentDir,
		parentSessionId,
		store: new WorkerContextForkStore({ agentDir, parentSessionId }),
	};
}

function user(text: string, timestamp = 1): UserMessage {
	return { role: "user", content: text, timestamp };
}

function snapshotFile(
	agentDir: string,
	parentSessionId: string,
	reference: Pick<WorkerContextForkReference, "identityDigest" | "contentDigest">,
): string {
	return workerContextForkFile(agentDir, parentSessionId, reference.identityDigest, reference.contentDigest);
}

function expectStoreCode(fn: () => unknown, code: WorkerContextForkStoreError["code"]): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(WorkerContextForkStoreError);
		expect((error as WorkerContextForkStoreError).code).toBe(code);
		return;
	}
	throw new Error(`Expected WorkerContextForkStoreError '${code}'.`);
}

function readReferences(filePath: string): WorkerContextForkReference[] {
	const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
	if (!Array.isArray(parsed)) throw new Error("Expected a durable reference array.");
	return parsed as WorkerContextForkReference[];
}

describe("WorkerContextForkStore capture transaction", () => {
	it("rolls back a new capture on prepare failure so changed context can retry", () => {
		const { agentDir, parentSessionId, store } = fixture();
		let failedReference: WorkerContextForkReference | undefined;

		expect(() =>
			store.captureAndPrepare({
				logicalAgentId: "reviewer",
				messages: [user("first context")],
				readDurableReferences: () => [],
				prepare(reference) {
					failedReference = reference;
					expect(store.open({ logicalAgentId: "reviewer", reference }).messages).toEqual([user("first context")]);
					throw new Error("prepare rejected");
				},
			}),
		).toThrow("prepare rejected");
		if (!failedReference) throw new Error("Expected capture before prepare.");
		expect(existsSync(snapshotFile(agentDir, parentSessionId, failedReference))).toBe(false);

		const retried = store.captureAndPrepare({
			logicalAgentId: "reviewer",
			messages: [user("changed context", 2)],
			readDurableReferences: () => [],
			prepare: (reference) => ({ acceptedReference: reference }),
		});
		expect(retried.value.acceptedReference).toEqual(retried.reference);
		expect(store.open({ logicalAgentId: "reviewer", reference: retried.reference }).messages).toEqual([
			user("changed context", 2),
		]);
	});

	it("reclaims a crash orphan on restart before installing changed context", () => {
		const { agentDir, parentSessionId, store } = fixture("restart-parent");
		const orphan = store.capture({ logicalAgentId: "implementer", messages: [user("orphaned context")] });
		const orphanFile = snapshotFile(agentDir, parentSessionId, orphan);
		expect(existsSync(orphanFile)).toBe(true);

		const restarted = new WorkerContextForkStore({ agentDir, parentSessionId });
		const transaction = restarted.captureAndPrepare({
			logicalAgentId: "implementer",
			messages: [user("fresh context", 2)],
			readDurableReferences: () => [],
			prepare: (reference) => reference.contentDigest,
		});

		expect(transaction.value).toBe(transaction.reference.contentDigest);
		expect(existsSync(orphanFile)).toBe(false);
		expect(existsSync(snapshotFile(agentDir, parentSessionId, transaction.reference))).toBe(true);
	});

	it("preserves a new snapshot when prepare durably references it before throwing", () => {
		const { agentDir, parentSessionId, store } = fixture("committed-failure-parent");
		let durableReferences: WorkerContextForkReference[] = [];
		let committedReference: WorkerContextForkReference | undefined;

		expect(() =>
			store.captureAndPrepare({
				logicalAgentId: "verifier",
				messages: [user("committed before late failure")],
				readDurableReferences: () => durableReferences,
				prepare(reference) {
					committedReference = reference;
					durableReferences = [structuredClone(reference)];
					throw new Error("post-commit failure");
				},
			}),
		).toThrow("post-commit failure");
		if (!committedReference) throw new Error("Expected a committed reference.");
		expect(existsSync(snapshotFile(agentDir, parentSessionId, committedReference))).toBe(true);
		expect(store.open({ logicalAgentId: "verifier", reference: committedReference }).messages).toEqual([
			user("committed before late failure"),
		]);
	});

	it("adopts exact referenced replay but preserves a referenced identity on conflicting context", () => {
		const { agentDir, parentSessionId, store } = fixture("referenced-parent");
		const referenced = store.capture({ logicalAgentId: "explorer", messages: [user("durable context")] });
		const referencedFile = snapshotFile(agentDir, parentSessionId, referenced);
		const inode = statSync(referencedFile).ino;
		let prepareCalls = 0;

		const replay = store.captureAndPrepare({
			logicalAgentId: "explorer",
			messages: [user("durable context")],
			readDurableReferences: () => [referenced],
			prepare(reference) {
				prepareCalls += 1;
				return reference;
			},
		});
		expect(replay.reference).toEqual(referenced);
		expect(replay.value).toEqual(referenced);
		expect(statSync(referencedFile).ino).toBe(inode);

		expectStoreCode(
			() =>
				store.captureAndPrepare({
					logicalAgentId: "explorer",
					messages: [user("conflicting context", 2)],
					readDurableReferences: () => [referenced],
					prepare() {
						prepareCalls += 1;
						return undefined;
					},
				}),
			"identity_conflict",
		);
		expect(prepareCalls).toBe(1);
		expect(existsSync(referencedFile)).toBe(true);
		expect(readdirSync(join(referencedFile, ".."))).toEqual(
			expect.arrayContaining([expect.stringMatching(/\.json$/)]),
		);
	});

	it("serializes cross-process reclamation until the first prepare publishes its durable reference", async () => {
		const { agentDir, parentSessionId, store } = fixture("concurrent-parent");
		const durableReferencesFile = join(agentDir, "durable-references.json");
		writeFileSync(durableReferencesFile, "[]", "utf-8");
		const workerFile = join(agentDir, "capture-worker.mjs");
		writeFileSync(
			workerFile,
			`import { writeFileSync } from "node:fs";
import { WorkerContextForkStore } from ${JSON.stringify(workerContextForkStoreModuleUrl)};
const options = ${JSON.stringify({ agentDir, parentSessionId, durableReferencesFile })};
const store = new WorkerContextForkStore(options);
store.captureAndPrepare({
	logicalAgentId: "worker",
	messages: [{ role: "user", content: "first concurrent context", timestamp: 1 }],
	readDurableReferences: () => [],
	prepare(reference) {
		process.stdout.write(JSON.stringify({ phase: "prepare-entered", reference }) + "\\n");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
		writeFileSync(options.durableReferencesFile, JSON.stringify([reference]), "utf-8");
		return undefined;
	},
});
`,
			"utf-8",
		);

		// The worker imports `src/*.ts` directly, so it needs the source export condition. Without it
		// Node resolves `@caupulican/pi-agent-core/paths` to `dist/utils/paths.js`, which only exists
		// on a machine that has built the package — the test would pass there and fail on a clean
		// checkout with ERR_MODULE_NOT_FOUND.
		const worker = spawn(process.execPath, ["--conditions=pi-source", workerFile], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		worker.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf-8")}`.slice(-4096);
		});
		const completed = new Promise<void>((resolve, reject) => {
			worker.once("error", reject);
			worker.once("exit", (code) =>
				code === 0 ? resolve() : reject(new Error(`Capture process exited ${code}: ${stderr}`)),
			);
		});
		let firstReference: WorkerContextForkReference | undefined;
		await new Promise<void>((resolve, reject) => {
			let stdout = "";
			worker.stdout.on("data", (chunk: Buffer) => {
				stdout = `${stdout}${chunk.toString("utf-8")}`;
				const line = stdout.split("\n").find((candidate) => candidate.trim());
				if (!line) return;
				const record = JSON.parse(line) as { phase?: unknown; reference?: unknown };
				if (record.phase !== "prepare-entered") return;
				firstReference = record.reference as WorkerContextForkReference;
				resolve();
			});
			completed.catch(reject);
		});

		expectStoreCode(
			() =>
				store.captureAndPrepare({
					logicalAgentId: "worker",
					messages: [user("second concurrent context", 2)],
					readDurableReferences: () => readReferences(durableReferencesFile),
					prepare: () => undefined,
				}),
			"identity_conflict",
		);
		await completed;
		if (!firstReference) throw new Error("Expected the first transaction reference.");
		expect(readReferences(durableReferencesFile)).toEqual([firstReference]);
		expect(store.open({ logicalAgentId: "worker", reference: firstReference }).messages).toEqual([
			user("first concurrent context"),
		]);
	});

	it("rejects an identical concurrently claimed identity under the lock so the caller can mint the next agent", async () => {
		const { agentDir, parentSessionId, store } = fixture("identical-concurrent-parent");
		const claimedFile = join(agentDir, "worker-claimed");
		const workerFile = join(agentDir, "identical-capture-worker.mjs");
		writeFileSync(
			workerFile,
			`import { existsSync, writeFileSync } from "node:fs";
import { WorkerContextForkStore } from ${JSON.stringify(workerContextForkStoreModuleUrl)};
const options = ${JSON.stringify({ agentDir, parentSessionId, claimedFile })};
const store = new WorkerContextForkStore(options);
store.captureAndPrepare({
	logicalAgentId: "worker-1",
	messages: [{ role: "user", content: "identical concurrent context", timestamp: 1 }],
	readDurableReferences: () => [],
	isLogicalIdentityClaimed: () => existsSync(options.claimedFile),
	prepare() {
		process.stdout.write("prepare-entered\\n");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
		writeFileSync(options.claimedFile, "claimed", "utf-8");
	},
});
`,
			"utf-8",
		);

		// The worker imports `src/*.ts` directly, so it needs the source export condition. Without it
		// Node resolves `@caupulican/pi-agent-core/paths` to `dist/utils/paths.js`, which only exists
		// on a machine that has built the package — the test would pass there and fail on a clean
		// checkout with ERR_MODULE_NOT_FOUND.
		const worker = spawn(process.execPath, ["--conditions=pi-source", workerFile], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		worker.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf-8")}`.slice(-4096);
		});
		const completed = new Promise<void>((resolve, reject) => {
			worker.once("error", reject);
			worker.once("exit", (code) =>
				code === 0 ? resolve() : reject(new Error(`Capture process exited ${code}: ${stderr}`)),
			);
		});
		await new Promise<void>((resolve, reject) => {
			worker.stdout.on("data", (chunk: Buffer) => {
				if (chunk.toString("utf-8").includes("prepare-entered")) resolve();
			});
			completed.catch(reject);
		});

		let duplicatePrepareCalls = 0;
		expectStoreCode(
			() =>
				store.captureAndPrepare({
					logicalAgentId: "worker-1",
					messages: [user("identical concurrent context")],
					readDurableReferences: () => [],
					isLogicalIdentityClaimed: () => existsSync(claimedFile),
					prepare: () => {
						duplicatePrepareCalls += 1;
					},
				}),
			"identity_claimed",
		);
		expect(duplicatePrepareCalls).toBe(0);
		const next = store.captureAndPrepare({
			logicalAgentId: "worker-2",
			messages: [user("identical concurrent context")],
			readDurableReferences: () => [],
			isLogicalIdentityClaimed: () => false,
			prepare: (reference) => reference,
		});
		expect(next.value.identityDigest).toBe(next.reference.identityDigest);
		await completed;
		expect(store.open({ logicalAgentId: "worker-2", reference: next.reference }).messages).toEqual([
			user("identical concurrent context"),
		]);
	});
});
