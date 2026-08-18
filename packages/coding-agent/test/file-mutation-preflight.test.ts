import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import {
	FileMutationIntentController,
	localFileMutationIntentOperations,
} from "../src/core/tools/file-mutation-intent.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

interface CompletedMutationDetails {
	contentRef?: string;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		throw new Error("Expected operation to reject.");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function retainedPayloadRef(message: string): string {
	const match = message.match(/\bfile-mutation:[0-9a-f-]+\b/i);
	if (!match) throw new Error(`Expected retained mutation payload reference in: ${message}`);
	return match[0];
}

describe("file mutation preflight", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-file-preflight-${process.pid}-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("publishes single-call mutation schemas without harness-owned preparation fields", () => {
		const write = createWriteTool(testDir);
		const edit = createEditTool(testDir);
		const validate = (tool: typeof write | typeof edit, id: string, args: Record<string, unknown>) =>
			validateToolArguments(
				tool,
				{ type: "toolCall", id, name: tool.name, arguments: args },
				{ repairEnabled: false },
			);

		expect(validate(write, "write-content", { path: "new.txt", content: "one" })).toMatchObject({
			path: "new.txt",
			content: "one",
		});
		expect(
			validate(write, "write-retarget", {
				path: "renamed.txt",
				payloadRef: "file-mutation:123e4567-e89b-12d3-a456-426614174000",
			}),
		).toMatchObject({ path: "renamed.txt" });
		expect(
			validate(edit, "edit-replacement", {
				path: "existing.txt",
				edits: [{ oldText: "before", newText: "after" }],
			}),
		).toMatchObject({ path: "existing.txt" });
		expect(
			validate(edit, "edit-retarget", {
				path: "corrected.txt",
				payloadRef: "file-mutation:123e4567-e89b-12d3-a456-426614174000",
			}),
		).toMatchObject({ path: "corrected.txt" });
		expect(() =>
			validate(write, "write-leaked-harness-fields", {
				path: "new.txt",
				intentId: "intent",
				action: "write",
				content: "one",
			}),
		).toThrow();
		expect(() =>
			validate(edit, "edit-leaked-harness-fields", {
				path: "existing.txt",
				intentId: "intent",
				action: "edit",
				edits: [{ oldText: "before", newText: "after" }],
			}),
		).toThrow();
	});

	it("preflights an existing write target before invoking the mutation operation", async () => {
		const path = join(testDir, "owned.txt");
		writeFileSync(path, "original", "utf8");
		let createCalls = 0;
		const intentController = new FileMutationIntentController();
		const tool = createWriteTool(testDir, {
			operations: {
				mkdir: async () => {},
				createFile: async () => {
					createCalls++;
				},
			},
			intentController,
		});

		await expect(tool.execute("write-existing", { path, content: "replacement" })).rejects.toThrow(
			/already exists|collision/i,
		);
		expect(createCalls).toBe(0);
		expect(readFileSync(path, "utf8")).toBe("original");
	});

	it("retains a valid write payload after a name collision so only the target must be corrected", async () => {
		const collidedPath = join(testDir, "occupied.txt");
		const correctedPath = join(testDir, "available.txt");
		writeFileSync(collidedPath, "original", "utf8");
		const tool = createWriteTool(testDir);

		const collision = await rejectionMessage(
			tool.execute("write-collision", { path: collidedPath, content: "generated once\n" }),
		);
		const payloadRef = retainedPayloadRef(collision);
		expect(collision).toContain("only a corrected path");

		await tool.execute("write-retarget", { path: correctedPath, payloadRef } as never);

		expect(readFileSync(collidedPath, "utf8")).toBe("original");
		expect(readFileSync(correctedPath, "utf8")).toBe("generated once\n");
	});

	it("preflights a missing edit target before invoking read or write operations", async () => {
		const path = join(testDir, "missing.txt");
		let operationCalls = 0;
		const intentController = new FileMutationIntentController();
		const tool = createEditTool(testDir, {
			operations: {
				readFile: async () => {
					operationCalls++;
					return Buffer.from("");
				},
				writeFile: async () => {
					operationCalls++;
				},
			},
			intentController,
		});

		await expect(
			tool.execute("edit-missing", { path, edits: [{ oldText: "before", newText: "after" }] }),
		).rejects.toThrow(/ENOENT|does not exist|not found/i);
		expect(operationCalls).toBe(0);
		expect(existsSync(path)).toBe(false);
	});

	it("retains valid edits after a path-only failure and revalidates them against the corrected target", async () => {
		const missingPath = join(testDir, "wrong-name.txt");
		const wrongCandidatePath = join(testDir, "wrong-candidate.txt");
		const correctedPath = join(testDir, "actual-name.txt");
		const replayPath = join(testDir, "edit-replay.txt");
		const tool = createEditTool(testDir);

		const missing = await rejectionMessage(
			tool.execute("edit-missing-retain", {
				path: missingPath,
				edits: [{ oldText: "before", newText: "after" }],
			}),
		);
		const payloadRef = retainedPayloadRef(missing);
		expect(missing).toContain("only a corrected path");
		writeFileSync(wrongCandidatePath, "unrelated\n", "utf8");
		writeFileSync(correctedPath, "before\n", "utf8");
		writeFileSync(replayPath, "before\n", "utf8");

		await expect(
			tool.execute("edit-retarget-wrong-candidate", { path: wrongCandidatePath, payloadRef } as never),
		).rejects.toThrow(/exact text|could not find/i);
		await tool.execute("edit-retarget", { path: correctedPath, payloadRef } as never);
		await expect(tool.execute("edit-retarget-replay", { path: replayPath, payloadRef } as never)).rejects.toThrow(
			/invalid|expired/i,
		);

		expect(readFileSync(wrongCandidatePath, "utf8")).toBe("unrelated\n");
		expect(readFileSync(correctedPath, "utf8")).toBe("after\n");
		expect(readFileSync(replayPath, "utf8")).toBe("before\n");
	});

	it("keeps retained mutation payloads isolated to their owning tool session", async () => {
		const collidedPath = join(testDir, "owned-collision.txt");
		const foreignPath = join(testDir, "foreign-target.txt");
		writeFileSync(collidedPath, "occupied", "utf8");
		const owner = createWriteTool(testDir);
		const foreign = createWriteTool(testDir);
		const collision = await rejectionMessage(
			owner.execute("write-owner-collision", { path: collidedPath, content: "private payload" }),
		);
		const payloadRef = retainedPayloadRef(collision);

		await expect(
			foreign.execute("write-foreign-retarget", { path: foreignPath, payloadRef } as never),
		).rejects.toThrow(/session|invalid|expired/i);
		expect(existsSync(foreignPath)).toBe(false);
	});

	it("rejects a wrong-kind retained payload before claiming that only the target is wrong", async () => {
		const collidedPath = join(testDir, "wrong-kind-collision.txt");
		const missingEditPath = join(testDir, "wrong-kind-edit.txt");
		const correctedWritePath = join(testDir, "wrong-kind-corrected.txt");
		writeFileSync(collidedPath, "occupied", "utf8");
		const intentController = new FileMutationIntentController();
		const write = createWriteTool(testDir, { intentController });
		const edit = createEditTool(testDir, { intentController });
		const collision = await rejectionMessage(
			write.execute("write-wrong-kind-source", { path: collidedPath, content: "write payload" }),
		);
		const payloadRef = retainedPayloadRef(collision);

		const wrongKind = await rejectionMessage(
			edit.execute("edit-wrong-kind", { path: missingEditPath, payloadRef } as never),
		);

		expect(wrongKind).toMatch(/for write, not edit/i);
		expect(wrongKind).not.toContain("PI_FILE_MUTATION_RETARGET");
		await write.execute("write-after-wrong-kind", { path: correctedWritePath, payloadRef } as never);
		expect(readFileSync(correctedWritePath, "utf8")).toBe("write payload");
	});

	it("does not describe an invalid reference collision as a valid retained payload", async () => {
		const collidedPath = join(testDir, "invalid-reference-collision.txt");
		writeFileSync(collidedPath, "occupied", "utf8");
		const tool = createWriteTool(testDir);

		const invalidReference = await rejectionMessage(
			tool.execute("write-invalid-reference", {
				path: collidedPath,
				payloadRef: "file-mutation:123e4567-e89b-12d3-a456-426614174000",
			} as never),
		);

		expect(invalidReference).toMatch(/invalid|expired|another session/i);
		expect(invalidReference).not.toContain("PI_FILE_MUTATION_RETARGET");
		const invalidContentReference = await rejectionMessage(
			tool.execute("write-invalid-content-reference", {
				path: collidedPath,
				contentRef: "file-content:123e4567-e89b-12d3-a456-426614174000",
			}),
		);
		expect(invalidContentReference).toMatch(/invalid|expired|another session/i);
		expect(invalidContentReference).not.toContain("PI_FILE_MUTATION_RETARGET");
		expect(readFileSync(collidedPath, "utf8")).toBe("occupied");
	});

	it("retargets a valid content reference after a path-only collision without regenerating bytes", async () => {
		const sourcePath = join(testDir, "content-ref-source.txt");
		const collidedPath = join(testDir, "content-ref-collision.txt");
		const correctedPath = join(testDir, "content-ref-corrected.txt");
		writeFileSync(collidedPath, "occupied", "utf8");
		const tool = createWriteTool(testDir);
		const source = await tool.execute("write-content-ref-source", { path: sourcePath, content: "exact source\n" });
		const contentRef = (source.details as CompletedMutationDetails).contentRef;
		if (!contentRef) throw new Error("Expected a content reference.");

		const collision = await rejectionMessage(
			tool.execute("write-content-ref-collision", { path: collidedPath, contentRef }),
		);
		expect(collision).toContain(`contentRef ${contentRef}`);
		expect(collision).toContain("write_collision");
		await tool.execute("write-content-ref-retarget", { path: correctedPath, contentRef });

		expect(readFileSync(collidedPath, "utf8")).toBe("occupied");
		expect(readFileSync(correctedPath, "utf8")).toBe("exact source\n");
	});

	it("consumes a retained write payload exactly once", async () => {
		const collidedPath = join(testDir, "single-use-collision.txt");
		const firstTarget = join(testDir, "single-use-first.txt");
		const replayTarget = join(testDir, "single-use-replay.txt");
		writeFileSync(collidedPath, "occupied", "utf8");
		const tool = createWriteTool(testDir);
		const collision = await rejectionMessage(
			tool.execute("write-single-use-source", { path: collidedPath, content: "one use" }),
		);
		const payloadRef = retainedPayloadRef(collision);

		await tool.execute("write-single-use-first", { path: firstTarget, payloadRef } as never);
		await expect(
			tool.execute("write-single-use-replay", { path: replayTarget, payloadRef } as never),
		).rejects.toThrow(/invalid|expired/i);

		expect(readFileSync(firstTarget, "utf8")).toBe("one use");
		expect(existsSync(replayTarget)).toBe(false);
	});

	it("does not retain a valid payload for a non-target write failure", async () => {
		const parentFile = join(testDir, "not-a-directory");
		const targetPath = join(parentFile, "child.txt");
		writeFileSync(parentFile, "occupied parent", "utf8");
		const tool = createWriteTool(testDir);

		const failure = await rejectionMessage(
			tool.execute("write-invalid-parent", { path: targetPath, content: "must not be cached" }),
		);

		expect(failure).toMatch(/parent path is not a directory/i);
		expect(failure).not.toContain("PI_FILE_MUTATION_RETARGET");
		expect(failure).not.toContain("payloadRef");
		expect(readFileSync(parentFile, "utf8")).toBe("occupied parent");
	});

	it("does not retain a colliding payload beyond the configured byte bound", async () => {
		const collidedPath = join(testDir, "bounded-collision.txt");
		writeFileSync(collidedPath, "occupied", "utf8");
		const intentController = new FileMutationIntentController({ mutationPayloadByteLimit: 4 });
		const tool = createWriteTool(testDir, { intentController });

		const collision = await rejectionMessage(
			tool.execute("write-over-cache-bound", { path: collidedPath, content: "five!" }),
		);

		expect(collision).toContain("could not be retained");
		expect(collision).not.toContain("payloadRef");
		expect(readFileSync(collidedPath, "utf8")).toBe("occupied");
	});

	it("expires retained mutation payloads before a delayed retarget", async () => {
		const collidedPath = join(testDir, "expiring-collision.txt");
		const correctedPath = join(testDir, "expired-target.txt");
		writeFileSync(collidedPath, "occupied", "utf8");
		let now = 1_000;
		const intentController = new FileMutationIntentController({
			mutationPayloadTtlMs: 10,
			now: () => now,
		});
		const tool = createWriteTool(testDir, { intentController });
		const collision = await rejectionMessage(
			tool.execute("write-expiring-payload", { path: collidedPath, content: "temporary" }),
		);
		const payloadRef = retainedPayloadRef(collision);
		now += 11;

		await expect(
			tool.execute("write-expired-retarget", { path: correctedPath, payloadRef } as never),
		).rejects.toThrow(/invalid|expired/i);
		expect(existsSync(correctedPath)).toBe(false);
	});

	it("rechecks a write target after preflight and before exclusive creation", async () => {
		const path = join(testDir, "raced.txt");
		let targetInspections = 0;
		let createCalls = 0;
		const intentController = new FileMutationIntentController({
			operations: {
				...localFileMutationIntentOperations,
				inspect: async (target, followSymlinks) => {
					if (target === path && ++targetInspections === 2) writeFileSync(path, "won by another process", "utf8");
					return localFileMutationIntentOperations.inspect(target, followSymlinks);
				},
			},
		});
		const tool = createWriteTool(testDir, {
			operations: {
				mkdir: async () => {},
				createFile: async () => {
					createCalls++;
				},
			},
			intentController,
		});

		await expect(tool.execute("write-raced", { path, content: "must not overwrite" })).rejects.toThrow(
			/already exists|collision|stale/i,
		);
		expect(targetInspections).toBe(2);
		expect(createCalls).toBe(0);
		expect(readFileSync(path, "utf8")).toBe("won by another process");
	});

	it("rechecks edit identity after preflight and rejects an externally changed target whose anchor is gone", async () => {
		const path = join(testDir, "stale.txt");
		writeFileSync(path, "alpha\nbeta\n", "utf8");
		let targetInspections = 0;
		let writeCalls = 0;
		const intentController = new FileMutationIntentController({
			operations: {
				...localFileMutationIntentOperations,
				inspect: async (target, followSymlinks) => {
					if (target === path && ++targetInspections === 2) writeFileSync(path, "external change\n", "utf8");
					return localFileMutationIntentOperations.inspect(target, followSymlinks);
				},
			},
		});
		const tool = createEditTool(testDir, {
			operations: {
				readFile: async (target) => readFileSync(target),
				writeFile: async () => {
					writeCalls++;
				},
			},
			intentController,
		});

		const failure = await rejectionMessage(
			tool.execute("edit-stale", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
		);
		expect(failure).toMatch(/could not find the exact text/i);
		expect(failure).not.toMatch(/changed during edit execution/i);
		expect(failure).not.toContain("produced by an earlier mutation in this run");
		expect(targetInspections).toBe(4);
		expect(writeCalls).toBe(0);
		expect(readFileSync(path, "utf8")).toBe("external change\n");
	});

	it("rechecks edit identity immediately before writing and preserves a concurrent external change", async () => {
		const path = join(testDir, "changed-after-read.txt");
		writeFileSync(path, "alpha\nbeta\n", "utf8");
		let readCalls = 0;
		let writeCalls = 0;
		const intentController = new FileMutationIntentController();
		const tool = createEditTool(testDir, {
			operations: {
				readFile: async (target) => {
					readCalls++;
					const original = readFileSync(target);
					writeFileSync(target, "external change after read\n", "utf8");
					return original;
				},
				writeFile: async () => {
					writeCalls++;
				},
			},
			intentController,
		});

		const failure = await rejectionMessage(
			tool.execute("edit-changed-after-read", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
		);
		expect(failure).toMatch(/could not find the exact text/i);
		expect(failure).not.toMatch(/changed during edit execution/i);
		expect(readCalls).toBe(2);
		expect(writeCalls).toBe(0);
		expect(readFileSync(path, "utf8")).toBe("external change after read\n");
	});

	it("applies an edit after an external change that kept its anchor intact", async () => {
		const path = join(testDir, "external-anchor-survives.txt");
		writeFileSync(path, "alpha\nbeta\n", "utf8");
		let targetInspections = 0;
		const intentController = new FileMutationIntentController({
			operations: {
				...localFileMutationIntentOperations,
				inspect: async (target, followSymlinks) => {
					if (target === path && ++targetInspections === 2) writeFileSync(path, "intro\nalpha\nbeta\n", "utf8");
					return localFileMutationIntentOperations.inspect(target, followSymlinks);
				},
			},
		});
		const tool = createEditTool(testDir, { intentController });

		await tool.execute("edit-external-anchor", {
			path,
			edits: [{ oldText: "alpha", newText: "ALPHA-changed" }],
		});

		expect(readFileSync(path, "utf8")).toBe("intro\nALPHA-changed\nbeta\n");
	});

	it("applies both same-batch edits to one file when the second anchor survives the first replacement", async () => {
		const path = join(testDir, "same-batch-disjoint.txt");
		writeFileSync(path, "alpha\nbeta\ngamma\n", "utf8");
		const bothPreflightsReached = createDeferred();
		let preflightInspections = 0;
		const intentController = new FileMutationIntentController({
			operations: {
				...localFileMutationIntentOperations,
				inspect: async (target, followSymlinks) => {
					if (target === path && preflightInspections < 2) {
						preflightInspections++;
						if (preflightInspections === 2) bothPreflightsReached.resolve();
						await bothPreflightsReached.promise;
					}
					return localFileMutationIntentOperations.inspect(target, followSymlinks);
				},
			},
		});
		const tool = createEditTool(testDir, { intentController });

		await Promise.all([
			tool.execute("edit-batch-first", { path, edits: [{ oldText: "alpha", newText: "ALPHA-changed" }] }),
			tool.execute("edit-batch-second", { path, edits: [{ oldText: "gamma", newText: "GAMMA-changed" }] }),
		]);

		expect(readFileSync(path, "utf8")).toBe("ALPHA-changed\nbeta\nGAMMA-changed\n");
	});

	it("applies every edit of a larger same-batch to one file when anchors stay disjoint", async () => {
		const path = join(testDir, "same-batch-three.txt");
		writeFileSync(path, "alpha\nbeta\ngamma\ndelta\n", "utf8");
		const allPreflightsReached = createDeferred();
		let preflightInspections = 0;
		const intentController = new FileMutationIntentController({
			operations: {
				...localFileMutationIntentOperations,
				inspect: async (target, followSymlinks) => {
					if (target === path && preflightInspections < 3) {
						preflightInspections++;
						if (preflightInspections === 3) allPreflightsReached.resolve();
						await allPreflightsReached.promise;
					}
					return localFileMutationIntentOperations.inspect(target, followSymlinks);
				},
			},
		});
		const tool = createEditTool(testDir, { intentController });

		await Promise.all([
			tool.execute("edit-three-first", { path, edits: [{ oldText: "alpha", newText: "ALPHA-changed" }] }),
			tool.execute("edit-three-second", { path, edits: [{ oldText: "gamma", newText: "GAMMA-changed" }] }),
			tool.execute("edit-three-third", { path, edits: [{ oldText: "delta", newText: "DELTA-changed" }] }),
		]);

		expect(readFileSync(path, "utf8")).toBe("ALPHA-changed\nbeta\nGAMMA-changed\nDELTA-changed\n");
	});

	it("reports a stale anchor naming this run's own mutation when same-batch edits overlap", async () => {
		const path = join(testDir, "same-batch-overlap.txt");
		writeFileSync(path, "alpha\nbeta\ngamma\n", "utf8");
		const bothPreflightsReached = createDeferred();
		let preflightInspections = 0;
		const intentController = new FileMutationIntentController({
			operations: {
				...localFileMutationIntentOperations,
				inspect: async (target, followSymlinks) => {
					if (target === path && preflightInspections < 2) {
						preflightInspections++;
						if (preflightInspections === 2) bothPreflightsReached.resolve();
						await bothPreflightsReached.promise;
					}
					return localFileMutationIntentOperations.inspect(target, followSymlinks);
				},
			},
		});
		const tool = createEditTool(testDir, { intentController });

		const outcomes = await Promise.allSettled([
			tool.execute("edit-overlap-first", {
				path,
				edits: [{ oldText: "alpha\nbeta", newText: "ONE-replaced\nbeta" }],
			}),
			tool.execute("edit-overlap-second", {
				path,
				edits: [{ oldText: "alpha\nbeta", newText: "TWO-replaced\nbeta" }],
			}),
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const rejection = outcomes.find((outcome) => outcome.status === "rejected");
		if (!rejection || rejection.status !== "rejected") throw new Error("Expected one same-batch edit to reject.");
		const message = rejection.reason instanceof Error ? rejection.reason.message : String(rejection.reason);
		expect(message).toContain("produced by an earlier mutation in this run");
		expect(message).toMatch(/could not find/i);
		expect(message).toContain("Current source sha256");
		expect(message).not.toMatch(/changed during edit execution/i);
		expect(readFileSync(path, "utf8")).toMatch(/^(ONE|TWO)-replaced\nbeta\ngamma\n$/);
	});

	it("fails after bounded identity refreshes when the target keeps changing during execution", async () => {
		const path = join(testDir, "churning.txt");
		writeFileSync(path, "alpha\nbeta\n", "utf8");
		let targetInspections = 0;
		let readCalls = 0;
		const intentController = new FileMutationIntentController({
			operations: {
				...localFileMutationIntentOperations,
				inspect: async (target, followSymlinks) => {
					if (target === path) {
						targetInspections++;
						writeFileSync(path, "churn\n".repeat(targetInspections), "utf8");
					}
					return localFileMutationIntentOperations.inspect(target, followSymlinks);
				},
			},
		});
		const tool = createEditTool(testDir, {
			operations: {
				readFile: async (target) => {
					readCalls++;
					return readFileSync(target);
				},
				writeFile: async () => {
					throw new Error("The edit must not write while the target keeps changing.");
				},
			},
			intentController,
		});

		await expect(
			tool.execute("edit-churn", { path, edits: [{ oldText: "alpha", newText: "ALPHA-changed" }] }),
		).rejects.toThrow(/changed during edit execution/i);
		expect(targetInspections).toBe(6);
		expect(readCalls).toBe(0);
	});

	it("detects a sub-millisecond rewrite that leaves every millisecond stat field identical", async () => {
		const path = join(testDir, "subms.txt");
		writeFileSync(path, "alpha\nbeta\n", "utf8");
		let identityStamp = 0;
		const millisecondViews: string[] = [];
		const intentController = new FileMutationIntentController({
			operations: {
				...localFileMutationIntentOperations,
				inspect: async (target, followSymlinks) => {
					const inspection = await localFileMutationIntentOperations.inspect(target, followSymlinks);
					if (target !== path || !inspection?.identity) return inspection;
					// Same size and millisecond timestamps, different nanoseconds: the shape a same-size
					// in-place rewrite completing inside one millisecond produces.
					identityStamp++;
					const { dev, ino, mode, size, mtimeMs, ctimeMs } = inspection.identity;
					millisecondViews.push([dev, ino, mode, size, mtimeMs, ctimeMs].join("|"));
					return {
						...inspection,
						identity: { ...inspection.identity, mtimeNs: `1787017242670${identityStamp}` },
					};
				},
			},
		});
		const tool = createEditTool(testDir, {
			operations: {
				readFile: async (target) => readFileSync(target),
				writeFile: async () => {
					throw new Error("The edit must not write over a sub-millisecond external rewrite.");
				},
			},
			intentController,
		});

		await expect(
			tool.execute("edit-subms", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
		).rejects.toThrow(/changed during edit execution/i);
		expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\n");
		// The premise the rejection rests on: every observation agreed on all millisecond-granularity
		// fields, so nothing but the nanosecond timestamp can account for it.
		expect(millisecondViews.length).toBeGreaterThan(1);
		expect(new Set(millisecondViews).size).toBe(1);
	});

	it("still matches identities whose nanosecond timestamps agree", async () => {
		const path = join(testDir, "stable-ns.txt");
		writeFileSync(path, "alpha\nbeta\n", "utf8");
		const intentController = new FileMutationIntentController({
			operations: {
				...localFileMutationIntentOperations,
				inspect: async (target, followSymlinks) => {
					const inspection = await localFileMutationIntentOperations.inspect(target, followSymlinks);
					if (target !== path || !inspection?.identity) return inspection;
					// Pinned so the nanosecond field cannot be what admits the edit.
					return {
						...inspection,
						identity: { ...inspection.identity, mtimeNs: "1787017242670530976" },
					};
				},
			},
		});
		const tool = createEditTool(testDir, {
			operations: {
				readFile: async (target) => readFileSync(target),
				writeFile: async (target, content) => writeFileSync(target, content, "utf8"),
			},
			intentController,
		});

		await tool.execute("edit-stable-ns", { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] });
		expect(readFileSync(path, "utf8")).toBe("ALPHA\nbeta\n");
	});

	it("uses the preflight authority as the only edit access-check path", async () => {
		const path = join(testDir, "single-access-owner.txt");
		writeFileSync(path, "alpha\n", "utf8");
		let accessCalls = 0;
		const access = async (target: string, mode?: number): Promise<void> => {
			accessCalls++;
			await localFileMutationIntentOperations.access(target, mode ?? 0);
		};
		const intentController = new FileMutationIntentController({
			operations: { ...localFileMutationIntentOperations, access },
		});
		const tool = createEditTool(testDir, {
			operations: {
				readFile: async (target) => readFileSync(target),
				writeFile: async (target, content) => writeFileSync(target, content, "utf8"),
			},
			intentController,
		});

		await tool.execute("edit-access-owner", {
			path,
			edits: [{ oldText: "alpha", newText: "ALPHA" }],
		});

		expect(accessCalls).toBe(3);
	});

	it("keeps invalid UTF-8 bytes unchanged on repeated semantic edit attempts", async () => {
		const path = join(testDir, "corrupt.dat");
		const originalBytes = Buffer.from([0xff, 0xfe, 0x80, 0xbf]);
		writeFileSync(path, originalBytes);
		const tool = createEditTool(testDir);
		const input = { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] };

		await expect(tool.execute("edit-corrupt", input)).rejects.toThrow(
			/PI_FILE_ENCODING_CORRUPTION.*exact text replacement.*unsafe/is,
		);
		await expect(tool.execute("edit-corrupt-retry", input)).rejects.toThrow(/PI_FILE_ENCODING_CORRUPTION/is);
		expect(readFileSync(path)).toEqual(originalBytes);
	});

	it("reuses exact written content by an explicit session-local reference", async () => {
		const sourcePath = join(testDir, "source.txt");
		const targetPath = join(testDir, "nested", "target.txt");
		const tool = createWriteTool(testDir);
		const sourceResult = await tool.execute("write-source", { path: sourcePath, content: "same bytes\n" });
		const contentRef = (sourceResult.details as CompletedMutationDetails).contentRef;
		expect(contentRef).toMatch(/^file-content:/);

		await tool.execute("write-target", { path: targetPath, contentRef: contentRef ?? "" });

		expect(readFileSync(targetPath, "utf8")).toBe("same bytes\n");
	});

	it("does not accept a content reference created by another tool session", async () => {
		const sourcePath = join(testDir, "source.txt");
		const targetPath = join(testDir, "isolated.txt");
		const owner = createWriteTool(testDir);
		const foreign = createWriteTool(testDir);
		const sourceResult = await owner.execute("write-owner", { path: sourcePath, content: "private" });
		const contentRef = (sourceResult.details as CompletedMutationDetails).contentRef;

		await expect(
			foreign.execute("write-foreign", { path: targetPath, contentRef: contentRef ?? "" }),
		).rejects.toThrow(/content reference.*session|invalid.*content reference/i);
		expect(existsSync(targetPath)).toBe(false);
	});

	it("allows exactly one of two concurrent writes after both early preflights pass", async () => {
		const path = join(testDir, "single-create.txt");
		const bothPreflightsReached = createDeferred();
		let initialInspections = 0;
		const intentController = new FileMutationIntentController({
			operations: {
				...localFileMutationIntentOperations,
				inspect: async (target, followSymlinks) => {
					if (target === path && initialInspections < 2) {
						initialInspections++;
						if (initialInspections === 2) bothPreflightsReached.resolve();
						await bothPreflightsReached.promise;
					}
					return localFileMutationIntentOperations.inspect(target, followSymlinks);
				},
			},
		});
		const tool = createWriteTool(testDir, {
			operations: {
				mkdir: async (target) => {
					mkdirSync(target, { recursive: true });
				},
				createFile: async (target, content) => writeFileSync(target, content, { encoding: "utf8", flag: "wx" }),
			},
			intentController,
		});

		const outcomes = await Promise.allSettled([
			tool.execute("write-a", { path, content: "a" }),
			tool.execute("write-b", { path, content: "b" }),
		]);

		expect(initialInspections).toBe(2);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
		expect(["a", "b"]).toContain(readFileSync(path, "utf8"));
	});

	it("invalidates a content reference if its source bytes change", async () => {
		const sourcePath = join(testDir, "changing-source.txt");
		const targetPath = join(testDir, "must-not-exist.txt");
		const tool = createWriteTool(testDir);
		const sourceResult = await tool.execute("write-changing-source", { path: sourcePath, content: "original" });
		const contentRef = (sourceResult.details as CompletedMutationDetails).contentRef;
		writeFileSync(sourcePath, "changed", "utf8");

		await expect(
			tool.execute("write-changed-target", { path: targetPath, contentRef: contentRef ?? "" }),
		).rejects.toThrow(/source changed/i);
		expect(existsSync(targetPath)).toBe(false);
	});

	it("evicts old content handles at the configured session bound", async () => {
		const intentController = new FileMutationIntentController({ contentReferenceLimit: 1 });
		const tool = createWriteTool(testDir, { intentController });
		const writeAndReference = async (name: string, content: string): Promise<string> => {
			const path = join(testDir, name);
			const result = await tool.execute(`write-${name}`, { path, content });
			const contentRef = (result.details as CompletedMutationDetails).contentRef;
			if (!contentRef) throw new Error("Expected a content reference.");
			return contentRef;
		};
		const evictedRef = await writeAndReference("first.txt", "first");
		await writeAndReference("second.txt", "second");
		const targetPath = join(testDir, "evicted-target.txt");

		await expect(tool.execute("write-evicted-target", { path: targetPath, contentRef: evictedRef })).rejects.toThrow(
			/invalid|expired/i,
		);
		expect(existsSync(targetPath)).toBe(false);
	});
});
