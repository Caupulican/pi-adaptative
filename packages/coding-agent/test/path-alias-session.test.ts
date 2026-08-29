import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { afterEach, describe, expect, it } from "vitest";
import { loadPathAliasTableReadOnly, PathAliasRuntime } from "../src/core/context/path-alias-session.ts";
import { createSqlitePathAliasStore } from "../src/core/context/sqlite-runtime-index.ts";

function toolResult(text: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `t-${timestamp}`,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

describe("PathAliasRuntime", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		// maxRetries/retryDelay: on Windows a just-closed sqlite handle can hold a
		// transient AV/indexer lock past close() returning — plain force:true does not
		// retry EPERM. Same pattern as test/auto-learn-spawn.test.ts.
		for (const dir of tempDirs.splice(0))
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});

	it("resumes frozen aliases from sqlite without rescanning older messages", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-path-alias-runtime-"));
		tempDirs.push(dir);
		const databasePath = join(dir, "runtime.sqlite");
		const first = new PathAliasRuntime(
			() => "/repo",
			() => databasePath,
			() => 1,
		);
		const firstSync = first.sync([
			toolResult("packages/coding-agent/src/foo.ts", 10),
			toolResult("packages/coding-agent/test/foo.ts", 11),
		]);
		expect(firstSync.legend).toContain("p/src/foo.ts=packages/coding-agent/src/foo.ts");
		expect(firstSync.legend).toContain("p/test/foo.ts=packages/coding-agent/test/foo.ts");
		first.close();

		const second = new PathAliasRuntime(
			() => "/repo",
			() => databasePath,
			() => 2,
		);
		const resumed = second.sync([toolResult("packages/coding-agent/src/foo.ts", 11)]);
		expect(resumed.legend).toContain("p/src/foo.ts=packages/coding-agent/src/foo.ts");
		expect(resumed.legend).not.toContain("p/test/foo.ts=packages/coding-agent/test/foo.ts");
		expect(second.peekTable().entries.find((entry) => entry.path.endsWith("/src/foo.ts"))?.id).toBe("p/src/foo.ts");
		expect(second.peekTable().entries.find((entry) => entry.path.endsWith("/test/foo.ts"))?.id).toBe("p/test/foo.ts");
		second.close();
	});

	it("keeps alias meaning anchored to the original file when resumed under a different cwd", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-path-alias-runtime-"));
		tempDirs.push(dir);
		// Real OS-absolute directories (drive-letter-bearing on Windows) rather than a
		// literal posix "/repoA" string, which node:path treats as current-drive-relative
		// on Windows and so is not actually absolute there.
		const cwdA = mkdtempSync(join(tmpdir(), "pi-path-alias-repoA-"));
		tempDirs.push(cwdA);
		const cwdB = mkdtempSync(join(tmpdir(), "pi-path-alias-repoB-"));
		tempDirs.push(cwdB);
		const databasePath = join(dir, "runtime.sqlite");
		const first = new PathAliasRuntime(
			() => cwdA,
			() => databasePath,
			() => 1,
		);
		first.sync([toolResult("packages/coding-agent/src/foo.ts", 1)]);
		expect(first.peekTable().entries[0]).toEqual({ id: "p/foo.ts", path: "packages/coding-agent/src/foo.ts" });
		first.close();
		const second = new PathAliasRuntime(
			() => cwdB,
			() => databasePath,
			() => 2,
		);
		second.sync([toolResult("hello", 2)]);
		const entry = second.peekTable().entries[0];
		expect(entry?.id).toBe("p/foo.ts");
		// The invariant: whichever spelling (relative or absolute) the display picker
		// chose against the NEW cwd, resolving it must still land on the ORIGINAL file —
		// not on a same-named file that happened to exist under the new cwd.
		const resolved = pathResolve(cwdB, entry?.path ?? "");
		expect(resolved).toBe(pathResolve(cwdA, "packages/coding-agent/src/foo.ts"));
		second.close();
	});

	it("interprets legacy relative rows and reserves p/ tokens from already-scanned history", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-path-alias-runtime-"));
		tempDirs.push(dir);
		const databasePath = join(dir, "runtime.sqlite");
		// Legacy database: relative fullPath row, advanced scan timestamp, no cwd or
		// reservation metadata.
		const legacy = createSqlitePathAliasStore({ databasePath });
		legacy.upsert({ fullPath: "packages/app/src/legacy-loader.ts", aliasId: "p/legacy-loader.ts", createdAtTurn: 1 });
		legacy.setMeta("last_scanned_timestamp", "5");
		legacy.close();
		const runtime = new PathAliasRuntime(
			() => "/repo",
			() => databasePath,
			() => 2,
		);
		const result = runtime.sync([
			toolResult("read p/config-loader.ts today", 1),
			toolResult("packages/app/src/config-loader.ts", 6),
		]);
		const byPath = new Map(runtime.peekTable().entries.map((entry) => [entry.path, entry.id]));
		expect(byPath.get("packages/app/src/legacy-loader.ts")).toBe("p/legacy-loader.ts");
		expect(byPath.get("packages/app/src/config-loader.ts")).toBe("p/src/config-loader.ts");
		expect(result.messages).toHaveLength(2);
		runtime.close();
	});

	it("avoids alias ids that collide with an on-disk p/ directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-path-alias-runtime-"));
		tempDirs.push(dir);
		const cwd = join(dir, "repo");
		mkdirSync(join(cwd, "p"), { recursive: true });
		writeFileSync(join(cwd, "p", "util-helpers.ts"), "");
		const runtime = new PathAliasRuntime(
			() => cwd,
			() => join(dir, "runtime.sqlite"),
			() => 1,
		);
		runtime.sync([toolResult("packages/app/src/util-helpers.ts", 1)]);
		const entry = runtime.peekTable().entries[0];
		expect(entry?.path).toBe("packages/app/src/util-helpers.ts");
		expect(entry?.id).toBe("p/src/util-helpers.ts");
		runtime.close();
	});

	it("reserves observed real p/ paths durably across sessions", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-path-alias-runtime-"));
		tempDirs.push(dir);
		const databasePath = join(dir, "runtime.sqlite");
		const first = new PathAliasRuntime(
			() => "/repo",
			() => databasePath,
			() => 1,
		);
		first.sync([toolResult("read p/config-loader.ts today", 1)]);
		expect(first.peekTable().entries).toHaveLength(0);
		first.close();
		const second = new PathAliasRuntime(
			() => "/repo",
			() => databasePath,
			() => 2,
		);
		second.sync([toolResult("packages/app/src/config-loader.ts", 2)]);
		const entry = second.peekTable().entries[0];
		expect(entry?.id).toBe("p/src/config-loader.ts");
		second.close();
	});

	it("persists a new path when every suffix alias_id is already stored", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-path-alias-runtime-"));
		tempDirs.push(dir);
		const databasePath = join(dir, "runtime.sqlite");
		const runtime = new PathAliasRuntime(
			() => "/repo",
			() => databasePath,
			() => 1,
		);
		runtime.sync([toolResult("a/b/foo.ts", 1)]);
		runtime.sync([toolResult("a/src/foo.ts", 2)]);
		runtime.sync([toolResult("a/coding-agent/src/foo.ts", 3)]);
		expect(() => runtime.sync([toolResult("coding-agent/src/foo.ts", 4)])).not.toThrow();
		const ids = runtime.peekTable().entries.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain("p/2/coding-agent/src/foo.ts");
		runtime.close();
	});
});

describe("loadPathAliasTableReadOnly", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0))
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});

	it("returns undefined and creates nothing when the database file does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-path-alias-readonly-"));
		tempDirs.push(dir);
		const databasePath = join(dir, "missing", "runtime.sqlite");

		expect(loadPathAliasTableReadOnly("/repo", databasePath)).toBeUndefined();

		// The whole point of the ENOENT-class degradation: never create the file or its directory.
		expect(existsSync(databasePath)).toBe(false);
		expect(existsSync(join(dir, "missing"))).toBe(false);
	});

	it("reads rows already on disk without minting, extending, or writing back the table_cwd backfill", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-path-alias-readonly-"));
		tempDirs.push(dir);
		const databasePath = join(dir, "runtime.sqlite");
		// A legacy row with no table_cwd meta set — ensureLoaded() would normally backfill that key
		// on load; the read-only path must not.
		const store = createSqlitePathAliasStore({ databasePath });
		store.upsert({ fullPath: "/repo/packages/app/src/foo.ts", aliasId: "p/foo.ts", createdAtTurn: 1 });
		store.close();
		const before = readFileSync(databasePath);

		const table = loadPathAliasTableReadOnly("/repo", databasePath);

		expect(table?.entries).toEqual([{ id: "p/foo.ts", path: "packages/app/src/foo.ts" }]);
		const after = readFileSync(databasePath);
		expect(after.equals(before)).toBe(true);

		// Confirm directly: a live runtime opening the same file afterward still sees no table_cwd
		// (i.e. this read never performed the backfill ensureLoaded() would have done).
		const verify = createSqlitePathAliasStore({ databasePath });
		expect(verify.getMeta("table_cwd")).toBeUndefined();
		verify.close();
	});

	it("propagates a non-ENOENT read failure instead of silently degrading", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-path-alias-readonly-"));
		tempDirs.push(dir);
		const databasePath = join(dir, "runtime.sqlite");
		// A file that exists but is not a valid sqlite database at all: this must not be confused
		// with the documented ENOENT-class degradation.
		writeFileSync(databasePath, "not a sqlite database");

		expect(() => loadPathAliasTableReadOnly("/repo", databasePath)).toThrow();
	});
});
