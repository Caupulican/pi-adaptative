// @isolated: mocks the filtered Git boundary and controls managed output directories
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@caupulican/pi-agent-core/truncate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./temp-dir.ts";

const executeFilteredGitMock = vi.hoisted(() => vi.fn());

vi.mock("../src/core/tools/git-filter.ts", () => ({
	applyGitTailStage: (output: string) => output,
	classifyGitCommand: () => ({
		eligible: true,
		globalOptions: [],
		subcommand: "show",
		subcommandArgs: ["HEAD:large.txt"],
	}),
	executeFilteredGit: executeFilteredGitMock,
}));

import { createBashTool } from "../src/core/tools/bash.ts";

const retainedHead = Buffer.from(`retained-head\n${"x".repeat(DEFAULT_MAX_BYTES)}`, "utf-8");

beforeEach(() => {
	executeFilteredGitMock.mockReset();
});

describe("filtered Git artifact handoff", () => {
	it("publishes the Git owner's complete artifact and removes its retained-head copy", async () => {
		const root = tempDir("pi-bash-git-handoff-");
		const outputDirectory = tempDir("pi-bash-git-handoff-output-");
		const authoritativePath = join(root, "complete-git-output.log");
		writeFileSync(authoritativePath, "complete-start\ncomplete-end\n");
		executeFilteredGitMock.mockResolvedValue({
			output: `filtered view\n\n[Full output: ${authoritativePath}]`,
			exitCode: 0,
			rawOut: retainedHead.toString("utf-8"),
			fullOutputPath: authoritativePath,
		});
		const bash = createBashTool(root, { outputDirectory });

		const result = await bash.execute("handoff", { command: "git show HEAD:large.txt" });

		expect(result.details?.fullOutputPath).toBe(authoritativePath);
		expect(readFileSync(result.details?.fullOutputPath ?? "", "utf-8")).toContain("complete-end");
		expect(readdirSync(outputDirectory)).toEqual([]);
	});

	it("discloses unavailable full output without publishing a retained-head copy", async () => {
		const root = tempDir("pi-bash-git-loss-");
		const outputDirectory = tempDir("pi-bash-git-loss-output-");
		executeFilteredGitMock.mockResolvedValue({
			output: "filtered view\n\n[git output overflow spill failed; output beyond the retained head was lost]",
			exitCode: 0,
			rawOut: retainedHead.toString("utf-8"),
		});
		const bash = createBashTool(root, { outputDirectory });

		const result = await bash.execute("loss", { command: "git show HEAD:large.txt" });

		expect(result.details?.fullOutputPath).toBeUndefined();
		expect(result.details?.fullOutputError).toContain("complete filtered Git output is unavailable");
		expect(readdirSync(outputDirectory)).toEqual([]);
	});

	it("persists complete raw Git output when the filter retained every byte", async () => {
		const root = tempDir("pi-bash-git-complete-");
		const outputDirectory = tempDir("pi-bash-git-complete-output-");
		executeFilteredGitMock.mockResolvedValue({
			output: "filtered view",
			exitCode: 0,
			rawOut: retainedHead.toString("utf-8"),
			rawBytes: retainedHead,
		});
		const bash = createBashTool(root, { outputDirectory });

		const result = await bash.execute("complete", { command: "git show HEAD:large.txt" });

		expect(result.details?.fullOutputPath).toBeDefined();
		expect(readFileSync(result.details?.fullOutputPath ?? "")).toEqual(retainedHead);
	});

	it("preserves authoritative artifact identity on a nonzero Git outcome", async () => {
		const root = tempDir("pi-bash-git-error-");
		const outputDirectory = tempDir("pi-bash-git-error-output-");
		const authoritativePath = join(root, "complete-git-error.log");
		writeFileSync(authoritativePath, "complete error diagnostics\n");
		executeFilteredGitMock.mockResolvedValue({
			output: "filtered error",
			exitCode: 1,
			rawOut: retainedHead.toString("utf-8"),
			fullOutputPath: authoritativePath,
		});
		const bash = createBashTool(root, { outputDirectory });

		await expect(bash.execute("error", { command: "git show HEAD:large.txt" })).rejects.toThrow(authoritativePath);
		expect(readdirSync(outputDirectory)).toEqual([]);
	});
});
