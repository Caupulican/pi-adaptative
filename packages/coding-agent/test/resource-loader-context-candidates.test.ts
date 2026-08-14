import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProjectContextFiles, loadRawProjectContextFiles } from "../src/core/resource-loader.ts";

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

		expect(loadRawProjectContextFiles({ cwd, agentDir, includeProject: true })).toEqual([
			{ path: join(cwd, "CLAUDE.md"), rawContent: "Fallback instructions" },
		]);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("deduplicates filename-case aliases under Windows path semantics", () => {
		const root = join(tmpdir(), `pi-context-case-${process.pid}-${Date.now()}`);
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, "CLAUDE.md"), "Canonical instructions");
		if (process.platform !== "win32") writeFileSync(join(cwd, "CLAUDE.MD"), "Alias instructions");

		const files = loadRawProjectContextFiles({ cwd, agentDir, includeProject: true, platform: "win32" });

		expect(files).toHaveLength(1);
		expect(files[0]?.path.toLowerCase()).toBe(join(cwd, "CLAUDE.md").toLowerCase());
	});

	it("loads global agent-dir files when project discovery is disabled", () => {
		const root = join(tmpdir(), `pi-context-global-only-${process.pid}-${Date.now()}`);
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
		writeFileSync(join(agentDir, "AGENTS.md"), "Global instructions");

		expect(loadRawProjectContextFiles({ cwd, agentDir, includeProject: false })).toEqual([
			{ path: join(agentDir, "AGENTS.md"), rawContent: "Global instructions" },
		]);
	});

	it("defaults public and raw loaders to global files only", () => {
		const root = join(tmpdir(), `pi-context-default-off-${process.pid}-${Date.now()}`);
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, "AGENTS.md"), "Project standing rules");
		writeFileSync(join(agentDir, "AGENTS.md"), "Global standing rules");

		expect(loadRawProjectContextFiles({ cwd, agentDir })).toEqual([
			{ path: join(agentDir, "AGENTS.md"), rawContent: "Global standing rules" },
		]);
		expect(loadProjectContextFiles({ cwd, agentDir })).toEqual([
			{ path: join(agentDir, "AGENTS.md"), content: "Global standing rules" },
		]);
		expect(loadProjectContextFiles({ cwd, agentDir, includeProject: true })).toEqual([
			{ path: join(agentDir, "AGENTS.md"), content: "Global standing rules" },
			{ path: join(cwd, "AGENTS.md") },
		]);
	});
});
