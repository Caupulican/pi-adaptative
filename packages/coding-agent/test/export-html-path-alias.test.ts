/**
 * HTML export must render real paths, never `p/` alias tokens (P2 — display integrity), and must
 * do so without ever writing to the session's alias store: export operates on a session that may
 * not be the live one, and `sync()`'s mint/extend/backfill side effects would corrupt a closed
 * session's store. See core/export-html/index.ts's loadExportPathAliasTable/expandEntriesForExport
 * and core/context/path-alias-session.ts's loadPathAliasTableReadOnly.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getContextStoreDir } from "../src/core/context/context-store-retention.ts";
import { createSqlitePathAliasStore } from "../src/core/context/sqlite-runtime-index.ts";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";

const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function appendAliasedAssistantMessage(session: SessionManager, text: string): void {
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

function extractSessionData(html: string): unknown {
	const match = html.match(/<script id="session-data" type="application\/json">([^<]*)<\/script>/);
	if (!match?.[1]) throw new Error("session-data script tag not found in exported HTML");
	return JSON.parse(Buffer.from(match[1], "base64").toString("utf-8"));
}

/**
 * Content hash of every file in the alias store's directory (not just `runtime.sqlite` itself):
 * the store is WAL-mode (`createSqlitePathAliasStore`'s `close()` runs `wal_checkpoint(TRUNCATE)`),
 * so a read-write open — the bug a correct read-only loader must avoid — could leave behind
 * `-wal`/`-shm` sidecars next to the main file without changing the main file's own bytes. Only a
 * whole-directory snapshot catches that.
 */
function snapshotStoreDir(databasePath: string): Record<string, string> {
	const dir = dirname(databasePath);
	if (!existsSync(dir)) return {};
	const snapshot: Record<string, string> = {};
	for (const name of readdirSync(dir).sort()) {
		snapshot[name] = createHash("sha256")
			.update(readFileSync(join(dir, name)))
			.digest("hex");
	}
	return snapshot;
}

// export-html/index.ts resolves the alias-store path from the process-global getAgentDir()
// (config.ts) by default, exactly like the live runtime's context-pipeline.ts does — it is not
// derived from SessionManager's own constructor argument. The suite-wide test setup already
// redirects getAgentDir() away from the real user directory; this pins it to a chosen directory so
// a fixture written under that directory and the path the code under test computes agree.
async function withAgentDir<T>(agentDir: string, fn: () => Promise<T>): Promise<T> {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
	try {
		return await fn();
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
	}
}

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-export-html-alias-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("HTML export path-alias expansion", () => {
	it("expands aliases from a table loaded off disk and leaves the store directory byte-unchanged", async () => {
		await withAgentDir(tempDir, async () => {
			const session = SessionManager.create(tempDir, tempDir, tempDir);
			appendAliasedAssistantMessage(session, "See p/foo.ts for the details.");

			const databasePath = join(getContextStoreDir(tempDir, "index", session.getSessionId()), "runtime.sqlite");
			const store = createSqlitePathAliasStore({ databasePath });
			store.upsert({ fullPath: join(tempDir, "packages/app/src/foo.ts"), aliasId: "p/foo.ts", createdAtTurn: 1 });
			store.close();
			const before = snapshotStoreDir(databasePath);

			const outputPath = join(tempDir, "export.html");
			await exportSessionToHtml(session, undefined, { outputPath });

			const json = JSON.stringify(extractSessionData(readFileSync(outputPath, "utf-8")));
			expect(json).toContain("packages/app/src/foo.ts");
			expect(json).not.toMatch(/\bp\/foo\.ts\b/);

			// Zero-write pin: reading the table for export must not touch the store it came from, and
			// must not leave a new WAL/SHM sidecar behind either.
			expect(snapshotStoreDir(databasePath)).toEqual(before);
		});
	});

	it("degrades to raw output with exactly one stderr warning when the alias table is missing, and creates nothing", async () => {
		await withAgentDir(tempDir, async () => {
			const session = SessionManager.create(tempDir, tempDir, tempDir);
			appendAliasedAssistantMessage(session, "See p/foo.ts for the details.");
			const databasePath = join(getContextStoreDir(tempDir, "index", session.getSessionId()), "runtime.sqlite");
			expect(existsSync(databasePath)).toBe(false);

			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				const outputPath = join(tempDir, "export.html");
				await exportSessionToHtml(session, undefined, { outputPath });

				const json = JSON.stringify(extractSessionData(readFileSync(outputPath, "utf-8")));
				expect(json).toContain("p/foo.ts");

				expect(stderrSpy).toHaveBeenCalledTimes(1);
				expect(String(stderrSpy.mock.calls[0]?.[0])).toContain(session.getSessionId());
			} finally {
				stderrSpy.mockRestore();
			}

			// Zero-write pin, missing-file variant: export must never create the alias store it read from.
			expect(existsSync(databasePath)).toBe(false);
		});
	});

	it("honors a custom agentDir option instead of the process-global default", async () => {
		// A session constructed with AgentSessionConfig.agentDir set stores its alias database under
		// THAT dir, not getAgentDir()'s default (agent-session.ts:426, config.agentDir ?? getAgentDir()).
		// Simulate the divergence directly: the process-global default points at wrongAgentDir, while
		// the session's real agent dir (what SessionAnalytics.exportToHtml would pass as
		// ExportOptions.agentDir) is realAgentDir.
		const realAgentDir = mkdtempSync(join(tmpdir(), "pi-export-html-alias-real-"));
		const wrongAgentDir = mkdtempSync(join(tmpdir(), "pi-export-html-alias-wrong-"));
		try {
			await withAgentDir(wrongAgentDir, async () => {
				const session = SessionManager.create(tempDir, realAgentDir, tempDir);
				appendAliasedAssistantMessage(session, "See p/foo.ts for the details.");

				const databasePath = join(
					getContextStoreDir(realAgentDir, "index", session.getSessionId()),
					"runtime.sqlite",
				);
				const store = createSqlitePathAliasStore({ databasePath });
				store.upsert({ fullPath: join(tempDir, "packages/app/src/foo.ts"), aliasId: "p/foo.ts", createdAtTurn: 1 });
				store.close();

				// Without the option: falls back to the (wrong) global default and misses the table —
				// this is the bug REQUIRED FIX 2 addresses, reproduced here as the negative control.
				const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
				const withoutOption = join(tempDir, "export-without-option.html");
				await exportSessionToHtml(session, undefined, { outputPath: withoutOption });
				const rawJson = JSON.stringify(extractSessionData(readFileSync(withoutOption, "utf-8")));
				expect(rawJson).toContain("p/foo.ts");
				stderrSpy.mockRestore();

				// With the option: the real agent dir is honored regardless of the global default.
				const withOption = join(tempDir, "export-with-option.html");
				await exportSessionToHtml(session, undefined, { outputPath: withOption, agentDir: realAgentDir });
				const expandedJson = JSON.stringify(extractSessionData(readFileSync(withOption, "utf-8")));
				expect(expandedJson).toContain("packages/app/src/foo.ts");
				expect(expandedJson).not.toMatch(/\bp\/foo\.ts\b/);
			});
		} finally {
			rmSync(realAgentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
			rmSync(wrongAgentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});
});
