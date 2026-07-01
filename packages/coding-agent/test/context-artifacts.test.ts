import { describe, expect, it } from "vitest";
import {
	type ArtifactWriteRequest,
	createInMemoryArtifactStore,
	generateArtifactId,
	isMissingArtifactMarker,
} from "../src/core/context/context-artifacts.ts";

function makeRequest(overrides: Partial<ArtifactWriteRequest> = {}): ArtifactWriteRequest {
	return {
		kind: "tool_output",
		content: "line one\nline two\nline three",
		toolName: "grep",
		command: 'grep -rn "Goal" packages/coding-agent',
		path: "packages/coding-agent",
		sessionEntryId: "entry-1",
		createdAtTurn: 3,
		reproducible: true,
		...overrides,
	};
}

describe("artifact metadata round-trip", () => {
	it("preserves every typed field on the returned ref", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());

		expect(ref.kind).toBe("tool_output");
		expect(ref.toolName).toBe("grep");
		expect(ref.command).toBe('grep -rn "Goal" packages/coding-agent');
		expect(ref.path).toBe("packages/coding-agent");
		expect(ref.sessionEntryId).toBe("entry-1");
		expect(ref.createdAtTurn).toBe(3);
		expect(ref.reproducible).toBe(true);
		expect(ref.byteLength).toBe(Buffer.byteLength("line one\nline two\nline three", "utf8"));
		expect(ref.lineCount).toBe(3);
		expect(typeof ref.id).toBe("string");
		expect(ref.id.length).toBeGreaterThan(0);
	});

	it("round-trips the ref through JSON without losing typed fields", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		const roundTripped = JSON.parse(JSON.stringify(ref));
		expect(roundTripped).toEqual(ref);
	});
});

describe("raw payload storage and retrieval", () => {
	it("stores and retrieves the exact original content by ref id", () => {
		const store = createInMemoryArtifactStore();
		const { ref, content } = store.write(makeRequest());

		const record = store.read(ref.id);
		expect(isMissingArtifactMarker(record)).toBe(false);
		if (!isMissingArtifactMarker(record)) {
			expect(record.content).toBe(content);
			expect(record.content).toBe("line one\nline two\nline three");
		}
	});

	it("is content-addressed: writing identical content+metadata twice yields the same id and does not duplicate", () => {
		const store = createInMemoryArtifactStore();
		const first = store.write(makeRequest());
		const second = store.write(makeRequest());
		expect(second.ref.id).toBe(first.ref.id);
		expect(generateArtifactId(makeRequest())).toBe(first.ref.id);
	});

	it("gives distinct content the same tool/path a distinct id", () => {
		const store = createInMemoryArtifactStore();
		const first = store.write(makeRequest({ content: "content A" }));
		const second = store.write(makeRequest({ content: "content B" }));
		expect(second.ref.id).not.toBe(first.ref.id);
	});

	it("treats identical content/tool/command/path but a different turn as a distinct capture", () => {
		// Artifact identity represents a capture event, not just a payload: otherwise a
		// second write's sessionEntryId/createdAtTurn/reproducible would be silently
		// discarded in favor of the first write's.
		const store = createInMemoryArtifactStore();
		const first = store.write(makeRequest({ createdAtTurn: 3 }));
		const second = store.write(makeRequest({ createdAtTurn: 4 }));

		expect(second.ref.id).not.toBe(first.ref.id);
		expect(store.has(first.ref.id)).toBe(true);
		expect(store.has(second.ref.id)).toBe(true);

		const firstRead = store.read(first.ref.id);
		const secondRead = store.read(second.ref.id);
		if (!isMissingArtifactMarker(firstRead)) expect(firstRead.ref.createdAtTurn).toBe(3);
		if (!isMissingArtifactMarker(secondRead)) expect(secondRead.ref.createdAtTurn).toBe(4);
	});

	it("treats identical content/tool/command/path but a different sessionEntryId as a distinct capture", () => {
		const store = createInMemoryArtifactStore();
		const first = store.write(makeRequest({ sessionEntryId: "entry-1" }));
		const second = store.write(makeRequest({ sessionEntryId: "entry-2" }));
		expect(second.ref.id).not.toBe(first.ref.id);
	});

	it("treats identical content/tool/command/path but a different reproducible flag as a distinct capture", () => {
		const store = createInMemoryArtifactStore();
		const first = store.write(makeRequest({ reproducible: true }));
		const second = store.write(makeRequest({ reproducible: false }));
		expect(second.ref.id).not.toBe(first.ref.id);
	});
});

describe("readRef: metadata-only lookup", () => {
	it("returns the same ref write() returned, without needing the content", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		expect(store.readRef(ref.id)).toEqual(ref);
	});

	it("returns undefined for an id that was never written", () => {
		const store = createInMemoryArtifactStore();
		expect(store.readRef("never-written")).toBeUndefined();
	});

	it("returns undefined once the artifact has been cleaned up", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		store.cleanup();
		expect(store.readRef(ref.id)).toBeUndefined();
	});
});

describe("missing artifact never silently degrades to invented or empty content", () => {
	it("returns an explicit missing marker for an id the store never captured", () => {
		const store = createInMemoryArtifactStore();
		const record = store.read("never-written-id");

		expect(isMissingArtifactMarker(record)).toBe(true);
		if (isMissingArtifactMarker(record)) {
			expect(record.reason).toBe("not_found");
			expect(record.id).toBe("never-written-id");
		}
		// Critically: the union type forces callers to check before reading `.content`;
		// there is no code path that returns `{ content: "" }` for a missing artifact.
		expect((record as { content?: unknown }).content).toBeUndefined();
	});

	it("distinguishes never-written from cleaned-up with a different reason", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		store.cleanup(); // zero references, so this artifact is eligible for cleanup

		const record = store.read(ref.id);
		expect(isMissingArtifactMarker(record)).toBe(true);
		if (isMissingArtifactMarker(record)) expect(record.reason).toBe("cleaned_up");
	});

	it("a store instance with no knowledge of an id reports missing, never fabricated content", () => {
		// NOTE on scope: this in-memory store keeps metadata and payload in the *same* map,
		// so this only re-demonstrates the never-written case (from a second store
		// instance's point of view) -- it does NOT prove "payload survives metadata/index
		// loss while metadata is lost", since there is no separate metadata layer here to
		// lose while keeping the payload. That stronger canonicality guarantee (DB/index
		// loss cannot imply raw evidence deletion) requires a file/SQLite-backed store
		// where metadata and payload are genuinely separate stores, and must be tested
		// there (TODO once that backed implementation exists).
		const originalStore = createInMemoryArtifactStore();
		const { ref, content } = originalStore.write(makeRequest());
		const freshStore = createInMemoryArtifactStore();

		const fromFreshStore = freshStore.read(ref.id);
		expect(isMissingArtifactMarker(fromFreshStore)).toBe(true);

		// The original store still has it -- unaffected by the fresh store's ignorance.
		const fromOriginalStore = originalStore.read(ref.id);
		expect(isMissingArtifactMarker(fromOriginalStore)).toBe(false);
		if (!isMissingArtifactMarker(fromOriginalStore)) expect(fromOriginalStore.content).toBe(content);
	});
});

describe("reference registration signals success/failure, never a silent no-op", () => {
	it("addReference returns false for an id that was never written", () => {
		const store = createInMemoryArtifactStore();
		expect(store.addReference("never-written-id", "holder-1")).toBe(false);
		// A caller must be able to tell registration failed, so it fails closed instead of
		// believing the (nonexistent) artifact is now protected from cleanup.
		expect(store.referenceCount("never-written-id")).toBe(0);
	});

	it("addReference returns false for an id that has already been cleaned up", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		store.cleanup(); // zero references at write time, so this is eligible immediately

		expect(store.addReference(ref.id, "holder-1")).toBe(false);
	});

	it("addReference returns true when the artifact exists", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		expect(store.addReference(ref.id, "holder-1")).toBe(true);
	});

	it("removeReference returns false for an id that was never written", () => {
		const store = createInMemoryArtifactStore();
		expect(store.removeReference("never-written-id", "holder-1")).toBe(false);
	});

	it("removeReference returns false for an id that has already been cleaned up", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		store.cleanup();
		expect(store.removeReference(ref.id, "holder-1")).toBe(false);
	});

	it("removeReference returns false when the holder was never registered on an existing artifact", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		expect(store.removeReference(ref.id, "never-registered-holder")).toBe(false);
	});

	it("removeReference returns true only when a reference was actually removed", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		store.addReference(ref.id, "holder-1");
		expect(store.removeReference(ref.id, "holder-1")).toBe(true);
		expect(store.removeReference(ref.id, "holder-1")).toBe(false); // already removed
	});
});

describe("cleanup respects active references", () => {
	it("refuses to delete an artifact with at least one active reference", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		store.addReference(ref.id, "context-item-1");

		const deleted = store.cleanup();

		expect(deleted).not.toContain(ref.id);
		expect(store.has(ref.id)).toBe(true);
		expect(isMissingArtifactMarker(store.read(ref.id))).toBe(false);
	});

	it("deletes an artifact once its last reference is released", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		store.addReference(ref.id, "context-item-1");
		store.addReference(ref.id, "invalidation-1");

		expect(store.cleanup()).not.toContain(ref.id);
		store.removeReference(ref.id, "context-item-1");
		expect(store.cleanup()).not.toContain(ref.id); // still held by invalidation-1
		store.removeReference(ref.id, "invalidation-1");

		const deleted = store.cleanup();
		expect(deleted).toContain(ref.id);
		expect(store.has(ref.id)).toBe(false);
	});

	it("deletes artifacts with zero references immediately, leaving referenced ones untouched", () => {
		const store = createInMemoryArtifactStore();
		const unreferenced = store.write(makeRequest({ content: "unreferenced" }));
		const referenced = store.write(makeRequest({ content: "referenced" }));
		store.addReference(referenced.ref.id, "holder-1");

		const deleted = store.cleanup();

		expect(deleted).toEqual([unreferenced.ref.id]);
		expect(store.has(unreferenced.ref.id)).toBe(false);
		expect(store.has(referenced.ref.id)).toBe(true);
	});

	it("reports reference counts", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write(makeRequest());
		expect(store.referenceCount(ref.id)).toBe(0);
		store.addReference(ref.id, "a");
		store.addReference(ref.id, "b");
		expect(store.referenceCount(ref.id)).toBe(2);
		store.removeReference(ref.id, "a");
		expect(store.referenceCount(ref.id)).toBe(1);
	});
});
