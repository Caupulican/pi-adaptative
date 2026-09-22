import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CodeDuplicateReviewer,
	type CodeUnit,
	extractCodeUnits,
	harnessFileLister,
	isTestPath,
	newCodeUnits,
	SemanticUnitIndex,
	scanSemanticDuplicates,
} from "../../src/core/system-one/code-duplicates.ts";

const EXISTING = `export function normalizeRepositoryPath(rawPath: string, repositoryRoot: string): string {
	const trimmed = rawPath.trim().replaceAll("\\\\", "/");
	const absolute = trimmed.startsWith("/") ? trimmed : \`\${repositoryRoot}/\${trimmed}\`;
	return absolute.replace(/\\/+/g, "/");
}
`;

const DUPLICATE = `export const toRepoPath = (candidatePath: string, repositoryRoot: string): string => {
	const cleaned = candidatePath.trim().replaceAll("\\\\", "/");
	const joined = cleaned.startsWith("/") ? cleaned : \`\${repositoryRoot}/\${cleaned}\`;
	return joined.replace(/\\/+/g, "/");
};
`;

describe("semantic code deduplication", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function repo(): string {
		const root = mkdtempSync(join(tmpdir(), "pi-dedup-"));
		dirs.push(root);
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "paths.ts"), EXISTING);
		return root;
	}

	it("extracts function, arrow, method and python units with their bodies", () => {
		const ts = `${EXISTING}\nclass A {\n\tresolveOwner(id: string): string {\n\t\tconst owner = id.trim();\n\t\treturn owner;\n\t}\n}\n`;
		expect(extractCodeUnits("a.ts", ts).map((u) => u.name)).toEqual(["normalizeRepositoryPath", "resolveOwner"]);
		expect(extractCodeUnits("b.ts", DUPLICATE).map((u) => u.name)).toEqual(["toRepoPath"]);
		const py = "def load_rows(path):\n    with open(path) as f:\n        return f.read().splitlines()\n\nx = 1\n";
		expect(extractCodeUnits("c.py", py).map((u) => [u.name, u.code.split("\n").length])).toEqual([["load_rows", 3]]);
	});

	it("reports only units an edit adds, not ones it keeps", () => {
		const kept = newCodeUnits(
			"edit",
			{ path: "src/paths.ts", edits: [{ oldText: EXISTING, newText: `${EXISTING}\n` }] },
			"/r",
		);
		expect(kept).toEqual([]);
		const added = newCodeUnits(
			"edit",
			{ path: "src/b.ts", edits: [{ oldText: "// end", newText: DUPLICATE }] },
			"/r",
		);
		expect(added.map((u) => u.name)).toEqual(["toRepoPath"]);
	});

	it("recognizes test files so production code is never pointed at a test helper", () => {
		expect(isTestPath("packages/tui/test/markdown.test.ts")).toBe(true);
		expect(isTestPath("src/a.spec.ts")).toBe(true);
		expect(isTestPath("tests/test_io.py")).toBe(true);
		expect(isTestPath("packages/tui/src/autocomplete.ts")).toBe(false);
	});

	it("lists source files through the harness find tool", async () => {
		const root = repo();
		expect(await harnessFileLister(root, "**/*.{ts,js}")).toEqual(["src/paths.ts"]);
	});

	it("indexes units and ranks a semantic rewrite by its rare calls; a renamed copy is a structural clone", async () => {
		const root = repo();
		writeFileSync(
			join(root, "src", "other.ts"),
			"export function logLine(message: string): void {\n\tconst stamp = Date.now();\n\tconsole.log(stamp, message);\n}\n",
		);
		const index = new SemanticUnitIndex(root, "**/*.ts", harnessFileLister);
		await index.refresh();
		const [semantic] = newCodeUnits("write", { path: "src/new.ts", content: DUPLICATE }, root);
		const found = index.candidates(semantic!);
		expect(found.map((c) => c.unit.name)).toEqual(["normalizeRepositoryPath"]);
		const renamed = EXISTING.replaceAll("rawPath", "input")
			.replaceAll("repositoryRoot", "base")
			.replace("normalizeRepositoryPath", "fixPath");
		const [copy] = newCodeUnits("write", { path: "src/copy.ts", content: renamed }, root);
		expect(index.candidates(copy!)[0]?.structuralSimilarity).toBe(1);
	});

	it("asks Jev once for every new unit and candidate, and steers only on a decisive duplicate", async () => {
		const root = repo();
		const calls: { unit: CodeUnit; candidates: readonly CodeUnit[] }[][] = [];
		const warnings: string[] = [];
		const reviewer = new CodeDuplicateReviewer({
			getController: () => ({
				evaluateCodeDuplicates: async (pairs) => {
					calls.push([...pairs]);
					return {
						same_responsibility_u0c0: { type: "noul", noul: 0.97, band: "hard_pass", direction: "required_true" },
					};
				},
			}),
			warn: (message) => warnings.push(message),
		});
		const note = await reviewer.review("write", { path: "src/new.ts", content: DUPLICATE }, root);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]?.candidates.map((c) => c.name)).toEqual(["normalizeRepositoryPath"]);
		expect(note).toContain("toRepoPath (src/new.ts:1) does the same job as normalizeRepositoryPath (src/paths.ts:1)");
		expect(warnings).toEqual([
			"Duplicate logic: toRepoPath (src/new.ts) does the same job as normalizeRepositoryPath (src/paths.ts:1)",
		]);
	});

	it("an outage adds no note and is reported once", async () => {
		const root = repo();
		const warnings: string[] = [];
		const reviewer = new CodeDuplicateReviewer({
			getController: () => ({
				evaluateCodeDuplicates: async () => {
					throw new Error("jev down");
				},
			}),
			warn: (message) => warnings.push(message),
		});
		expect(await reviewer.review("write", { path: "src/new.ts", content: DUPLICATE }, root)).toBeUndefined();
		expect(await reviewer.review("write", { path: "src/new2.ts", content: DUPLICATE }, root)).toBeUndefined();
		expect(warnings).toHaveLength(1);
	});

	it("a repository scan judges each unordered pair once, batched across concurrent requests", async () => {
		const root = repo();
		writeFileSync(join(root, "src", "copy.ts"), DUPLICATE);
		const index = new SemanticUnitIndex(root, "**/*.ts", harnessFileLister);
		await index.refresh();
		let requests = 0;
		const scan = await scanSemanticDuplicates({
			index,
			controller: {
				evaluateCodeDuplicates: async (pairs) => {
					requests += 1;
					return Object.fromEntries(
						pairs.map((_, i) => [`same_responsibility_u${i}c0`, { type: "noul", noul: 0.97 }]),
					);
				},
			},
			concurrency: 2,
		});
		expect(scan.pairs).toBe(1);
		expect(requests).toBe(1);
		expect(scan.verdicts.map((v) => [v.unit.name, v.candidate.name, v.band].sort())).toEqual([
			["hard_pass", "normalizeRepositoryPath", "toRepoPath"],
		]);
	});
});
