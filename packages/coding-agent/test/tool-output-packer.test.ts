import { describe, expect, it } from "vitest";
import { createInMemoryArtifactStore, isMissingArtifactMarker } from "../src/core/context/context-artifacts.ts";
import {
	broadQueryInvalidationNote,
	createInMemoryBroadQueryTracker,
	formatArtifactNotice,
	normalizeBroadQueryKey,
	packToolOutput,
} from "../src/core/context/tool-output-packer.ts";

function repeatLines(n: number, prefix = "line"): string {
	return Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n");
}

describe("packToolOutput: small output stays inline and readable", () => {
	it("returns content unchanged, unpacked, when under the caps and no store is given", () => {
		const result = packToolOutput({ toolName: "grep", rawContent: "small output" }, undefined, "holder-1");
		expect(result.packed).toBe(false);
		expect(result.content).toBe("small output");
		expect(result.artifactId).toBeUndefined();
		expect(result.truncation.truncated).toBe(false);
	});

	it("returns content unchanged, unpacked, when under the caps even with a store provided", () => {
		const store = createInMemoryArtifactStore();
		const result = packToolOutput({ toolName: "grep", rawContent: "small output" }, store, "holder-1");
		expect(result.packed).toBe(false);
		expect(result.content).toBe("small output");
		// Nothing was written to the store: cleanup has nothing to report either way.
		expect(store.cleanup()).toEqual([]);
	});
});

describe("packToolOutput: large output becomes digest + artifact handle", () => {
	it("captures the exact raw payload to the artifact store before bounding the preview", () => {
		const store = createInMemoryArtifactStore();
		const rawContent = repeatLines(5000);
		const result = packToolOutput(
			{ toolName: "grep", command: "grep -rn pattern", path: "src", rawContent, createdAtTurn: 1 },
			store,
			"tool-call-1",
		);

		expect(result.packed).toBe(true);
		expect(result.truncation.truncated).toBe(true);
		expect(result.artifactId).toBeDefined();
		expect(formatArtifactNotice(result.artifactId!)).toContain(`artifact tool-output:${result.artifactId}`);

		const record = store.read(result.artifactId!);
		expect(isMissingArtifactMarker(record)).toBe(false);
		if (!isMissingArtifactMarker(record)) {
			expect(record.content).toBe(rawContent); // exact raw payload, not the bounded preview
			expect(record.ref.toolName).toBe("grep");
			expect(record.ref.command).toBe("grep -rn pattern");
			expect(record.ref.path).toBe("src");
		}
	});

	it("does not write an artifact when output is small, even with a store provided", () => {
		const store = createInMemoryArtifactStore();
		packToolOutput({ toolName: "grep", rawContent: "small" }, store, "holder-1");
		expect(store.cleanup()).toEqual([]);
	});
});

describe("packToolOutput: never silently drops or fabricates content", () => {
	it("without a store, large output is truncated exactly as truncateHead alone would do (unchanged behavior)", () => {
		const rawContent = repeatLines(5000);
		const result = packToolOutput({ toolName: "grep", rawContent }, undefined, "holder-1");
		expect(result.packed).toBe(false);
		expect(result.artifactId).toBeUndefined();
		expect(result.truncation.truncated).toBe(true);
	});
});

describe("formatArtifactNotice", () => {
	it("includes the artifact id in a stable, greppable format", () => {
		expect(formatArtifactNotice("abc123")).toBe("Full output: artifact tool-output:abc123");
	});
});

describe("packToolOutput: referenced artifact is not cleaned up; addReference-false fails closed", () => {
	it("keeps the artifact alive against cleanup once packed", () => {
		const store = createInMemoryArtifactStore();
		const rawContent = repeatLines(5000);
		const result = packToolOutput({ toolName: "grep", rawContent, createdAtTurn: 2 }, store, "tool-call-2");

		expect(result.packed).toBe(true);
		const deleted = store.cleanup();
		expect(deleted).not.toContain(result.artifactId);
		expect(store.has(result.artifactId!)).toBe(true);
	});

	it("fails closed -- does not claim an artifact exists -- when reference registration fails", () => {
		const store = createInMemoryArtifactStore();
		const rawContent = repeatLines(5000);
		// Simulate addReference failing (e.g. concurrent cleanup) by wrapping the store.
		const flakyStore = {
			...store,
			addReference: () => false,
		};

		const result = packToolOutput({ toolName: "grep", rawContent, createdAtTurn: 3 }, flakyStore, "tool-call-3");

		expect(result.packed).toBe(false);
		expect(result.artifactId).toBeUndefined();
		// Falls back to the exact same bounded preview as the no-store path.
		const withoutStore = packToolOutput({ toolName: "grep", rawContent, createdAtTurn: 3 }, undefined, "tool-call-3");
		expect(result.content).toBe(withoutStore.content);
	});
});

describe("broad query invalidation candidate signal", () => {
	it("produces no note before the repeat threshold", () => {
		const tracker = createInMemoryBroadQueryTracker();
		const key = normalizeBroadQueryKey({ toolName: "grep", pattern: "Goal", path: "." });
		expect(broadQueryInvalidationNote(tracker, key, 'grep "Goal" from repo root')).toBeUndefined();
	});

	it("produces a do-not-repeat note once the same query has been broad twice", () => {
		const tracker = createInMemoryBroadQueryTracker();
		const key = normalizeBroadQueryKey({ toolName: "grep", pattern: "Goal", path: "." });
		broadQueryInvalidationNote(tracker, key, 'grep "Goal" from repo root');
		const note = broadQueryInvalidationNote(tracker, key, 'grep "Goal" from repo root');

		expect(note).toBeDefined();
		expect(note).toContain("Do not repeat");
		expect(note).toContain("2 times");
	});

	it("does not produce a note with no tracker", () => {
		expect(broadQueryInvalidationNote(undefined, "any-key", "any query")).toBeUndefined();
	});

	it("tracks distinct queries independently", () => {
		const tracker = createInMemoryBroadQueryTracker();
		const keyA = normalizeBroadQueryKey({ toolName: "grep", pattern: "Goal" });
		const keyB = normalizeBroadQueryKey({ toolName: "grep", pattern: "Other" });
		broadQueryInvalidationNote(tracker, keyA, "query A");
		expect(broadQueryInvalidationNote(tracker, keyB, "query B")).toBeUndefined();
	});

	it("normalizes queries by tool/pattern/path/glob so identical calls collide", () => {
		const a = normalizeBroadQueryKey({ toolName: "grep", pattern: "Goal", path: "src", glob: "*.ts" });
		const b = normalizeBroadQueryKey({ toolName: "grep", pattern: "Goal", path: "src", glob: "*.ts" });
		const c = normalizeBroadQueryKey({ toolName: "grep", pattern: "Goal", path: "src", glob: "*.js" });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});
