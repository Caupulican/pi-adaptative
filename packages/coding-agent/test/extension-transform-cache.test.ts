/**
 * Tests for the extension loader's transform cache (extensions/loader.ts).
 *
 * loadExtensionModule() creates a fresh jiti instance per call with moduleCache:false so every
 * load produces a genuinely new module instance (required for hot reload isolation across
 * /reload, /new, /resume, /fork, and profile switch). That is orthogonal to the Babel *transform*
 * step: jiti has its own on-disk fsCache, keyed by a content hash of the source, which the loader
 * now points at an explicit directory under the agent dir instead of jiti's implicit
 * node_modules-or-tmpdir heuristic.
 *
 * These tests pin, at the fsCache-file level (jiti only rewrites a cache entry on a miss):
 * - a second load of an unchanged extension does not rewrite the cache (no re-transpile)
 * - editing the extension's source does force a rewrite (re-transpile picked up)
 * - rewriting the file with byte-identical content (mtime-only touch) does NOT force a rewrite
 *   (the cache is content-hash keyed, not mtime keyed, so it can't go stale on a no-op touch)
 * - module-level state still resets between loads despite the cached transform being reused,
 *   proving moduleCache:false's isolation guarantee survives the fsCache change
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtension } from "../src/core/extensions/loader.ts";

describe("Extension loader transform cache", () => {
	let cwdDir: string;
	let agentDir: string;
	let cacheDir: string;
	let previousAgentDirEnv: string | undefined;

	beforeEach(() => {
		cwdDir = mkdtempSync(join(tmpdir(), "pi-ext-transform-cache-cwd-"));
		agentDir = mkdtempSync(join(tmpdir(), "pi-ext-transform-cache-agentdir-"));
		cacheDir = join(agentDir, "cache", "jiti-transforms");
		previousAgentDirEnv = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		if (previousAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDirEnv;
		rmSync(cwdDir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	function cacheSnapshot(): Array<{ name: string; mtimeMs: number; content: string }> {
		if (!existsSync(cacheDir)) return [];
		return readdirSync(cacheDir)
			.sort()
			.map((name) => {
				const full = join(cacheDir, name);
				return { name, mtimeMs: statSync(full).mtimeMs, content: readFileSync(full, "utf8") };
			});
	}

	async function load(extFile: string) {
		const eventBus = createEventBus();
		const runtime = createExtensionRuntime();
		const { extension, error } = await loadExtension(extFile, cwdDir, eventBus, runtime);
		expect(error).toBeNull();
		return extension!;
	}

	it("does not rewrite the transform cache on a second load of an unchanged extension", async () => {
		const extFile = join(cwdDir, "unchanged.ts");
		writeFileSync(
			extFile,
			`export default (pi) => { pi.registerTool({ name: "t", label: "T", description: "v1", parameters: {}, execute: async () => ({}) }); };\n`,
		);

		await load(extFile);
		const afterFirst = cacheSnapshot();
		expect(afterFirst.length).toBeGreaterThan(0);

		await load(extFile);
		const afterSecond = cacheSnapshot();

		// Same set of cache files, same mtimes, same bytes: jiti served the second load from its
		// fsCache without invoking Babel again.
		expect(afterSecond).toEqual(afterFirst);
	});

	it("rewrites the transform cache when the extension source changes", async () => {
		const extFile = join(cwdDir, "edited.ts");
		writeFileSync(
			extFile,
			`export default (pi) => { pi.registerTool({ name: "t", label: "T", description: "v1", parameters: {}, execute: async () => ({}) }); };\n`,
		);
		const ext1 = await load(extFile);
		expect(ext1.tools.get("t")?.definition.description).toBe("v1");
		const afterFirst = cacheSnapshot();

		writeFileSync(
			extFile,
			`export default (pi) => { pi.registerTool({ name: "t", label: "T", description: "v2", parameters: {}, execute: async () => ({}) }); };\n`,
		);
		const ext2 = await load(extFile);
		expect(ext2.tools.get("t")?.definition.description).toBe("v2");
		const afterSecond = cacheSnapshot();

		// Same cache file(s) by name (same source path), but content differs: the edit was
		// re-transpiled rather than served stale from cache.
		expect(afterSecond.map((f) => f.name)).toEqual(afterFirst.map((f) => f.name));
		expect(afterSecond.map((f) => f.content)).not.toEqual(afterFirst.map((f) => f.content));
	});

	it("does not rewrite the cache when the file is rewritten with byte-identical content", async () => {
		const extFile = join(cwdDir, "touched.ts");
		const source = `export default (pi) => { pi.registerTool({ name: "t", label: "T", description: "same", parameters: {}, execute: async () => ({}) }); };\n`;
		writeFileSync(extFile, source);
		await load(extFile);
		const afterFirst = cacheSnapshot();

		// Rewrite with the exact same bytes (a mtime-only touch in effect).
		writeFileSync(extFile, source);
		await load(extFile);
		const afterSecond = cacheSnapshot();

		// Content-hash keying means an identical rewrite is still a cache hit, unlike a naive
		// mtime-keyed cache which would have invalidated here.
		expect(afterSecond).toEqual(afterFirst);
	});

	it("still gives every load a fresh module instance despite the cached transform", async () => {
		const extFile = join(cwdDir, "stateful.ts");
		writeFileSync(
			extFile,
			[
				"let counter = 0;",
				"export default (pi) => {",
				"\tcounter++;",
				'\tpi.registerTool({ name: "counter_tool", label: "Counter", description: "count=" + counter, parameters: {}, execute: async () => ({}) });',
				"};",
				"",
			].join("\n"),
		);

		const ext1 = await load(extFile);
		expect(ext1.tools.get("counter_tool")?.definition.description).toBe("count=1");

		const ext2 = await load(extFile);
		// If the module (not just its transformed source) were cached across loads, this would
		// read "count=2". moduleCache:false means top-level state resets every load.
		expect(ext2.tools.get("counter_tool")?.definition.description).toBe("count=1");
	});
});
