import { describe, expect, it, vi } from "vitest";
import type * as SqliteModule from "../src/core/context/sqlite-database.ts";
import type { ContextPipeline } from "../src/core/context-pipeline.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createReuseHarness } from "./fixtures/specialist-reuse-harness.ts";

const openDatabases = new Map<object, { path: string; stack: string | undefined }>();
vi.mock("../src/core/context/sqlite-database.ts", async (importOriginal) => {
	const original = await importOriginal<typeof SqliteModule>();
	return {
		...original,
		openSqliteDatabase: (options: SqliteModule.OpenSqliteDatabaseOptions) => {
			const database = original.openSqliteDatabase(options);
			openDatabases.set(database, { path: options.databasePath, stack: new Error("database opened").stack });
			return {
				exec: database.exec.bind(database),
				prepare: database.prepare.bind(database),
				get isTransaction() {
					return database.isTransaction;
				},
				[Symbol.dispose]() {
					database[Symbol.dispose]();
					openDatabases.delete(database);
				},
			};
		},
	};
});

describe("worker session storage disposal", () => {
	it("does not reopen the alias database when a late provider projection arrives after disposal", async () => {
		const context = await createReuseHarness();
		const pipeline = (context.harness.session as unknown as { _pipeline: ContextPipeline })._pipeline;
		const messages = [
			{ role: "user" as const, content: `Inspect ${context.harness.tempDir}`, timestamp: Date.now() },
		];
		pipeline.applyPathAliases(messages);
		expect(
			[...openDatabases.values()].filter((entry) => entry.path.startsWith(context.harness.tempDir)).length,
		).toBeGreaterThan(0);
		await context.harness.session.disposeAndWait();
		pipeline.applyPathAliases(messages);
		try {
			expect([...openDatabases.values()].filter((entry) => entry.path.startsWith(context.harness.tempDir))).toEqual(
				[],
			);
		} finally {
			pipeline.cleanupToolArtifactStoreOnDispose();
		}
	});
	it.each([false, true])("closes every runtime index after delegation and refusal=%s", async (refuse) => {
		const context = await createReuseHarness();
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "map lifecycle" });
		expect(first.record?.status).toBe("succeeded");
		const second = await context.harness.session.runWorkerDelegationOnce({
			instructions: "independent review",
			parallelWork: { independentOf: [first.record!.agentId!], justification: "Independent control" },
		});
		expect(second.record?.status).toBe("succeeded");
		if (refuse) {
			const delegate = context.harness.session.getToolDefinition("delegate")!;
			await delegate.execute(
				"unknown-worker",
				{ action: "start", agentId: "worker-does-not-exist", instructions: "unavailable work" },
				undefined,
				undefined,
				{
					sessionManager: {
						getSessionId: () => context.harness.sessionManager.getSessionId(),
						getLeafId: () => context.harness.sessionManager.getLeafId(),
					},
				} as unknown as ExtensionContext,
			);
		}
		await context.settleLanes();
		await context.harness.session.disposeAndWait();
		await context.harness.session.waitForForegroundIdle();
		const leaked = [...openDatabases.values()].filter((entry) => entry.path.startsWith(context.harness.tempDir));
		try {
			expect(leaked).toEqual([]);
		} finally {
			// Owned test cleanup only, after recording the invariant. Windows cannot remove an open DB.
			for (const [database, entry] of openDatabases) {
				if (!entry.path.startsWith(context.harness.tempDir)) continue;
				(database as SqliteModule.SqliteDatabase)[Symbol.dispose]();
				openDatabases.delete(database);
			}
		}
	});
});
