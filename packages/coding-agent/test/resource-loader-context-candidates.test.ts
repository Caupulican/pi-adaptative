import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRawProjectContextFiles } from "../src/core/resource-loader.ts";

describe("project context candidates", () => {
	const roots: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("ignores context candidates that are directories", () => {
		const root = join(tmpdir(), `pi-context-candidates-${process.pid}-${Date.now()}`);
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, "AGENTS.md"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, "CLAUDE.md"), "Fallback instructions");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

		expect(loadRawProjectContextFiles({ cwd, agentDir })).toEqual([
			{ path: join(cwd, "CLAUDE.md"), rawContent: "Fallback instructions" },
		]);
		expect(consoleError).not.toHaveBeenCalled();
	});
});
