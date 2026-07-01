import { describe, expect, it } from "vitest";
import {
	DEFAULT_RETRIEVAL_MAX_LINES,
	MAX_RETRIEVAL_BYTES,
	MAX_RETRIEVAL_LINES,
	retrieveArtifactSlice,
} from "../src/core/context/artifact-retrieval.ts";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";

function writeArtifact(store: ReturnType<typeof createInMemoryArtifactStore>, content: string) {
	return store.write({
		kind: "tool_output",
		content,
		toolName: "grep",
		command: "grep -rn pattern",
		path: "src",
		createdAtTurn: 1,
		reproducible: true,
	});
}

describe("retrieveArtifactSlice: missing artifacts", () => {
	it("returns found=false with the store's missing reason for an unknown id", () => {
		const store = createInMemoryArtifactStore();
		const result = retrieveArtifactSlice(store, { artifactId: "never-written" });
		expect(result.found).toBe(false);
		if (!result.found) expect(result.missingReason).toBe("not_found");
	});

	it("never fabricates content for a missing artifact", () => {
		const store = createInMemoryArtifactStore();
		const result = retrieveArtifactSlice(store, { artifactId: "never-written", mode: "head" });
		expect(result).not.toHaveProperty("slice");
	});
});

describe("retrieveArtifactSlice: metadata mode", () => {
	it("returns the ref without any content", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = writeArtifact(store, "line one\nline two");
		const result = retrieveArtifactSlice(store, { artifactId: ref.id, mode: "metadata" });

		expect(result.found).toBe(true);
		if (result.found && result.mode === "metadata") {
			expect(result.ref).toEqual(ref);
			expect(result).not.toHaveProperty("slice");
		}
	});
});

describe("retrieveArtifactSlice: head/tail bounded slices", () => {
	it("defaults to head mode when mode is omitted", () => {
		const store = createInMemoryArtifactStore();
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const { ref } = writeArtifact(store, lines.join("\n"));

		const result = retrieveArtifactSlice(store, { artifactId: ref.id });

		expect(result.found).toBe(true);
		if (result.found && result.mode !== "metadata") {
			expect(result.slice).toContain("line 0");
			expect(result.slice).not.toContain(`line ${500 - 1}`);
			expect(result.truncation.truncated).toBe(true);
		}
	});

	it("bounds head mode to DEFAULT_RETRIEVAL_MAX_LINES by default", () => {
		const store = createInMemoryArtifactStore();
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const { ref } = writeArtifact(store, lines.join("\n"));

		const result = retrieveArtifactSlice(store, { artifactId: ref.id, mode: "head" });

		expect(result.found).toBe(true);
		if (result.found && result.mode === "head") {
			expect(result.truncation.outputLines).toBe(DEFAULT_RETRIEVAL_MAX_LINES);
			expect(result.slice.split("\n").length).toBe(DEFAULT_RETRIEVAL_MAX_LINES);
		}
	});

	it("returns the last lines for tail mode", () => {
		const store = createInMemoryArtifactStore();
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const { ref } = writeArtifact(store, lines.join("\n"));

		const result = retrieveArtifactSlice(store, { artifactId: ref.id, mode: "tail" });

		expect(result.found).toBe(true);
		if (result.found && result.mode === "tail") {
			expect(result.slice).toContain("line 499");
			expect(result.slice).not.toContain("line 0\n");
			expect(result.truncation.truncated).toBe(true);
		}
	});

	it("respects an explicit maxLines override", () => {
		const store = createInMemoryArtifactStore();
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const { ref } = writeArtifact(store, lines.join("\n"));

		const result = retrieveArtifactSlice(store, { artifactId: ref.id, mode: "head", maxLines: 10 });

		expect(result.found).toBe(true);
		if (result.found && result.mode === "head") {
			expect(result.truncation.outputLines).toBe(10);
		}
	});

	it("returns the full content untruncated when it fits within the default bound", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = writeArtifact(store, "line one\nline two\nline three");

		const result = retrieveArtifactSlice(store, { artifactId: ref.id, mode: "head" });

		expect(result.found).toBe(true);
		if (result.found && result.mode === "head") {
			expect(result.slice).toBe("line one\nline two\nline three");
			expect(result.truncation.truncated).toBe(false);
		}
	});

	it("never returns more than a bounded slice for a huge artifact at default bounds", () => {
		const store = createInMemoryArtifactStore();
		const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
		const fullContent = lines.join("\n");
		const { ref } = writeArtifact(store, fullContent);

		const result = retrieveArtifactSlice(store, { artifactId: ref.id, mode: "head" });

		expect(result.found).toBe(true);
		if (result.found && result.mode === "head") {
			expect(result.slice.length).toBeLessThan(fullContent.length);
			expect(result.truncation.outputLines).toBe(DEFAULT_RETRIEVAL_MAX_LINES);
		}
	});
});

describe("retrieveArtifactSlice: hard-capped bounds cannot be overridden by the caller", () => {
	it("clamps an absurdly large explicit maxLines to MAX_RETRIEVAL_LINES", () => {
		const store = createInMemoryArtifactStore();
		const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
		const { ref } = writeArtifact(store, lines.join("\n"));

		const result = retrieveArtifactSlice(store, { artifactId: ref.id, mode: "head", maxLines: 1_000_000 });

		expect(result.found).toBe(true);
		if (result.found && result.mode === "head") {
			expect(result.truncation.outputLines).toBeLessThanOrEqual(MAX_RETRIEVAL_LINES);
			expect(result.truncation.truncated).toBe(true);
		}
	});

	it("clamps an absurdly large explicit maxBytes to MAX_RETRIEVAL_BYTES", () => {
		const store = createInMemoryArtifactStore();
		// Few, very long lines so the line cap doesn't dominate before the byte cap does.
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(20_000)}`);
		const fullContent = lines.join("\n");
		const { ref } = writeArtifact(store, fullContent);

		const result = retrieveArtifactSlice(store, {
			artifactId: ref.id,
			mode: "head",
			maxLines: 1_000_000,
			maxBytes: 100_000_000,
		});

		expect(result.found).toBe(true);
		if (result.found && result.mode === "head") {
			expect(result.slice.length).toBeLessThan(fullContent.length);
			expect(Buffer.byteLength(result.slice, "utf8")).toBeLessThanOrEqual(MAX_RETRIEVAL_BYTES);
		}
	});

	it("cannot force full rehydration of a huge artifact via combined huge overrides, in either head or tail mode", () => {
		const store = createInMemoryArtifactStore();
		const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i} with some padding to add bytes`);
		const fullContent = lines.join("\n");
		const { ref } = writeArtifact(store, fullContent);

		for (const mode of ["head", "tail"] as const) {
			const result = retrieveArtifactSlice(store, {
				artifactId: ref.id,
				mode,
				maxLines: Number.MAX_SAFE_INTEGER,
				maxBytes: Number.MAX_SAFE_INTEGER,
			});
			expect(result.found).toBe(true);
			if (result.found && result.mode !== "metadata") {
				expect(result.slice.length).toBeLessThan(fullContent.length);
				expect(result.truncation.outputLines).toBeLessThanOrEqual(MAX_RETRIEVAL_LINES);
			}
		}
	});

	it("still allows a caller-requested bound smaller than the hard ceiling", () => {
		const store = createInMemoryArtifactStore();
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const { ref } = writeArtifact(store, lines.join("\n"));

		const result = retrieveArtifactSlice(store, { artifactId: ref.id, mode: "head", maxLines: 5 });

		expect(result.found).toBe(true);
		if (result.found && result.mode === "head") {
			expect(result.truncation.outputLines).toBe(5);
		}
	});
});
