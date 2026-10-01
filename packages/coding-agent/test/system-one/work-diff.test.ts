import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { captureWorkBaseline, hasRepositoryOutcome, readWorkDiff } from "../../src/core/system-one/work-diff.ts";
import { committedRepo } from "../git-fixture.ts";
import { tempDir } from "../temp-dir.ts";

it("captures an unborn repository without turning existing files into goal changes", () => {
	const cwd = tempDir("unborn-work-baseline-");
	execFileSync("git", ["init", "--quiet"], { cwd });
	writeFileSync(join(cwd, "owner.txt"), "pre-existing owner note\n");
	const baseline = captureWorkBaseline(cwd)!;
	expect(baseline).toBeDefined();
	expect(baseline.revision).toBe("unborn");
	expect(hasRepositoryOutcome(readWorkDiff(cwd, baseline))).toBe(false);
	writeFileSync(join(cwd, "goal.txt"), "new goal work\n");
	const work = readWorkDiff(cwd, baseline);
	expect(work.patch).toContain("+new goal work");
	expect(work.patch).not.toContain("+pre-existing owner note");
});

it("does not attribute pre-existing dirty and untracked work to a planning goal", () => {
	const cwd = committedRepo("planning-work-attribution-");
	writeFileSync(join(cwd, "README.md"), "pre-existing owner edit\n");
	writeFileSync(join(cwd, "owner-note.txt"), "pre-existing owner note\n");
	const baseline = captureWorkBaseline(cwd)!;
	expect(baseline).toBeDefined();
	const work = readWorkDiff(cwd, baseline);
	expect(hasRepositoryOutcome(work)).toBe(false);
});

it("measures new edits from the dirty bytes and includes new file contents", () => {
	const cwd = committedRepo("dirty-work-baseline-");
	writeFileSync(join(cwd, "README.md"), "pre-existing owner edit\n");
	writeFileSync(join(cwd, "owner-note.txt"), "pre-existing owner note\n");
	const baseline = captureWorkBaseline(cwd)!;
	writeFileSync(join(cwd, "README.md"), "pre-existing owner edit\ncurrent goal edit\n");
	writeFileSync(join(cwd, "owner-note.txt"), "pre-existing owner note\ncurrent note edit\n");
	writeFileSync(join(cwd, "new.txt"), "current goal addition\n");
	const work = readWorkDiff(cwd, baseline);
	expect(hasRepositoryOutcome(work)).toBe(true);
	expect(work.patch).toContain("+current goal edit");
	expect(work.patch).toContain("+current note edit");
	expect(work.patch).toContain("+current goal addition");
	expect(work.patch).not.toContain("+pre-existing owner edit");
	expect(work.untracked).toEqual(["new.txt"]);
});

it("retains commits made after admission without attributing other observed paths", () => {
	const cwd = committedRepo("committed-work-baseline-");
	const baseline = captureWorkBaseline(cwd)!;
	writeFileSync(join(cwd, "README.md"), "goal edit\n");
	execFileSync("git", ["commit", "-qam", "goal edit"], { cwd });
	writeFileSync(join(cwd, "unrelated.txt"), "parallel session\n");
	const work = readWorkDiff(cwd, baseline, ["README.md"]);
	expect(work.patch).toContain("+goal edit");
	expect(work.patch).not.toContain("parallel session");
	expect(work.untracked).toEqual([]);
});

it("snapshots staged edits without changing the real index, HEAD, or worktree", () => {
	const cwd = committedRepo("private-work-index-");
	writeFileSync(join(cwd, "README.md"), "staged owner edit\n");
	execFileSync("git", ["add", "README.md"], { cwd });
	writeFileSync(join(cwd, "README.md"), "unstaged owner edit\n");
	const index = readFileSync(join(cwd, ".git", "index"));
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
	const baseline = captureWorkBaseline(cwd)!;
	expect(baseline).toBeDefined();
	expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index);
	expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" })).toBe(head);
	expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("unstaged owner edit\n");
	expect(hasRepositoryOutcome(readWorkDiff(cwd, baseline))).toBe(false);
});

it("handles removed tracked and pre-existing untracked files", () => {
	const cwd = committedRepo("deleted-work-baseline-");
	writeFileSync(join(cwd, "old.txt"), "owner note\n");
	const baseline = captureWorkBaseline(cwd)!;
	unlinkSync(join(cwd, "README.md"));
	unlinkSync(join(cwd, "old.txt"));
	const work = readWorkDiff(cwd, baseline);
	expect(work.patch).toContain("-one");
	expect(work.patch).toContain("-owner note");
	expect(hasRepositoryOutcome(work)).toBe(true);
});

it("uses literal mutation paths including spaces and pathspec characters", () => {
	const cwd = committedRepo("literal-work-path-");
	const baseline = captureWorkBaseline(cwd)!;
	writeFileSync(join(cwd, "[goal] file.txt"), "goal\n");
	writeFileSync(join(cwd, "g file.txt"), "unrelated\n");
	const work = readWorkDiff(cwd, baseline, ["[goal] file.txt"]);
	expect(work.patch).toContain("+goal");
	expect(work.patch).not.toContain("+unrelated");
});

it("never borrows another repository baseline or hides unavailable mutation evidence", () => {
	const first = committedRepo("first-work-root-");
	const second = committedRepo("second-work-root-");
	const baseline = captureWorkBaseline(first)!;
	const mismatch = readWorkDiff(second, baseline);
	expect(mismatch.diagnostic).toBeDefined();
	expect(hasRepositoryOutcome(mismatch)).toBe(true);
	expect(captureWorkBaseline(tempDir("unversioned-work-root-"))).toBeUndefined();
});

it("reads raw outcome evidence without executing repository text conversion commands", () => {
	const cwd = committedRepo("raw-work-evidence-");
	const scratch = tempDir("work-evidence-textconv-");
	const marker = join(scratch, "invoked.txt");
	const script = join(scratch, "textconv.cjs");
	writeFileSync(
		script,
		`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked'); process.stdout.write('converted');`,
	);
	execFileSync("git", ["config", "diff.pi.textconv", `"${process.execPath}" "${script}"`], { cwd });
	writeFileSync(join(cwd, ".gitattributes"), "README.md diff=pi\n");
	const baseline = captureWorkBaseline(cwd)!;
	writeFileSync(join(cwd, "README.md"), "raw goal evidence\n");
	const work = readWorkDiff(cwd, baseline);
	expect(existsSync(marker)).toBe(false);
	expect(work.patch).toContain("+raw goal evidence");
	execFileSync("git", ["diff", "--textconv", baseline.tree, "--", "README.md"], { cwd });
	expect(existsSync(marker)).toBe(true);
});
