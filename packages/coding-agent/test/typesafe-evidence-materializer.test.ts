import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { TypeSafeEvidenceMaterializer } from "../src/core/review/typesafe-evidence-materializer.ts";
import { committedRepo } from "./git-fixture.ts";
import { tempDir } from "./temp-dir.ts";

describe("System One referenced evidence materialization", () => {
	it("snapshots scoped files with an exact local manifest and redacts known credentials", async () => {
		const cwd = tempDir("pi-typesafe-files-");
		const source = join(cwd, "source.ts");
		writeFileSync(source, "export const token = 'private-value';\n");
		const materializer = new TypeSafeEvidenceMaterializer({
			getCwd: () => cwd,
			credentialBoundary: {
				redactSensitiveText: (text) => text.replaceAll("private-value", "[REDACTED]"),
				protectedFiles: [],
				protectedDirectories: [],
			},
		});

		const result = await materializer.materialize(["file:source.ts"]);
		const submittedContent = "export const token = '[REDACTED]';\n";
		const sourceContent = "export const token = 'private-value';\n";
		expect(result.state.sources).toEqual([
			expect.objectContaining({
				id: "source-1",
				kind: "file",
				label: "source.ts",
				content: submittedContent,
				redacted: true,
				sha256: createHash("sha256").update(submittedContent).digest("hex"),
			}),
		]);
		expect(result.manifest).toEqual([
			expect.objectContaining({
				kind: "file",
				canonicalPath: source,
				redacted: true,
				sha256: createHash("sha256").update(sourceContent).digest("hex"),
			}),
		]);
	});

	it("materializes existing tool artifacts and bounded git diff snapshots", async () => {
		const cwd = committedRepo("pi-typesafe-references-");
		const artifacts = createInMemoryArtifactStore();
		const stored = artifacts.write({
			kind: "tool_output",
			toolName: "bash",
			command: "fixture",
			content: "targeted test passed\n",
			createdAtTurn: 1,
			reproducible: true,
		});
		writeFileSync(join(cwd, "README.md"), "two\n");
		const materializer = new TypeSafeEvidenceMaterializer({ getCwd: () => cwd, artifactStore: artifacts });

		const result = await materializer.materialize([`artifact:tool-output:${stored.ref.id}`, "git-diff:README.md"]);
		expect(result.state.sources[0]).toMatchObject({
			kind: "artifact",
			label: `bash:${stored.ref.id}`,
			content: "targeted test passed\n",
		});
		expect(result.state.sources[1]).toMatchObject({ kind: "git_diff", label: "working-tree diff: README.md" });
		expect(result.state.sources[1]?.content).toContain("-one");
		expect(result.state.sources[1]?.content).toContain("+two");
	});

	it("refuses paths outside the task, protected credential files, missing artifacts and oversized files", async () => {
		const cwd = tempDir("pi-typesafe-boundary-");
		const outside = tempDir("pi-typesafe-outside-");
		const secret = join(cwd, ".env");
		writeFileSync(secret, "TOKEN=secret\n");
		writeFileSync(join(cwd, "large.txt"), "x".repeat(512 * 1024 + 1));
		writeFileSync(join(cwd, "binary.dat"), Buffer.from([0xff, 0xfe, 0xfd]));
		const materializer = new TypeSafeEvidenceMaterializer({
			getCwd: () => cwd,
			artifactStore: createInMemoryArtifactStore(),
			credentialBoundary: {
				redactSensitiveText: (text) => text,
				protectedFiles: [secret],
				protectedDirectories: [],
			},
		});

		await expect(materializer.materialize([`file:${join(outside, "x")}`])).rejects.toThrow(
			"outside the task directory",
		);
		await expect(materializer.materialize(["file:.env"])).rejects.toThrow("protected credential");
		await expect(materializer.materialize(["artifact:000000000000000000000000"])).rejects.toThrow("not available");
		await expect(materializer.materialize(["file:large.txt"])).rejects.toThrow("exceeds 512 KiB");
		await expect(materializer.materialize(["file:binary.dat"])).rejects.toThrow("must be UTF-8 text");
	});
});
