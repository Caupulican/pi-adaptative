import { describe, expect, it } from "vitest";
import type { CapabilityEnvelope } from "../src/core/autonomy/contracts.ts";
import { applyWorkerActions, parseWorkerActions, type WorkerActionFs } from "../src/core/delegation/worker-actions.ts";

const envelope: CapabilityEnvelope = {
	id: "env-write",
	capabilities: ["read_files", "write_files"],
	allowedPaths: ["src"],
	deniedPaths: ["src/secret"],
};

function fakeFs(seed: Record<string, string> = {}): WorkerActionFs & { files: Record<string, string> } {
	const files = { ...seed };
	return {
		files,
		existsSync: ((path: string) => path in files) as WorkerActionFs["existsSync"],
		readFileSync: ((path: string) => files[path] ?? "") as WorkerActionFs["readFileSync"],
		writeFileSync: ((path: string, content: string) => {
			files[path] = content;
		}) as WorkerActionFs["writeFileSync"],
		mkdirSync: (() => undefined) as WorkerActionFs["mkdirSync"],
	};
}

describe("parseWorkerActions", () => {
	it("keeps only well-formed write/edit actions and caps the count", () => {
		const parsed = parseWorkerActions([
			{ op: "write", path: "src/a.ts", content: "x" },
			{ op: "edit", path: "src/b.ts", old: "foo", new: "bar" },
			{ op: "write", path: "src/c.ts" }, // missing content -> dropped
			{ op: "delete", path: "src/d.ts" }, // unknown op -> dropped
			{ op: "edit", path: "src/e.ts", old: "", new: "x" }, // empty old -> dropped
		]);
		expect(parsed.map((a) => a.path)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("ignores non-arrays", () => {
		expect(parseWorkerActions(undefined)).toEqual([]);
		expect(parseWorkerActions({ op: "write" })).toEqual([]);
	});
});

describe("applyWorkerActions (execution-time envelope enforcement)", () => {
	it("applies in-scope writes and edits, tracking changed files", () => {
		const fs = fakeFs({ [`${process.cwd()}/src/b.ts`]: "the foo value" });
		const report = applyWorkerActions({
			actions: [
				{ op: "write", path: "src/a.ts", content: "new file" },
				{ op: "edit", path: "src/b.ts", old: "foo", new: "bar" },
			],
			envelope,
			cwd: process.cwd(),
			fs,
		});
		expect(report.changedFiles.sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(report.refused).toEqual([]);
		expect(fs.files[`${process.cwd()}/src/b.ts`]).toBe("the bar value");
	});

	it("REFUSES out-of-scope and denied paths at execution time — never silently writes them", () => {
		const fs = fakeFs();
		const report = applyWorkerActions({
			actions: [
				{ op: "write", path: "docs/leak.md", content: "x" },
				{ op: "write", path: "src/secret/key.pem", content: "x" },
				{ op: "write", path: "/etc/passwd", content: "x" },
			],
			envelope,
			cwd: process.cwd(),
			fs,
		});
		expect(report.changedFiles).toEqual([]);
		expect(report.refused.map((r) => r.path).sort()).toEqual(["/etc/passwd", "docs/leak.md", "src/secret/key.pem"]);
		expect(Object.keys(fs.files)).toEqual([]);
	});

	it("reports failures (missing file / old-text absent) without aborting the batch", () => {
		const fs = fakeFs();
		const report = applyWorkerActions({
			actions: [
				{ op: "edit", path: "src/missing.ts", old: "x", new: "y" },
				{ op: "write", path: "src/ok.ts", content: "ok" },
			],
			envelope,
			cwd: process.cwd(),
			fs,
		});
		expect(report.failed.map((f) => f.path)).toEqual(["src/missing.ts"]);
		expect(report.changedFiles).toEqual(["src/ok.ts"]);
	});
});
