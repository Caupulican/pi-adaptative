import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSessionContext as buildUncachedSessionContext,
	CURRENT_SESSION_VERSION,
	SessionManager,
} from "../../src/session/session-manager.ts";

function header(id: string, cwd: string) {
	return {
		type: "session" as const,
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-07T00:00:00.000Z",
		cwd,
	};
}

function userEntry(id: string, parentId: string | null, content: string) {
	return {
		type: "message" as const,
		id,
		parentId,
		timestamp: "2026-08-07T00:00:01.000Z",
		message: { role: "user" as const, content, timestamp: 1 },
	};
}

describe("SessionManager malformed entry graphs", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function expectColdOpenRejection(entries: unknown[], expected: RegExp): void {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-invalid-graph-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "session.jsonl");
		const contents = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(sessionFile, contents);
		const scriptFile = join(dir, "open-session.mjs");
		const sessionManagerUrl = pathToFileURL(join(import.meta.dirname, "../../src/session/session-manager.ts")).href;
		writeFileSync(
			scriptFile,
			`import { SessionManager } from ${JSON.stringify(sessionManagerUrl)};\n` +
				`try {\n` +
				`  SessionManager.open(process.argv[2], process.argv[3], process.argv[3]);\n` +
				`  process.exitCode = 2;\n` +
				`} catch (error) {\n` +
				`  const message = error instanceof Error ? error.message : String(error);\n` +
				`  if (!${expected}.test(message)) { console.error(message); process.exitCode = 3; }\n` +
				`}\n`,
		);

		const child = spawnSync(process.execPath, ["--experimental-strip-types", scriptFile, sessionFile, dir], {
			encoding: "utf8",
			timeout: 2_000,
			maxBuffer: 1024 * 1024,
		});
		expect(child.error).toBeUndefined();
		expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
		expect(readFileSync(sessionFile, "utf8")).toBe(contents);
	}

	it("rejects a duplicate id that turns the leaf into its own parent", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-duplicate-fixture-"));
		tempDirs.push(dir);
		expectColdOpenRejection(
			[
				header("duplicate-session", dir),
				userEntry("duplicate", null, "first"),
				userEntry("duplicate", "duplicate", "second"),
			],
			/duplicate entry id/i,
		);
	});

	it("rejects an empty entry id without mutating the session file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-empty-id-fixture-"));
		tempDirs.push(dir);
		expectColdOpenRejection(
			[header("empty-id-session", dir), userEntry("", null, "empty id")],
			/non-empty string id/i,
		);
	});

	it("rejects a non-string parent id without mutating the session file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-parent-id-fixture-"));
		tempDirs.push(dir);
		expectColdOpenRejection(
			[header("malformed-parent-session", dir), { ...userEntry("child", null, "child"), parentId: 42 }],
			/malformed parent id/i,
		);
	});

	it("rejects a multi-entry parent cycle with unique ids", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-cycle-fixture-"));
		tempDirs.push(dir);
		expectColdOpenRejection(
			[header("cycle-session", dir), userEntry("first", "second", "first"), userEntry("second", "first", "second")],
			/parent cycle/i,
		);
	});

	it("preserves valid branches and documented orphan roots", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-valid-graph-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "session.jsonl");
		const entries = [
			header("valid-session", dir),
			userEntry("root", null, "root"),
			userEntry("main", "root", "main"),
			userEntry("branch", "root", "branch"),
			userEntry("orphan", "missing", "orphan"),
		];
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const session = SessionManager.open(sessionFile, dir, dir);
		expect(session.getTree().map((node) => node.entry.id)).toEqual(["root", "orphan"]);
		session.branch("branch");
		expect(
			session
				.buildSessionContext()
				.messages.map((message) =>
					message.role === "user" && typeof message.content === "string" ? message.content : "",
				),
		).toEqual(["root", "branch"]);
	});

	it("bounds every direct ancestry read after indexed entries are mutated into a cycle", () => {
		const session = SessionManager.inMemory("/repo");
		const rootId = session.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const childId = session.appendMessage({ role: "user", content: "child", timestamp: 2 });
		const root = session.getEntry(rootId);
		if (!root) throw new Error("Expected root entry.");
		root.parentId = childId;
		session.branch(childId);

		expect(() => session.getBranch()).toThrow(/parent cycle/i);
		expect(() => session.getLatestCustomEntryOnBranch("missing")).toThrow(/parent cycle/i);
		expect(() => session.getRecentUserInputHistory(100)).toThrow(/parent cycle/i);
		expect(() => session.buildSessionContext()).toThrow(/parent cycle/i);

		const entries = session.getEntries();
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		expect(() => buildUncachedSessionContext(entries, childId, byId)).toThrow(/parent cycle/i);
	});
});
