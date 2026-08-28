import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { afterEach, describe, expect, it } from "vitest";
import { PathAliasRuntime } from "../src/core/context/path-alias-session.ts";
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
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
		const databasePath = join(dir, "runtime.sqlite");
		const first = new PathAliasRuntime(
			() => "/repoA",
			() => databasePath,
			() => 1,
		);
		first.sync([toolResult("packages/coding-agent/src/foo.ts", 1)]);
		expect(first.peekTable().entries[0]).toEqual({ id: "p/foo.ts", path: "packages/coding-agent/src/foo.ts" });
		first.close();
		const second = new PathAliasRuntime(
			() => "/repoB",
			() => databasePath,
			() => 2,
		);
		second.sync([toolResult("hello", 2)]);
		expect(second.peekTable().entries[0]).toEqual({
			id: "p/foo.ts",
			path: "/repoA/packages/coding-agent/src/foo.ts",
		});
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
