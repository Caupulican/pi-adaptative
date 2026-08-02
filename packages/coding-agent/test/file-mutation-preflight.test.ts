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

interface PreparedMutationDetails {
	intentId: string;
}

interface CompletedMutationDetails {
	contentRef?: string;
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

	it("publishes disjoint path-only prepare and single-payload commit schemas", () => {
		const write = createWriteTool(testDir);
		const edit = createEditTool(testDir);
		const validate = (tool: typeof write | typeof edit, id: string, args: Record<string, unknown>) =>
			validateToolArguments(
				tool,
				{ type: "toolCall", id, name: tool.name, arguments: args },
				{ repairEnabled: false },
			);

		expect(() =>
			validate(write, "write-prepare-with-content", {
				action: "prepare",
				path: "new.txt",
				content: "must not be accepted before preflight",
			}),
		).toThrow();
		expect(() =>
			validate(write, "write-ambiguous-commit", {
				action: "commit",
				path: "new.txt",
				intentId: "intent",
				content: "one",
				contentRef: "file-content:other",
			}),
		).toThrow();
		expect(() =>
			validate(edit, "edit-empty-commit", {
				action: "commit",
				path: "existing.txt",
				intentId: "intent",
				edits: [],
			}),
		).toThrow();
		expect(
			validate(write, "write-content-commit", {
				action: "commit",
				path: "new.txt",
				intentId: "intent",
				content: "",
			}),
		).toMatchObject({ content: "" });
	});

	it("rejects a write collision during the path-only prepare call", async () => {
		const path = join(testDir, "owned.txt");
		writeFileSync(path, "original", "utf8");
		const tool = createWriteTool(testDir);

		await expect(tool.execute("prepare-existing", { action: "prepare", path } as never)).rejects.toThrow(
			/already exists|collision/i,
		);
		expect(readFileSync(path, "utf8")).toBe("original");
	});

	it("requires an accepted create intent and rechecks it atomically at commit", async () => {
		const path = join(testDir, "raced.txt");
		const tool = createWriteTool(testDir);
		const prepared = await tool.execute("prepare-create", { action: "prepare", path } as never);
		const intentId = (prepared.details as PreparedMutationDetails).intentId;

		writeFileSync(path, "won by another process", "utf8");
		await expect(
			tool.execute("commit-create", { action: "commit", path, intentId, content: "must not overwrite" } as never),
		).rejects.toThrow(/already exists|collision|stale/i);
		expect(readFileSync(path, "utf8")).toBe("won by another process");
	});

	it("rejects a missing edit target during the path-only prepare call", async () => {
		const path = join(testDir, "missing.txt");
		const tool = createEditTool(testDir);

		await expect(tool.execute("prepare-missing", { action: "prepare", path } as never)).rejects.toThrow(
			/ENOENT|does not exist|not found/i,
		);
		expect(existsSync(path)).toBe(false);
	});

	it("rejects an edit when the prepared file changed before commit", async () => {
		const path = join(testDir, "stale.txt");
		writeFileSync(path, "alpha\nbeta\n", "utf8");
		const tool = createEditTool(testDir);
		const prepared = await tool.execute("prepare-edit", { action: "prepare", path } as never);
		const intentId = (prepared.details as PreparedMutationDetails).intentId;

		writeFileSync(path, "external change\n", "utf8");
		await expect(
			tool.execute("commit-edit", {
				action: "commit",
				path,
				intentId,
				edits: [{ oldText: "alpha", newText: "ALPHA" }],
			} as never),
		).rejects.toThrow(/changed|stale/i);
		expect(readFileSync(path, "utf8")).toBe("external change\n");
	});

	it("uses the intent authority as the only edit access-check path", async () => {
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

		const prepared = await tool.execute("prepare-access-owner", { action: "prepare", path } as never);
		await tool.execute("commit-access-owner", {
			action: "commit",
			path,
			intentId: (prepared.details as PreparedMutationDetails).intentId,
			edits: [{ oldText: "alpha", newText: "ALPHA" }],
		} as never);

		expect(accessCalls).toBe(2);
	});

	it("discards an encoding-blocked edit intent and requires a byte-safe approach", async () => {
		const path = join(testDir, "corrupt.dat");
		const originalBytes = Buffer.from([0xff, 0xfe, 0x80, 0xbf]);
		writeFileSync(path, originalBytes);
		const tool = createEditTool(testDir);
		const firstPrepare = await tool.execute("prepare-corrupt", { action: "prepare", path } as never);
		const firstIntentId = (firstPrepare.details as PreparedMutationDetails).intentId;
		const edits = [{ oldText: "alpha", newText: "ALPHA" }];

		await expect(
			tool.execute("commit-corrupt", { action: "commit", path, intentId: firstIntentId, edits } as never),
		).rejects.toThrow(/PI_FILE_ENCODING_CORRUPTION.*exact text replacement.*unsafe/is);
		await expect(
			tool.execute("replay-corrupt", { action: "commit", path, intentId: firstIntentId, edits } as never),
		).rejects.toThrow(/intent.*invalid|expired/i);
		expect(readFileSync(path)).toEqual(originalBytes);
	});

	it("reuses exact written content by an explicit session-local reference", async () => {
		const sourcePath = join(testDir, "source.txt");
		const targetPath = join(testDir, "nested", "target.txt");
		const tool = createWriteTool(testDir);
		const sourceIntent = (await tool.execute("prepare-source", { action: "prepare", path: sourcePath } as never))
			.details as PreparedMutationDetails;
		const sourceResult = await tool.execute("commit-source", {
			action: "commit",
			path: sourcePath,
			intentId: sourceIntent.intentId,
			content: "same bytes\n",
		} as never);
		const contentRef = (sourceResult.details as CompletedMutationDetails).contentRef;
		expect(contentRef).toMatch(/^file-content:/);

		const targetIntent = (await tool.execute("prepare-target", { action: "prepare", path: targetPath } as never))
			.details as PreparedMutationDetails;
		await tool.execute("commit-target", {
			action: "commit",
			path: targetPath,
			intentId: targetIntent.intentId,
			contentRef,
		} as never);

		expect(readFileSync(targetPath, "utf8")).toBe("same bytes\n");
	});

	it("does not accept an intent created by another tool session", async () => {
		const path = join(testDir, "isolated.txt");
		const owner = createWriteTool(testDir);
		const foreign = createWriteTool(testDir);
		const prepared = await owner.execute("prepare-owner", { action: "prepare", path } as never);
		const intentId = (prepared.details as PreparedMutationDetails).intentId;

		await expect(
			foreign.execute("commit-foreign", { action: "commit", path, intentId, content: "no" } as never),
		).rejects.toThrow(/intent.*invalid|unknown intent|session/i);
		expect(existsSync(path)).toBe(false);
	});

	it("consumes an intent exactly once under concurrent commits", async () => {
		const path = join(testDir, "single-use.txt");
		const tool = createWriteTool(testDir);
		const prepared = await tool.execute("prepare-once", { action: "prepare", path } as never);
		const intentId = (prepared.details as PreparedMutationDetails).intentId;

		const outcomes = await Promise.allSettled([
			tool.execute("commit-once-a", { action: "commit", path, intentId, content: "a" } as never),
			tool.execute("commit-once-b", { action: "commit", path, intentId, content: "b" } as never),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
		expect(["a", "b"]).toContain(readFileSync(path, "utf8"));
	});

	it("invalidates a content reference if its source bytes change", async () => {
		const sourcePath = join(testDir, "changing-source.txt");
		const targetPath = join(testDir, "must-not-exist.txt");
		const tool = createWriteTool(testDir);
		const sourceIntent = (
			await tool.execute("prepare-changing-source", { action: "prepare", path: sourcePath } as never)
		).details as PreparedMutationDetails;
		const sourceResult = await tool.execute("commit-changing-source", {
			action: "commit",
			path: sourcePath,
			intentId: sourceIntent.intentId,
			content: "original",
		} as never);
		const contentRef = (sourceResult.details as CompletedMutationDetails).contentRef;
		writeFileSync(sourcePath, "changed", "utf8");
		const targetIntent = (
			await tool.execute("prepare-changed-target", { action: "prepare", path: targetPath } as never)
		).details as PreparedMutationDetails;

		await expect(
			tool.execute("commit-changed-target", {
				action: "commit",
				path: targetPath,
				intentId: targetIntent.intentId,
				contentRef,
			} as never),
		).rejects.toThrow(/source changed/i);
		expect(existsSync(targetPath)).toBe(false);
	});

	it("evicts old content handles at the configured session bound", async () => {
		const intentController = new FileMutationIntentController({ contentReferenceLimit: 1 });
		const tool = createWriteTool(testDir, { intentController });
		const writeAndReference = async (name: string, content: string): Promise<string> => {
			const path = join(testDir, name);
			const prepared = await tool.execute(`prepare-${name}`, { action: "prepare", path } as never);
			const result = await tool.execute(`commit-${name}`, {
				action: "commit",
				path,
				intentId: (prepared.details as PreparedMutationDetails).intentId,
				content,
			} as never);
			const contentRef = (result.details as CompletedMutationDetails).contentRef;
			if (!contentRef) throw new Error("Expected a content reference.");
			return contentRef;
		};
		const evictedRef = await writeAndReference("first.txt", "first");
		await writeAndReference("second.txt", "second");
		const targetPath = join(testDir, "evicted-target.txt");
		const prepared = await tool.execute("prepare-evicted-target", { action: "prepare", path: targetPath } as never);

		await expect(
			tool.execute("commit-evicted-target", {
				action: "commit",
				path: targetPath,
				intentId: (prepared.details as PreparedMutationDetails).intentId,
				contentRef: evictedRef,
			} as never),
		).rejects.toThrow(/invalid|expired/i);
		expect(existsSync(targetPath)).toBe(false);
	});
});
