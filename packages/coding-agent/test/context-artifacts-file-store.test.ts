import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ArtifactWriteRequest,
	createFileArtifactStore,
	generateArtifactId,
	isMissingArtifactMarker,
} from "../src/core/context/context-artifacts.ts";
import { runSignaledWorkerThreads } from "./worker-thread-fixture.ts";

function makeRequest(overrides: Partial<ArtifactWriteRequest> = {}): ArtifactWriteRequest {
	return {
		kind: "tool_output",
		content: "line one\nline two\nline three",
		toolName: "grep",
		command: 'grep -rn "Goal" packages/coding-agent',
		path: "packages/coding-agent",
		sessionEntryId: "entry-1",
		createdAtTurn: 1,
		reproducible: true,
		...overrides,
	};
}

describe("createFileArtifactStore", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = mkdtempSync(join(tmpdir(), "pi-file-artifact-store-"));
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	describe("write/read/recreate: content and metadata survive a fresh store instance", () => {
		it("persists content and typed ref fields to disk and reads them back from a new instance", () => {
			const storeA = createFileArtifactStore({ baseDir });
			const { ref, content } = storeA.write(makeRequest());

			// A brand-new store instance over the same directory simulates a process
			// restart: it starts with no in-memory state of its own.
			const storeB = createFileArtifactStore({ baseDir });
			const record = storeB.read(ref.id);

			expect(isMissingArtifactMarker(record)).toBe(false);
			if (!isMissingArtifactMarker(record)) {
				expect(record.content).toBe(content);
				expect(record.ref).toEqual(ref);
			}
		});

		it("preserves exact raw payload bytes, including multi-line and multi-byte content", () => {
			const content = "utf-8 line: café ☕\nsecond line\nthird line with emoji 🎉";
			const storeA = createFileArtifactStore({ baseDir });
			const { ref } = storeA.write(makeRequest({ content }));

			const storeB = createFileArtifactStore({ baseDir });
			const record = storeB.read(ref.id);
			expect(isMissingArtifactMarker(record)).toBe(false);
			if (!isMissingArtifactMarker(record)) expect(record.content).toBe(content);
		});

		it("has() and referenceCount() also work against a freshly recreated instance", () => {
			const storeA = createFileArtifactStore({ baseDir });
			const { ref } = storeA.write(makeRequest());
			storeA.addReference(ref.id, "holder-1");

			const storeB = createFileArtifactStore({ baseDir });
			expect(storeB.has(ref.id)).toBe(true);
			expect(storeB.referenceCount(ref.id)).toBe(1);
		});

		it("is content-addressed across instances: re-writing identical content+metadata returns the same ref", () => {
			const storeA = createFileArtifactStore({ baseDir });
			const first = storeA.write(makeRequest());

			const storeB = createFileArtifactStore({ baseDir });
			const second = storeB.write(makeRequest());

			expect(second.ref.id).toBe(first.ref.id);
			expect(generateArtifactId(makeRequest())).toBe(first.ref.id);
		});
	});

	describe("referenced cleanup safety survives recreation", () => {
		it("does not delete a referenced artifact, even from a freshly recreated store instance", () => {
			const storeA = createFileArtifactStore({ baseDir });
			const { ref } = storeA.write(makeRequest());
			storeA.addReference(ref.id, "context-item-1");

			// Reference state is persisted in holder markers, not just in memory, so a fresh
			// instance must still honor it.
			const storeB = createFileArtifactStore({ baseDir });
			const deleted = storeB.cleanup();

			expect(deleted).not.toContain(ref.id);
			expect(storeB.has(ref.id)).toBe(true);
		});

		it("deletes an unreferenced artifact from a freshly recreated store instance", () => {
			const storeA = createFileArtifactStore({ baseDir });
			const { ref } = storeA.write(makeRequest());

			const storeB = createFileArtifactStore({ baseDir });
			const deleted = storeB.cleanup();

			expect(deleted).toContain(ref.id);
			expect(storeB.has(ref.id)).toBe(false);
		});

		it("releasing the last reference on one instance allows a later instance's cleanup to collect it", () => {
			const storeA = createFileArtifactStore({ baseDir });
			const { ref } = storeA.write(makeRequest());
			storeA.addReference(ref.id, "holder-1");
			expect(storeA.cleanup()).not.toContain(ref.id);

			storeA.removeReference(ref.id, "holder-1");

			const storeB = createFileArtifactStore({ baseDir });
			const deleted = storeB.cleanup();
			expect(deleted).toContain(ref.id);
		});

		it("migrates legacy shared reference arrays to bounded holder markers", () => {
			const storeA = createFileArtifactStore({ baseDir });
			const { ref } = storeA.write(makeRequest());
			const metadataPath = join(baseDir, `${ref.id}.meta.json`);
			const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
				ref: typeof ref;
				references: string[];
			};
			metadata.references = ["legacy-holder"];
			writeFileSync(metadataPath, JSON.stringify(metadata), "utf8");

			const storeB = createFileArtifactStore({ baseDir });
			expect(storeB.referenceCount(ref.id)).toBe(1);
			expect((JSON.parse(readFileSync(metadataPath, "utf8")) as { references: string[] }).references).toEqual([]);
			expect(readdirSync(join(baseDir, `${ref.id}.refs`))).toHaveLength(1);
			expect(storeB.cleanup()).not.toContain(ref.id);
		});

		it("addReference/removeReference return false for an id that does not exist on disk", () => {
			const store = createFileArtifactStore({ baseDir });
			expect(store.addReference("0123456789abcdef01234567", "holder-1")).toBe(false);
			expect(store.removeReference("0123456789abcdef01234567", "holder-1")).toBe(false);
		});

		it("preserves every reference added concurrently by separate runtime tenants", async () => {
			const store = createFileArtifactStore({ baseDir });
			const { ref } = store.write(makeRequest());
			const workerPath = join(baseDir, "artifact-reference-worker.mjs");
			const artifactStoreModule = new URL("../src/core/context/context-artifacts.ts", import.meta.url).href;
			writeFileSync(
				workerPath,
				`import { createFileArtifactStore } from ${JSON.stringify(artifactStoreModule)};
import { parentPort, workerData } from "node:worker_threads";
const { baseDir, artifactId, prefix, iterations } = workerData;
const workerStore = createFileArtifactStore({ baseDir });
for (let index = 0; index < iterations; index++) {
	if (!workerStore.addReference(artifactId, prefix + index)) throw new Error("reference rejected");
}
parentPort.postMessage({ done: true });
`,
				"utf8",
			);
			const iterations = 150;

			await runSignaledWorkerThreads(workerPath, [
				{ baseDir, artifactId: ref.id, prefix: "foreground-", iterations },
				{ baseDir, artifactId: ref.id, prefix: "background-", iterations },
			]);

			expect(store.referenceCount(ref.id)).toBe(iterations * 2);
			const meta = JSON.parse(readFileSync(join(baseDir, `${ref.id}.meta.json`), "utf8")) as {
				references: string[];
			};
			expect(meta.references).toEqual([]);
			expect(readdirSync(join(baseDir, `${ref.id}.refs`))).toHaveLength(iterations * 2);
			expect(store.cleanup()).not.toContain(ref.id);
			expect(store.has(ref.id)).toBe(true);
		}, 20_000);
	});

	describe("missing artifact markers", () => {
		it("returns an explicit not_found marker for an id never written, never fabricated content", () => {
			const store = createFileArtifactStore({ baseDir });
			const record = store.read("0123456789abcdef01234567");

			expect(isMissingArtifactMarker(record)).toBe(true);
			if (isMissingArtifactMarker(record)) expect(record.reason).toBe("not_found");
			expect((record as { content?: unknown }).content).toBeUndefined();
		});

		it("returns a cleaned_up marker within the same instance that performed the cleanup", () => {
			const store = createFileArtifactStore({ baseDir });
			const { ref } = store.write(makeRequest());
			store.cleanup();

			const record = store.read(ref.id);
			expect(isMissingArtifactMarker(record)).toBe(true);
			if (isMissingArtifactMarker(record)) expect(record.reason).toBe("cleaned_up");
		});

		it("degrades to not_found (never a crash or fabricated content) for a cleaned-up id from a fresh instance", () => {
			// Documented limitation: only content/refs/references are persisted, not the
			// cleaned-up-vs-never-written distinction. This still always returns an
			// explicit missing marker.
			const storeA = createFileArtifactStore({ baseDir });
			const { ref } = storeA.write(makeRequest());
			storeA.cleanup();

			const storeB = createFileArtifactStore({ baseDir });
			const record = storeB.read(ref.id);
			expect(isMissingArtifactMarker(record)).toBe(true);
			if (isMissingArtifactMarker(record)) expect(record.reason).toBe("not_found");
		});
	});

	describe("path/id sanitization", () => {
		const maliciousIds = [
			"../../../etc/passwd",
			"..%2f..%2fetc%2fpasswd",
			"/etc/passwd",
			"a/../../b",
			"",
			"abc..xyz",
		];

		it.each(maliciousIds)("read() treats %j as missing rather than escaping baseDir", (maliciousId) => {
			const store = createFileArtifactStore({ baseDir });
			const record = store.read(maliciousId);
			expect(isMissingArtifactMarker(record)).toBe(true);
		});

		it.each(maliciousIds)("has()/addReference()/removeReference() safely reject %j", (maliciousId) => {
			const store = createFileArtifactStore({ baseDir });
			expect(store.has(maliciousId)).toBe(false);
			expect(store.addReference(maliciousId, "holder-1")).toBe(false);
			expect(store.removeReference(maliciousId, "holder-1")).toBe(false);
			expect(store.referenceCount(maliciousId)).toBe(0);
		});

		it("never creates any file outside baseDir for a path-traversal-shaped id", () => {
			// The parent must be PRIVATE to this test: baseDir sits directly in the shared OS
			// tmpdir, and snapshotting that hot directory races with unrelated processes.
			const privateParent = mkdtempSync(join(tmpdir(), "pi-file-artifact-parent-"));
			try {
				const isolatedBaseDir = join(privateParent, "store");
				mkdirSync(isolatedBaseDir);
				const beforeEntries = new Set(readdirSync(privateParent));
				const store = createFileArtifactStore({ baseDir: isolatedBaseDir });

				store.read("../escape-attempt");
				store.has("../escape-attempt");
				store.addReference("../escape-attempt", "holder-1");

				const afterEntries = new Set(readdirSync(privateParent));
				expect(afterEntries).toEqual(beforeEntries);
			} finally {
				rmSync(privateParent, { recursive: true, force: true });
			}
		});

		it("rejects an id containing a path separator even if it looks otherwise plausible", () => {
			const store = createFileArtifactStore({ baseDir });
			expect(store.has("abc123/def456")).toBe(false);
		});
	});

	describe("malformed metadata hardening", () => {
		const artifactId = "aaaaaaaaaaaaaaaaaaaaaaaa"; // valid-shaped hex id, hand-planted files

		function plantMalformedArtifact(rawMeta: string): void {
			writeFileSync(join(baseDir, `${artifactId}.payload`), "some payload", "utf8");
			writeFileSync(join(baseDir, `${artifactId}.meta.json`), rawMeta, "utf8");
		}

		it.each([
			["invalid JSON syntax", "{not json"],
			["empty object", "{}"],
			["ref is not an object", JSON.stringify({ ref: 123, references: [] })],
			["ref missing required fields", JSON.stringify({ ref: { id: artifactId }, references: [] })],
			[
				"ref.kind is not a known kind",
				JSON.stringify({
					ref: { id: artifactId, kind: "not_a_kind", byteLength: 1, createdAtTurn: 1, reproducible: true },
					references: [],
				}),
			],
			[
				"references is not an array",
				JSON.stringify({
					ref: { id: artifactId, kind: "tool_output", byteLength: 1, createdAtTurn: 1, reproducible: true },
					references: "nope",
				}),
			],
			[
				"references contains a non-string",
				JSON.stringify({
					ref: { id: artifactId, kind: "tool_output", byteLength: 1, createdAtTurn: 1, reproducible: true },
					references: [1, 2],
				}),
			],
		])("treats malformed metadata (%s) as missing/unusable, never crashes", (_label, rawMeta) => {
			plantMalformedArtifact(rawMeta);
			const store = createFileArtifactStore({ baseDir });

			expect(() => store.read(artifactId)).not.toThrow();
			const record = store.read(artifactId);
			expect(isMissingArtifactMarker(record)).toBe(true);

			expect(store.has(artifactId)).toBe(false);
			expect(store.addReference(artifactId, "holder-1")).toBe(false);
			expect(store.removeReference(artifactId, "holder-1")).toBe(false);
			expect(store.referenceCount(artifactId)).toBe(0);
		});

		it("cleanup() never crashes on malformed metadata and does not delete the unreadable artifact", () => {
			plantMalformedArtifact("{not json");
			const store = createFileArtifactStore({ baseDir });

			expect(() => store.cleanup()).not.toThrow();
			const deleted = store.cleanup();

			// Cannot confirm zero references from unreadable metadata, so it must not be
			// silently collected -- skip it rather than guess.
			expect(deleted).not.toContain(artifactId);
			expect(existsSync(join(baseDir, `${artifactId}.payload`))).toBe(true);
			expect(existsSync(join(baseDir, `${artifactId}.meta.json`))).toBe(true);
		});

		it("a valid artifact alongside a malformed one is unaffected", () => {
			plantMalformedArtifact("{not json");
			const store = createFileArtifactStore({ baseDir });
			const { ref } = store.write(makeRequest());

			const deleted = store.cleanup();

			expect(deleted).toContain(ref.id); // the valid, unreferenced one is still collected
			expect(deleted).not.toContain(artifactId); // the malformed one is left alone
		});
	});

	describe("baseDir creation", () => {
		it("creates baseDir recursively on first write, not construction", () => {
			const nested = join(baseDir, "nested", "artifacts");
			expect(existsSync(nested)).toBe(false);
			const store = createFileArtifactStore({ baseDir: nested });
			expect(existsSync(nested)).toBe(false);
			store.write(makeRequest());
			expect(existsSync(nested)).toBe(true);
		});

		it("tolerates baseDir already existing", () => {
			mkdirSync(baseDir, { recursive: true });
			expect(() => createFileArtifactStore({ baseDir })).not.toThrow();
		});
	});

	describe("readRef: metadata-only lookup", () => {
		it("returns the ref from the sidecar meta file, matching what write() returned", () => {
			const store = createFileArtifactStore({ baseDir });
			const { ref } = store.write(makeRequest());
			expect(store.readRef(ref.id)).toEqual(ref);
		});

		it("returns undefined for an id that was never written", () => {
			const store = createFileArtifactStore({ baseDir });
			expect(store.readRef("0123abcd")).toBeUndefined();
		});

		it("returns undefined once the payload file is gone, even if the meta sidecar still exists", () => {
			const store = createFileArtifactStore({ baseDir });
			const { ref } = store.write(makeRequest());
			rmSync(join(baseDir, `${ref.id}.payload`));

			expect(existsSync(join(baseDir, `${ref.id}.meta.json`))).toBe(true);
			expect(store.readRef(ref.id)).toBeUndefined();
			// Matches has()/read() semantics: a dangling meta file with no payload is treated
			// as not present, not as a usable ref.
			expect(store.has(ref.id)).toBe(false);
		});
	});
});
