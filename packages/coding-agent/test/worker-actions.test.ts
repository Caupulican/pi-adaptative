import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityEnvelope } from "../src/core/autonomy/contracts.ts";
import { applyWorkerActions, parseWorkerActions } from "../src/core/delegation/worker-actions.ts";

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
	// Real temp directories, real fs: the scope check (isPathWithinEnvelope -> safeRealpathSync)
	// always resolves against node:fs, so exercising it against anything else (an in-memory
	// fake) risks the scope decision and the actual write silently disagreeing about what a
	// path resolves to. One filesystem of record for both halves keeps the two in lockstep.
	let cwd: string;
	let envelope: CapabilityEnvelope;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "worker-actions-test-"));
		mkdirSync(join(cwd, "src", "secret"), { recursive: true });
		writeFileSync(join(cwd, "src", "b.ts"), "the foo value", "utf-8");
		envelope = {
			id: "env-write",
			capabilities: ["read_files", "write_files"],
			allowedPaths: ["src"],
			deniedPaths: ["src/secret"],
		};
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("applies in-scope writes and edits, tracking changed files", () => {
		const report = applyWorkerActions({
			actions: [
				{ op: "write", path: "src/a.ts", content: "new file" },
				{ op: "edit", path: "src/b.ts", old: "foo", new: "bar" },
			],
			envelope,
			cwd,
		});
		expect(report.changedFiles.sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(report.refused).toEqual([]);
		expect(readFileSync(join(cwd, "src", "a.ts"), "utf-8")).toBe("new file");
		expect(readFileSync(join(cwd, "src", "b.ts"), "utf-8")).toBe("the bar value");
	});

	it("REFUSES out-of-scope and denied paths at execution time — never silently writes them", () => {
		const report = applyWorkerActions({
			actions: [
				{ op: "write", path: "docs/leak.md", content: "x" },
				{ op: "write", path: "src/secret/key.pem", content: "x" },
				{ op: "write", path: "/etc/passwd", content: "x" },
			],
			envelope,
			cwd,
		});
		expect(report.changedFiles).toEqual([]);
		expect(report.refused.map((r) => r.path).sort()).toEqual(["/etc/passwd", "docs/leak.md", "src/secret/key.pem"]);
		expect(existsSync(join(cwd, "docs", "leak.md"))).toBe(false);
		expect(existsSync(join(cwd, "src", "secret", "key.pem"))).toBe(false);
	});

	it("reports failures (missing file / old-text absent) without aborting the batch", () => {
		const report = applyWorkerActions({
			actions: [
				{ op: "edit", path: "src/missing.ts", old: "x", new: "y" },
				{ op: "write", path: "src/ok.ts", content: "ok" },
			],
			envelope,
			cwd,
		});
		expect(report.failed.map((f) => f.path)).toEqual(["src/missing.ts"]);
		expect(report.changedFiles).toEqual(["src/ok.ts"]);
		expect(readFileSync(join(cwd, "src", "ok.ts"), "utf-8")).toBe("ok");
	});

	it("a write through a real directory symlink lands exactly where the (real-fs) scope check resolved it", () => {
		mkdirSync(join(cwd, "src", "real"), { recursive: true });
		symlinkSync(join(cwd, "src", "real"), join(cwd, "src", "alias"));

		const report = applyWorkerActions({
			actions: [{ op: "write", path: "src/alias/f.txt", content: "hi" }],
			envelope,
			cwd,
		});

		expect(report.refused).toEqual([]);
		expect(readFileSync(join(cwd, "src", "real", "f.txt"), "utf-8")).toBe("hi");
	});
});
