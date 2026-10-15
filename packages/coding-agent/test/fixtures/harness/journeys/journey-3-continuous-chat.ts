import "../builtin-install.ts";
import { expect } from "vitest";
import { CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES } from "../../../../src/core/memory/continuous-chat-index.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import {
	icmContinuousSettings,
	icmContinuousStore,
	icmReadContinuousNodes,
	icmReadContinuousRecords,
	icmWaitForChatIdle,
	utf8Text,
} from "./shared.ts";

export async function runJourney3ContinuousChatPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// ICM migration, mode switching, crash recovery, and index reconciliation (Pi-adaptative-memory):
	const mAgentDir = `${world.agentDir}-icm`;
	const mStore = icmContinuousStore(mAgentDir);
	world.setModelReasoning("worker-c", true, { xhigh: "xhigh" });

	// M1 (one-time legacy session migration + forgotten-session skip + headless legacy file skip):
	// Create two OKF sessions first: one normal session and one forgotten session.
	const mLegacyKeptManager = world.createSessionManager(mAgentDir);
	const mLegacyKept = await world.createRootSession("root", {
		agentDir: mAgentDir,
		sessionManager: mLegacyKeptManager,
		settings: { memorySystem: "okf" },
	});
	const mLegacyKeptId = mLegacyKept.session.sessionId;
	world.provider.enqueue("root", {
		name: "m-legacy-kept-reply",
		reply: { content: [{ type: "text", text: "Legacy kept reply: alpha-migration-token." }] },
	});
	world.systemOne.enterPhase("m-legacy-kept", {});
	await withDeadline(trace, "m-legacy kept turn", mLegacyKept.session.prompt("Seed kept legacy session."));
	expect(await world.disposeSessionInBody(mLegacyKept.session)).toBeUndefined();
	const mHeadlessFile = "2026-01-01T00-00-00-000Z_headless-legacy.jsonl";
	world.io.writeFileSync(
		`${mLegacyKeptManager.getSessionDir()}/${mHeadlessFile}`,
		'{"type":"custom_message","id":"headless"}\n',
	);

	const mLegacyForgotten = await world.createRootSession("root", {
		agentDir: mAgentDir,
		sessionManager: world.createSessionManager(mAgentDir),
		settings: { memorySystem: "okf" },
	});
	const mLegacyForgottenId = mLegacyForgotten.session.sessionId;
	world.provider.enqueue("root", {
		name: "m-legacy-forgotten-reply",
		reply: { content: [{ type: "text", text: "Legacy forgotten reply: secret-forgotten-token." }] },
	});
	world.systemOne.enterPhase("m-legacy-forgotten", {});
	await withDeadline(
		trace,
		"m-legacy forgotten turn",
		mLegacyForgotten.session.prompt("Seed forgotten legacy session."),
	);
	expect(await world.disposeSessionInBody(mLegacyForgotten.session)).toBeUndefined();

	// Record the forgotten session via an OKF root so forgotten-sessions.json carries its valid digest and revision.
	const mForgetMarker = await world.createRootSession("root", {
		agentDir: mAgentDir,
		sessionManager: world.createSessionManager(mAgentDir),
		settings: { memorySystem: "okf" },
	});
	const mForgetOutcome = await mForgetMarker.session.forgetHistorySession(mLegacyForgottenId);
	expect(mForgetOutcome.ok, `forgetting ${mLegacyForgottenId} succeeds: ${mForgetOutcome.message}`).toBe(true);
	expect(await world.disposeSessionInBody(mForgetMarker.session)).toBeUndefined();

	// Open ICM root while mHeadlessFile cannot be read (a persistent scripted EIO): a transient read failure is the one source
	// fault that still blocks the import. Migration blocks without writing migration.json, and provider requests fail closed.
	// (A readable headerless file is repaired from its name and imported, and malformed content is recorded as a skip.)
	const mHeadlessUnreadable = world.io.denyUntilCleared({
		name: "m-legacy-headless-read-eio",
		kind: "read",
		code: "EIO",
		matches: (operation) => operation.path.endsWith(mHeadlessFile),
	});
	const mBlocked = await world.createRootSession("root", {
		agentDir: mAgentDir,
		sessionManager: world.createSessionManager(mAgentDir),
		settings: icmContinuousSettings(),
	});
	await withDeadline(
		trace,
		"m-legacy blocked import turn",
		mBlocked.session.prompt("Attempt turn while a legacy session file has an invalid header."),
	);
	const mBlockedLast = mBlocked.session.messages.at(-1);
	expect(
		{
			migrationFileWrittenWhileBlocked: world.io.existsSync(mStore.migrationFile),
			blockedReply:
				mBlockedLast?.role === "assistant"
					? { stopReason: mBlockedLast.stopReason, error: mBlockedLast.errorMessage }
					: undefined,
		},
		"an unreadable or headerless legacy session blocks migration without writing migration.json so repair + restart retries",
	).toEqual({
		migrationFileWrittenWhileBlocked: false,
		blockedReply: {
			stopReason: "error",
			error: expect.stringContaining(
				`ICM project chat is unavailable: Legacy memory import is incomplete and will retry: ${mHeadlessFile}: the file cannot be read:`,
			),
		},
	});
	expect(await world.disposeSessionInBody(mBlocked.session)).toBeUndefined();
	expect(mHeadlessUnreadable.clear(), "the blocked import met the unreadable source").toBeGreaterThan(0);

	// Repair into a valid extended-year ISO timestamp that reaches the intentional non-loggable day skip.
	const mUnsupportedSessionId = "headless-repaired-unsupported";
	world.io.writeFileSync(
		`${mLegacyKeptManager.getSessionDir()}/${mHeadlessFile}`,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: mUnsupportedSessionId,
			timestamp: "+010000-01-01T00:00:00.000Z",
			cwd: "/harness/project",
		})}\n`,
	);

	// Open ICM root after repair: retries and imports mLegacyKept (2 messages wrapped as "note" records) and skips mLegacyForgotten ("forgotten")
	// and mUnsupportedSessionId ("unsupported session start time: +010000-01-01T00:00:00.000Z") in migration.json.
	const mRoot = await world.createRootSession("root", {
		agentDir: mAgentDir,
		sessionManager: world.createSessionManager(mAgentDir),
		settings: icmContinuousSettings(),
	});
	await icmWaitForChatIdle(world, mAgentDir, 3, (_records, nodes) =>
		nodes.some((node) => node.level === 1 && node.ordinal === 0),
	);
	const mMigrationAfterFirst = JSON.parse(utf8Text(world.io.readFileSync(mStore.migrationFile, "utf8"))) as {
		schemaVersion: number;
		state: { importedSessions: number; skipped: { sessionId: string; reason: string }[] };
	};
	const mImportedRecords = icmReadContinuousRecords(world, mStore);
	expect(
		{
			schemaVersion: mMigrationAfterFirst.schemaVersion,
			importedSessions: mMigrationAfterFirst.state.importedSessions,
			forgottenSkipped: mMigrationAfterFirst.state.skipped.some(
				(entry) => entry.sessionId === mLegacyForgottenId && entry.reason === "forgotten",
			),
			unsupportedSkipped: mMigrationAfterFirst.state.skipped.some(
				(entry) =>
					entry.sessionId === mUnsupportedSessionId &&
					entry.reason === "unsupported session start time: +010000-01-01T00:00:00.000Z",
			),
			recordTexts: mImportedRecords
				.filter((record) => record.kind === "note")
				.map((record) => `${record.kind}: ${record.text}`),
		},
		"after repairing the blocked session file, legacy import retries, writes migration.json, imports kept session as note records, and records intentional skips",
	).toEqual({
		schemaVersion: 1,
		importedSessions: 1,
		forgottenSkipped: true,
		unsupportedSkipped: true,
		recordTexts: ["note: user: Seed kept legacy session.", "note: pi: Legacy kept reply: alpha-migration-token."],
	});
	expect(
		mImportedRecords.map((record) => ({ kind: record.kind, text: record.text, sourceKey: record.sourceKey })),
		"failed activation remains attached and its persisted user prompt recovers canonically exactly once",
	).toEqual([
		{ kind: "note", text: "user: Seed kept legacy session.", sourceKey: expect.stringContaining(mLegacyKeptId) },
		{
			kind: "note",
			text: "pi: Legacy kept reply: alpha-migration-token.",
			sourceKey: expect.stringContaining(mLegacyKeptId),
		},
		{
			kind: "user",
			text: "Attempt turn while a legacy session file has an invalid header.",
			sourceKey: expect.stringMatching(new RegExp(`^${mBlocked.session.sessionId}:`)),
		},
	]);

	// M2 (mode switching ICM -> OKF -> ICM):
	// Switching to OKF releases runtime.lease.json and restores the memory tool; switching back to ICM re-acquires the lease
	// and does not re-import legacy sessions because migration.json is already present.
	const mToOkf = await mRoot.session.setMemorySystem("okf");
	expect(mToOkf.ok, mToOkf.message).toBe(true);
	expect(world.io.existsSync(mStore.leaseFile), "switching to OKF releases the continuous-chat lease").toBe(false);
	let okfToolNames: string[] = [];
	world.provider.enqueue("root", {
		name: "m-okf-turn",
		check: (request) => {
			okfToolNames = (request.context.tools ?? []).map((tool) => tool.name);
		},
		reply: { content: [{ type: "text", text: "OKF mode turn noted." }] },
	});
	world.systemOne.enterPhase("m-okf-turn", {});
	await withDeadline(trace, "m-okf turn", mRoot.session.prompt("Run one turn in OKF mode."));
	expect(
		{
			hasMemory: okfToolNames.includes("memory"),
			hasZoom: okfToolNames.includes("zoom"),
			recordCountDuringOkf: icmReadContinuousRecords(world, mStore).length,
		},
		"OKF turn exposes memory tool, hides zoom, and does not append to continuous chat",
	).toEqual({
		hasMemory: true,
		hasZoom: false,
		recordCountDuringOkf: 3,
	});

	const mBackToIcm = await mRoot.session.setMemorySystem("icm");
	expect(mBackToIcm.ok, mBackToIcm.message).toBe(true);
	expect(world.io.existsSync(mStore.leaseFile), "switching back to ICM re-acquires the lease").toBe(true);
	await icmWaitForChatIdle(world, mAgentDir, 5);
	expect(
		icmReadContinuousRecords(world, mStore).map((record) => `${record.kind}: ${record.text}`),
		"switching back to ICM replays the current session's OKF turn without re-importing settled legacy sessions",
	).toEqual([
		"note: user: Seed kept legacy session.",
		"note: pi: Legacy kept reply: alpha-migration-token.",
		"user: Attempt turn while a legacy session file has an invalid header.",
		"user: Run one turn in OKF mode.",
		"pi: OKF mode turn noted.",
	]);
	expect(await world.disposeSessionInBody(mRoot.session)).toBeUndefined();

	// M3 (crash recovery of active sessions + torn JSONL tail, torn messages.idx, and missing keys.idx reconciliation):
	// 1. Seed a session file on disk and list it in sessions.json active[] as if a previous ICM process crashed before settling.
	const mCrashManager = world.createSessionManager(mAgentDir);
	const mCrashSession = await world.createRootSession("root", {
		agentDir: mAgentDir,
		sessionManager: mCrashManager,
		settings: { memorySystem: "okf" },
	});
	const mCrashSessionId = mCrashSession.session.sessionId;
	const mCrashSessionFile = mCrashManager.getSessionFile();
	if (mCrashSessionFile === undefined) throw new Error("mCrashSession has no session file");
	world.provider.enqueue("root", {
		name: "m-crash-session-reply",
		reply: { content: [{ type: "text", text: "Recovered crash session reply." }] },
	});
	world.systemOne.enterPhase("m-crash-seed", {});
	await withDeadline(trace, "m-crash seed turn", mCrashSession.session.prompt("Crash session user message."));
	expect(await world.disposeSessionInBody(mCrashSession.session)).toBeUndefined();

	world.io.writeFileSync(
		mStore.sessionsFile,
		`${JSON.stringify({
			schemaVersion: 1,
			active: [{ sessionId: mCrashSessionId, sessionFile: mCrashSessionFile }],
			settled: [mLegacyKeptId, mLegacyForgottenId, mRoot.session.sessionId],
		})}\n`,
	);
	// 2. Append a torn JSONL tail line without a trailing newline, append 7 torn bytes to messages.idx, and remove keys.idx.
	const mMainFiles = world.io.readdirSync(mStore.mainDir);
	const mDayJsonl = mMainFiles.find((name): name is string => typeof name === "string" && name.endsWith(".jsonl"))!;
	const mDayJsonlPath = `${mStore.mainDir}/${mDayJsonl}`;
	const mCleanJsonl = utf8Text(world.io.readFileSync(mDayJsonlPath, "utf8"));
	world.io.writeFileSync(mDayJsonlPath, `${mCleanJsonl}{"id":99,"kind":"pi","text":"torn`);
	const mRawCleanIdx = world.io.readFileSync(mStore.messagesIdx);
	const mCleanIdx = typeof mRawCleanIdx === "string" ? Buffer.from(mRawCleanIdx) : mRawCleanIdx;
	world.io.writeFileSync(mStore.messagesIdx, Buffer.concat([mCleanIdx, Buffer.alloc(7, 0xff)]));
	world.io.rmSync(mStore.keysIdx, { force: true });

	const mRecovered = await world.createRootSession("root", {
		agentDir: mAgentDir,
		sessionManager: world.createSessionManager(mAgentDir),
		settings: icmContinuousSettings(),
	});
	await icmWaitForChatIdle(world, mAgentDir, 7, (_records, nodes) =>
		nodes.some((node) => node.level === 2 && node.ordinal === 0),
	);
	const mRecoveredRecords = icmReadContinuousRecords(world, mStore);
	expect(
		{
			recordTexts: mRecoveredRecords.map((record) => `${record.kind}: ${record.text}`),
			idxRebuiltBytes: Buffer.byteLength(world.io.readFileSync(mStore.messagesIdx)),
			keysIdxExists: world.io.existsSync(mStore.keysIdx),
			node0Plus4Children: icmReadContinuousNodes(world, mStore).find(
				(node) => node.level === 2 && node.ordinal === 0,
			)?.children,
		},
		"startup truncates the torn JSONL tail and torn messages.idx bytes, rebuilds keys.idx, and recovers the active session",
	).toEqual({
		recordTexts: [
			"note: user: Seed kept legacy session.",
			"note: pi: Legacy kept reply: alpha-migration-token.",
			"user: Attempt turn while a legacy session file has an invalid header.",
			"user: Run one turn in OKF mode.",
			"pi: OKF mode turn noted.",
			"user: Crash session user message.",
			"pi: Recovered crash session reply.",
		],
		idxRebuiltBytes: 7 * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES,
		keysIdxExists: true,
		node0Plus4Children: [
			{ level: 1, ordinal: 0 },
			{ level: 1, ordinal: 1 },
		],
	});
	expect(await world.disposeSessionInBody(mRecovered.session)).toBeUndefined();
	trace.mark("root", "icm.migration-and-recovery");
}
