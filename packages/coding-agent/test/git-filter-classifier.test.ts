/**
 * The git filter classifier decides which bash commands the filter may run directly. Measured on
 * live sessions, 51 of 57 git calls were `cd <dir> && git …` or `git … | head`; the classifier used
 * to reject every one of them. It now accepts a leading `cd` (replayed into the session by the tool),
 * `-C`/`-c` global options, and a final bounding stage, and still leaves anything the shell would
 * interpret to the shell.
 */
import { describe, expect, it } from "vitest";
import { applyGitTailStage, classifyGitCommand } from "../src/core/tools/git-filter.ts";

describe("classifyGitCommand", () => {
	it("accepts a plain git invocation with global options", () => {
		expect(classifyGitCommand("git -C /repo/sub status --short")).toMatchObject({
			eligible: true,
			subcommand: "status",
			globalOptions: ["-C", "/repo/sub"],
			subcommandArgs: ["--short"],
		});
	});

	it("accepts a leading cd joined with && and reports it as the cwd prefix", () => {
		const classification = classifyGitCommand('cd "/repo/my project" && git status');
		expect(classification).toMatchObject({ eligible: true, subcommand: "status", cwdPrefix: "/repo/my project" });
		expect(classification.tailStage).toBeUndefined();
	});

	it("rejects a cd joined with ; or || because the git run would not depend on it", () => {
		expect(classifyGitCommand("cd /repo; git status").eligible).toBe(false);
		expect(classifyGitCommand("cd /repo || git status").eligible).toBe(false);
	});

	it("accepts a final head, tail or cat stage and nothing else after the pipe", () => {
		expect(classifyGitCommand("git log --oneline | head -20").tailStage).toEqual({ kind: "head", lines: 20 });
		expect(classifyGitCommand("git log --oneline | head -n 5").tailStage).toEqual({ kind: "head", lines: 5 });
		expect(classifyGitCommand("git diff | tail -40").tailStage).toEqual({ kind: "tail", lines: 40 });
		expect(classifyGitCommand("git status | cat").tailStage).toEqual({ kind: "cat" });
		expect(classifyGitCommand("git status | head").tailStage).toEqual({ kind: "head", lines: 10 });
		expect(classifyGitCommand("git status | wc -l").eligible).toBe(false);
		expect(classifyGitCommand("git status | grep modified").eligible).toBe(false);
		expect(classifyGitCommand("git log | head -5 | cat").eligible).toBe(false);
	});

	it("combines a cd prefix, global options and a tail stage", () => {
		expect(classifyGitCommand("cd /repo && git -C sub log --oneline -n 30 | head -10")).toMatchObject({
			eligible: true,
			cwdPrefix: "/repo",
			globalOptions: ["-C", "sub"],
			subcommand: "log",
			subcommandArgs: ["--oneline", "-n", "30"],
			tailStage: { kind: "head", lines: 10 },
		});
	});

	it("leaves shell-only syntax to the shell", () => {
		for (const command of [
			"git diff -- '*.cpp'",
			"git log $(git merge-base main HEAD)..HEAD",
			"git status > out.txt",
			"git status && echo done",
			"git status; git log",
			"git diff HEAD~1 # what changed",
		]) {
			expect(classifyGitCommand(command).eligible, command).toBe(false);
		}
	});

	it("rejects unsupported subcommands and unrelated tools", () => {
		expect(classifyGitCommand("git rebase -i main").eligible).toBe(false);
		expect(classifyGitCommand("cd /repo && ls").eligible).toBe(false);
	});

	it("honors the disable switches from the parent environment", () => {
		expect(classifyGitCommand("git status", { PI_GIT_FILTER_DISABLED: "1" }).eligible).toBe(false);
		expect(classifyGitCommand("git status", { PI_TOOL_FILTER_DISABLED: "1" }).eligible).toBe(false);
		expect(classifyGitCommand("git status", {}).eligible).toBe(true);
	});
});

describe("applyGitTailStage", () => {
	const text = "a\nb\nc\nd\n";
	it("keeps the first or last N lines like the shell stage would", () => {
		expect(applyGitTailStage(text, { kind: "head", lines: 2 })).toBe("a\nb\n");
		expect(applyGitTailStage(text, { kind: "tail", lines: 3 })).toBe("b\nc\nd\n");
	});
	it("returns the text unchanged for cat, no stage, or a bound larger than the text", () => {
		expect(applyGitTailStage(text, { kind: "cat" })).toBe(text);
		expect(applyGitTailStage(text, undefined)).toBe(text);
		expect(applyGitTailStage(text, { kind: "head", lines: 10 })).toBe(text);
	});
});
