import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { reserveSessionBundleDeletion } from "../src/core/orchestration/session-bundle-lifecycle.ts";
import { TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { TypeSafeReviewer } from "../src/core/review/typesafe-reviewer.ts";
import { createTypeSafeReviewToolDefinition } from "../src/core/tools/typesafe-review.ts";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("TypeSafe durable evidence", () => {
	it.each(["missing", "corrupt", "deleted"] as const)(
		"consults lineage only for missing evidence, without bypassing %s state",
		(state) => {
			const parent = new TypeSafeEvidenceStore(createInMemoryArtifactStore());
			const record = { accepted: false, response: { confidence: 0.4 } };
			const ref = parent.save("call", record);
			const artifacts = createInMemoryArtifactStore();
			const child = new TypeSafeEvidenceStore(
				artifacts,
				(operation) => {
					if (state === "deleted") throw new Error("fixture deletion reserved");
					return operation();
				},
				[parent],
			);
			if (state === "corrupt") {
				expect(child.save("call", record)).toEqual(ref);
				const saved = artifacts.read(ref.id);
				if ("missing" in saved) throw new Error("Missing control record");
				vi.spyOn(artifacts, "read").mockReturnValue({ ...saved, content: '{"accepted":true}' });
			}
			if (state === "missing") expect(child.read(ref.id)).toEqual(parent.read(ref.id));
			else expect(() => child.read(ref.id)).toThrow(state === "corrupt" ? "integrity" : "deletion");
		},
	);
	it("retains all large adverse evidence across cleanup/reopen, with complete paging and stable identity", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-jev-evidence-"));
		directories.push(directory);
		const archive = TypeSafeEvidenceStore.file(directory, "session");
		const record = {
			request: { state: "漢🙂\n".repeat(20_000) },
			response: { choice: "contradicts", confidence: 1 },
			accepted: false,
		};
		const ref = archive.save("tool-call", record);
		expect(archive.save("tool-call", record)).toEqual(ref);
		const reopened = TypeSafeEvidenceStore.file(directory, "session");
		let restored = "";
		let offset: number | undefined = 0;
		while (offset !== undefined) {
			const page = reopened.read(ref.id, offset);
			expect(page.sha256).toBe(ref.sha256);
			if (page.nextOffset !== undefined) expect(page.nextOffset).toBeGreaterThan(offset);
			restored += page.text;
			offset = page.nextOffset;
		}
		expect(Buffer.byteLength(restored)).toBe(ref.bytes);
		expect(JSON.parse(restored)).toEqual({ version: 1, toolCallId: "tool-call", record });
		expect(() => reopened.read(ref.id, restored.length + 1)).toThrow("offset");
		expect(() => reopened.read("../../auth.json")).toThrow("reference");
		expect(() => TypeSafeEvidenceStore.file(directory, "other-session").read(ref.id)).toThrow("unavailable");
		expect(reserveSessionBundleDeletion(directory, "session", () => true)).toBe(true);
		expect(() => archive.save("late-call", record)).toThrow("deletion");
	});

	it("protects archived records from ordinary artifact cleanup and rejects corruption", () => {
		const artifacts = createInMemoryArtifactStore();
		const archive = new TypeSafeEvidenceStore(artifacts);
		const ref = archive.save("call", { accepted: false, response: { confidence: 0.2 } });
		expect(artifacts.cleanup()).toEqual([]);
		const original = artifacts.read(ref.id);
		if ("missing" in original) throw new Error("Missing control record");
		vi.spyOn(artifacts, "read").mockReturnValue({ ...original, content: '{"accepted":true}' });
		expect(() => archive.read(ref.id)).toThrow("integrity");
	});

	it.each([false, true])("requires evidence persistence before returning approval: storage fails=%s", async (fail) => {
		const artifacts = createInMemoryArtifactStore();
		if (fail)
			vi.spyOn(artifacts, "write").mockImplementation(() => {
				throw new Error("sensitive storage failure");
			});
		const archive = new TypeSafeEvidenceStore(artifacts);
		const fetcher = vi.fn(async () =>
			Response.json({
				model: "jev-latest",
				answers: { q: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0 } } },
				usage: { input_tokens: 100, output_tokens: 10 },
			}),
		);
		const tool = createTypeSafeReviewToolDefinition(
			new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher }),
			archive,
		);
		const result = await tool.execute("call", {
			action: "review",
			review: {
				state: "long evidence ".repeat(5_000),
				questions: {
					q: {
						instructions: "Supported?",
						criteria: { yes: "Supported", no: "Contradicted" },
						expected: "yes",
					},
				},
			},
		});
		expect(result).toMatchObject({ isError: fail, details: { accepted: !fail }, usage: { totalTokens: 110 } });
		expect(JSON.stringify(result)).not.toContain("sensitive storage failure");
		if (!fail) {
			const id = (result.details as { evidence: { id: string } }).evidence.id;
			const page = await tool.execute("inspect", { action: "evidence", id });
			expect(JSON.parse(page.content[0].text)).toMatchObject({ id, offset: 0, nextOffset: 8192 });
		}
		expect(fetcher).toHaveBeenCalledOnce();
	});
});
