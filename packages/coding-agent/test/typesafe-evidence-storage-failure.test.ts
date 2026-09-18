import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileArtifactStore } from "../src/core/context/context-artifacts.ts";
import { TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { createArtifactRetrieveToolDefinition } from "../src/core/tools/artifact-retrieve.ts";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Jev disk evidence failure provenance", () => {
	it.each([
		"absent",
		"valid",
		"invalid-json",
		"invalid-shape",
		"missing-metadata",
		"missing-payload",
		"payload-directory",
		"wrong-id",
	] as const)("does not disguise %s as an inherited record", async (state) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-jev-storage-"));
		directories.push(directory);
		const parent = new TypeSafeEvidenceStore(createFileArtifactStore({ baseDir: join(directory, "parent") }));
		const baseDir = join(directory, "child");
		const artifacts = createFileArtifactStore({ baseDir });
		const child = new TypeSafeEvidenceStore(artifacts, (operation) => operation(), [parent]);
		const record = { accepted: false, response: { choice: "contradicted", confidence: 0.99 } };
		const ref = parent.save("call", record);
		const original = parent.read(ref.id);
		const inheritedRead = vi.spyOn(parent, "read");
		if (state !== "absent") {
			expect(child.save("call", record)).toEqual(ref);
			const metadata = join(baseDir, `${ref.id}.meta.json`);
			const payload = join(baseDir, `${ref.id}.payload`);
			if (state === "invalid-json") writeFileSync(metadata, "{");
			if (state === "invalid-shape") writeFileSync(metadata, "{}");
			if (state === "missing-metadata") unlinkSync(metadata);
			if (state === "missing-payload" || state === "payload-directory") unlinkSync(payload);
			if (state === "payload-directory") mkdirSync(payload);
			if (state === "wrong-id") {
				const meta = JSON.parse(readFileSync(metadata, "utf8")) as { ref: { id: string } };
				meta.ref.id = "0".repeat(24);
				writeFileSync(metadata, JSON.stringify(meta));
			}
		}
		if (state === "absent" || state === "valid") {
			expect(child.read(ref.id)).toEqual(original);
			expect(inheritedRead).toHaveBeenCalledTimes(state === "absent" ? 1 : 0);
		} else {
			expect(artifacts.read(ref.id)).toMatchObject({ id: ref.id, missing: true, reason: "unavailable" });
			expect(() => child.read(ref.id)).toThrow("could not be read");
			expect(inheritedRead).not.toHaveBeenCalled();
			const tool = createArtifactRetrieveToolDefinition(directory, { artifactStore: artifacts });
			const result = await tool.execute("retrieve", { artifactId: ref.id }, undefined, undefined, {} as never);
			expect(result).toMatchObject({ details: { found: false } });
			expect(result.content).toEqual([
				{ type: "text", text: expect.stringContaining("Artifact could not be read") },
			]);
		}
	});
});
