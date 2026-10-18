import "../builtin-install.ts";
import { expect } from "vitest";
import { decisionLedgerFile } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import type { ExtensionFactory } from "../../../../src/core/extensions/types.ts";
import { DecisionLedgerStore } from "../../../../src/core/operator-projection/decision-ledger-store.ts";
import { ownTurnInputRecordPath, QUEUED_INPUT_CUSTOM_TYPE } from "../../../../src/core/queued-input-record.ts";
import {
	OPTIONAL_TOOL_INTENT_CUSTOM_TYPE,
	readOptionalToolIntent,
} from "../../../../src/core/tool-applicability-gate.ts";
import { verifyModeWitnesses } from "../mode-witnesses.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import {
	DISCARD_SCAN_BOUNDS_EXPECTED,
	type HarnessWorld,
	holdAssistantMessageEnd,
	holdCompactionSummary,
	RPC_CLOSING_WARNING,
	RPC_INPUT_END_HELD_EXPECTED,
	RPC_LATE_WARNING,
	RPC_OUTPUT_OWNER_EXPECTED,
	runCompactionBehindHeldRun,
	runCompactionCloseAppendRefused,
	runDiscardScanBounds,
	runDiscardThroughRuntime,
	runRpcHost,
	runSdkConstructionFailure,
	runSignalShutdown,
	SDK_CONSTRUCTION_FAILURE_EXPECTED,
	SIGNAL_CLOSING_WARNING,
	SIGNAL_RESUME_COMMAND,
	withDeadline,
} from "../session-fixture.ts";
import { crashCutChecks, expectOwnerWords, LIMITS_PATH } from "./shared.ts";

export async function runJourney1HostShutdownPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// SQLite busy through the real decision ledger store: while its schema exec answers SQLITE_BUSY, every construction throws
	// node:sqlite's own busy error and disposes the connection it opened, so no attempt leaves a handle. Once the database is free
	// again, a normal construction works and closes. Synchronous from denial to clear, so no other owner's exec can meet it.
	const busyLedgerPath = decisionLedgerFile(`${world.agentDir}-busy-ledger`);
	const busyHandles = world.guard.openSqliteHandles();
	const busy = world.guard.denySqliteUntilCleared({
		name: "r48-ledger-busy",
		operation: "exec",
		sql: "CREATE TABLE IF NOT EXISTS ledger_meta",
		result: "busy",
	});
	const busyAttempts = [0, 1].map(() => {
		try {
			new DecisionLedgerStore({ databasePath: busyLedgerPath });
			return undefined;
		} catch (error) {
			return error;
		}
	});
	expect(busyAttempts, "each construction against the busy database throws node:sqlite's busy error").toEqual([
		expect.objectContaining({ message: "database is locked", code: "ERR_SQLITE_ERROR", errcode: 5 }),
		expect.objectContaining({ message: "database is locked", code: "ERR_SQLITE_ERROR", errcode: 5 }),
	]);
	expect(busy.clear(), "the busy database refused both schema execs").toBe(2);
	expect(world.guard.openSqliteHandles(), "no busy construction leaves a handle").toEqual(busyHandles);
	world.faultMatrix.witness("R48", { control: false });
	new DecisionLedgerStore({ databasePath: busyLedgerPath }).close();
	expect(world.guard.openSqliteHandles(), "the construction after the busy window closes its handle").toEqual(
		busyHandles,
	);
	world.faultMatrix.witness("R48", { control: true });
	// Quit mid-run: the owner is disposed while its scripted reply is still streaming, with no abort first. The disposal aborts the run
	// and waits for it to end, so the partial assistant message is kept in the session file with its stop reason. The idle-quit control
	// disposes after its turn completed: its complete message is kept and no partial one is.
	const qmAssistants = (file: string) =>
		(world.io.peekFile(file) ?? "")
			.split("\n")
			.filter((line) => line.length > 0)
			.map(
				(line) =>
					JSON.parse(line) as {
						type?: string;
						message?: { role?: string; stopReason?: string; content?: { type?: string; text?: string }[] };
					},
			)
			.filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
			.map((entry) => ({
				stopReason: entry.message?.stopReason,
				text: (entry.message?.content ?? [])
					.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
					.join(""),
			}));
	const qmMark = world.warnings.length;
	const qmHold = createBarrier();
	const qmStreaming = createBarrier();
	const qmCreated = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: "okf", autoLearn: { enabled: false } },
	});
	const qmSession = qmCreated.session;
	const qmFile = qmCreated.sessionManager.getSessionFile();
	if (qmFile === undefined) throw new Error("the quit witness owner has no file");
	world.provider.enqueue("root", {
		name: "quit-mid-run",
		frames: [
			{ partialContent: [{ type: "text", text: "" }], event: { type: "text_start", contentIndex: 0 } },
			{
				partialContent: [{ type: "text", text: "The partial reply" }],
				event: { type: "text_delta", contentIndex: 0, delta: "The partial reply" },
			},
			{
				partialContent: [{ type: "text", text: "The partial reply" }],
				event: { type: "text_end", contentIndex: 0, content: "The partial reply" },
				gate: qmHold.promise,
			},
		],
		reply: { content: [{ type: "text", text: "The partial reply and its end" }] },
	});
	const qmUnsubscribe = qmSession.subscribe((event) => {
		if (event.type === "message_update" && JSON.stringify(event).includes("The partial reply")) qmStreaming.release();
	});
	const qmPrompt = qmSession.prompt("Start a reply and quit while it streams.").catch((error: unknown) => error);
	await withDeadline(trace, "quit: the partial reply streams", qmStreaming.promise);
	qmUnsubscribe();
	await withDeadline(trace, "quit: the owner disposes while the reply streams", qmSession.disposeAndWait(), 60_000);
	await qmPrompt;
	expect(
		qmAssistants(qmFile),
		"the quit keeps the partial reply in the session file with its stop reason, and no complete reply",
	).toEqual([{ stopReason: "aborted", text: "The partial reply" }]);

	const qmIdleCreated = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: "okf", autoLearn: { enabled: false } },
	});
	const qmIdleFile = qmIdleCreated.sessionManager.getSessionFile();
	if (qmIdleFile === undefined) throw new Error("the idle-quit control owner has no file");
	world.provider.enqueue("root", {
		name: "quit-idle-control",
		reply: { content: [{ type: "text", text: "Noted." }] },
	});
	await withDeadline(
		trace,
		"idle quit: the control turn completes",
		qmIdleCreated.session.prompt("Say hello before quitting."),
	);
	expect(
		await world.disposeSessionInBody(qmIdleCreated.session),
		"the idle-quit control owner disposes cleanly",
	).toBeUndefined();
	expect(qmAssistants(qmIdleFile), "the idle quit keeps its complete reply and no partial one").toEqual([
		{ stopReason: "stop", text: "Noted." },
	]);
	expect(
		world.warnings.slice(qmMark).filter((message) => message.includes("did not settle")),
		"the mid-run quit whose abort settles inside the bound discloses no unsettled run",
	).toEqual([]);
	trace.mark("root", "quit.mid-run");
	// Quit while the provider's producer ignores the session's abort (it stays held at its gate): the transport ends the stream
	// on the abort anyway, so the run settles inside the bound and the owner's bounded wait does NOT expire. The only closing
	// disclosure is the verification notice of the run's last event; no round starts after the quit. The gate opens in the
	// finally, so the held producer never blocks the disposal that is being witnessed. (The timeout disclosure needs a run held
	// by something the abort cannot reach, which this fixture cannot script: it stays implemented-only.)
	const tmReached = createBarrier();
	const tmHold = createBarrier();
	const tmCreated = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: "okf" },
	});
	const tmSession = tmCreated.session;
	const tmFile = tmCreated.sessionManager.getSessionFile();
	if (tmFile === undefined) throw new Error("the settle-bound witness owner has no file");
	world.provider.enqueue("root", {
		name: "quit-run-ignores-abort",
		check: () => tmReached.release(),
		gate: tmHold.promise,
		ignoresAbort: true,
		reply: { content: [{ type: "text", text: "The late reply" }] },
	});
	const tmPrompt = tmSession.prompt("Start a reply that outlives quit.").catch((error: unknown) => error);
	await withDeadline(trace, "quit settle bound: the request reaches its held gate", tmReached.promise);
	const tmMark = world.warnings.length;
	const tmRequests = world.provider.requests.length;
	const tmSystemOneRequests = world.systemOne.decoded.length;
	let tmOutcome: unknown = "unsettled";
	try {
		await withDeadline(
			trace,
			"quit settle bound: the owner disposes while its run is held",
			tmSession.disposeAndWait(),
			60_000,
		);
		// The quit cancels the submission itself: no paid System One work starts for a session that is closing, and the only
		// disclosures are the closing notices (never an unsettled run: the transport ends the stream on the abort).
		expect(world.systemOne.decoded.length, "no System One request starts after the owner quit").toBe(
			tmSystemOneRequests,
		);
		expect(
			world.warnings
				.slice(tmMark)
				.filter(
					(message) =>
						message !==
						"System One verification was not run because the session was closing; no judgment was recorded.",
				),
			"the run settles inside the bound: no disclosure other than the closing verification notice",
		).toEqual([]);
		expect(
			qmAssistants(tmFile),
			"the held producer completed no reply: the quit ended the run and only its aborted, empty message was persisted",
		).toEqual([{ stopReason: "aborted", text: "" }]);
	} finally {
		tmHold.release();
		tmOutcome = await withDeadline(
			trace,
			"quit settle bound: the held run ends once its gate opens",
			tmPrompt,
			60_000,
		);
	}
	expect(tmOutcome, "the held run ends without an error once its gate opens").toBeUndefined();
	expect(world.provider.requests.length, "no provider round starts after the owner is disposed").toBe(tmRequests);
	trace.mark("root", "quit.abort-ignoring-producer");
	// Compaction across the quit: the owner is disposed while an extension's `session_before_compact` handler still holds the summary it
	// returns. Production refuses that late result at its one commit point (`applyResult`): the held compaction is rejected with its
	// cancellation and no compaction entry is written after the quit. The live control releases the handler before the quit, and the
	// same summary commits. Compaction needs history, so each owner first completes one plain turn.
	const cpCompactions = (file: string) =>
		(world.io.peekFile(file) ?? "")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { type?: string; summary?: string })
			.filter((entry) => entry.type === "compaction")
			.map((entry) => entry.summary);
	// The compaction's durable lifecycle: a start written before its summary is requested, and one terminal end. Byte snapshots of the
	// whole session file show that nothing is appended after the quit's own disposal.
	const cpEntries = (file: string) =>
		(world.io.peekFile(file) ?? "")
			.split("\n")
			.filter((line) => line.length > 0)
			.map(
				(line) =>
					JSON.parse(line) as {
						id?: string;
						type?: string;
						compactionId?: string;
						outcome?: string;
						compactionEntryId?: string;
					},
			);
	const cpLifecycle = (file: string) =>
		cpEntries(file)
			.filter((entry) => entry.type === "compaction_start" || entry.type === "compaction_end")
			.map((entry) => ({
				type: entry.type,
				compactionId: entry.compactionId,
				outcome: entry.outcome,
				compactionEntryId: entry.compactionEntryId,
			}));
	const cpHold = createBarrier();
	const cpReached = createBarrier();
	const cpHeld = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: "okf" },
		extensionFactories: [holdCompactionSummary(cpHold, cpReached)],
	});
	const cpHeldSession = cpHeld.session;
	await cpHeldSession.bindExtensions({ uiContext: world.humanInput.ui });
	const cpHeldFile = cpHeld.sessionManager.getSessionFile();
	if (cpHeldFile === undefined) throw new Error("the held compaction owner has no file");
	world.provider.enqueue("root", {
		name: "compaction-held-seed",
		reply: { content: [{ type: "text", text: "Seeded before the held compaction." }] },
	});
	await withDeadline(
		trace,
		"held compaction: the seed turn completes",
		cpHeldSession.prompt("Seed the held compaction."),
	);
	const cpHeldCompaction = cpHeldSession.compact("Compact the seeded history.").catch((error: unknown) => error);
	await withDeadline(trace, "held compaction: the extension holds the summary", cpReached.promise);
	const cpHeldRequests = world.provider.requests.length;
	const cpHeldMark = world.warnings.length;
	let cpHeldOutcome: unknown = "unsettled";
	let cpHeldAtDispose = "";
	try {
		await withDeadline(
			trace,
			"held compaction: the owner disposes while the summary is held",
			cpHeldSession.disposeAndWait(),
			60_000,
		);
		cpHeldAtDispose = world.io.peekFile(cpHeldFile) ?? "";
		const [cpHeldStart] = cpLifecycle(cpHeldFile);
		expect(
			cpLifecycle(cpHeldFile),
			"the quit settles the held compaction once, as cancelled, before the session reports closed",
		).toEqual([
			{
				type: "compaction_start",
				compactionId: cpHeldStart?.compactionId,
				outcome: undefined,
				compactionEntryId: undefined,
			},
			{
				type: "compaction_end",
				compactionId: cpHeldStart?.compactionId,
				outcome: "cancelled",
				compactionEntryId: undefined,
			},
		]);
		expect(cpCompactions(cpHeldFile), "the quit writes no compaction entry while the summary is held").toEqual([]);
		expect(
			world.warnings.slice(cpHeldMark),
			"the quit waits its bound for the held compaction and discloses it as unsettled",
		).toEqual(["A compaction did not settle within 5s of quit; its result is discarded."]);
	} finally {
		cpHold.release();
		cpHeldOutcome = await withDeadline(trace, "held compaction: the summary resumes", cpHeldCompaction, 60_000);
	}
	expect(cpHeldOutcome, "the resumed summary ends in a cancellation, not a commit").toBeInstanceOf(Error);
	trace.claimRejection(cpHeldOutcome, "Compaction cancelled");
	expect(
		world.io.peekFile(cpHeldFile) ?? "",
		"the resumed summary appends no byte after the quit: no duplicate terminal, no late write",
	).toBe(cpHeldAtDispose);
	expect(cpCompactions(cpHeldFile), "the resumed summary writes no compaction entry after the quit").toEqual([]);
	expect(world.provider.requests.length, "the held compaction makes no provider request").toBe(cpHeldRequests);
	trace.mark("root", "compaction.held-quit");
	const cpRefused = await runCompactionCloseAppendRefused(world);
	expect(cpRefused).toMatchObject({
		quitWarnings: [
			`Closing the running compaction failed at quit: Scripted IO fault compaction-end-refused: append '${cpRefused.file}'`,
			"A compaction did not settle within 5s of quit; its result is discarded.",
		],
		lifecycleAtQuit: [{ type: "compaction_start" }],
		fileUnchanged: true,
		warningsUnchanged: true,
		requestsUnchanged: true,
	});
	trace.claimRejection(cpRefused.outcome, "Compaction cancelled");
	world.faultMatrix.witness("R11", { control: false });

	const cpLiveHold = createBarrier();
	const cpLiveReached = createBarrier();
	const cpLive = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: "okf" },
		extensionFactories: [holdCompactionSummary(cpLiveHold, cpLiveReached)],
	});
	const cpLiveSession = cpLive.session;
	await cpLiveSession.bindExtensions({ uiContext: world.humanInput.ui });
	const cpLiveFile = cpLive.sessionManager.getSessionFile();
	if (cpLiveFile === undefined) throw new Error("the live compaction control owner has no file");
	world.provider.enqueue("root", {
		name: "compaction-live-seed",
		reply: { content: [{ type: "text", text: "Seeded before the live compaction." }] },
	});
	await withDeadline(
		trace,
		"live compaction: the seed turn completes",
		cpLiveSession.prompt("Seed the live compaction."),
	);
	const cpLiveCompaction = cpLiveSession.compact("Compact the seeded history.");
	await withDeadline(trace, "live compaction: the extension holds the summary", cpLiveReached.promise);
	cpLiveHold.release();
	const cpLiveResult = await withDeadline(trace, "live compaction: the summary commits", cpLiveCompaction);
	expect(cpLiveResult.summary, "the live compaction returns the handler's summary").toBe("The held summary.");
	expect(
		await world.disposeSessionInBody(cpLiveSession),
		"the live compaction owner disposes cleanly",
	).toBeUndefined();
	const cpLiveSummaries = cpCompactions(cpLiveFile);
	const cpLiveCommitted = cpEntries(cpLiveFile).find((entry) => entry.type === "compaction");
	const [cpLiveStart] = cpLifecycle(cpLiveFile);
	expect(
		cpLifecycle(cpLiveFile),
		"the live compaction opens one lifecycle and settles it once as a success, with no cancelled end",
	).toEqual([
		{
			type: "compaction_start",
			compactionId: cpLiveStart?.compactionId,
			outcome: undefined,
			compactionEntryId: undefined,
		},
		{
			type: "compaction_end",
			compactionId: cpLiveStart?.compactionId,
			outcome: "success",
			compactionEntryId: cpLiveCommitted?.id,
		},
	]);
	expect(cpLiveSummaries, "the live quit keeps exactly one committed compaction entry").toHaveLength(1);
	expect(cpLiveSummaries[0], "the committed entry carries the handler's summary").toContain("The held summary.");
	world.faultMatrix.witness("R11", { control: true });
	trace.mark("root", "compaction.live-control");

	// Quit while an extension holds the run at the assistant's message end, past the quit's bounded settle: the owner discloses the
	// unsettled run, the held handler resumes into the closed owner, and the reply is never written. The live control releases the
	// handler before the quit: the reply is kept and no run is disclosed as unsettled.
	const meHold = createBarrier();
	const meReached = createBarrier();
	const meHeld = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: "okf" },
		extensionFactories: [holdAssistantMessageEnd(meHold, meReached)],
	});
	const meHeldSession = meHeld.session;
	await meHeldSession.bindExtensions({ uiContext: world.humanInput.ui });
	const meHeldFile = meHeld.sessionManager.getSessionFile();
	if (meHeldFile === undefined) throw new Error("the held message owner has no file");
	world.provider.enqueue("root", {
		name: "message-end-held",
		reply: { content: [{ type: "text", text: "The late reply" }] },
	});
	const mePrompt = meHeldSession
		.prompt("Start a reply that its extension holds at message end.")
		.catch((error: unknown) => error);
	await withDeadline(trace, "message end: the extension holds the reply", meReached.promise);
	const meMark = world.warnings.length;
	const meRequests = world.provider.requests.length;
	let meSnapshot: string | undefined;
	let meOutcome: unknown = "unsettled";
	try {
		await withDeadline(
			trace,
			"message end: the owner disposes while the reply is held",
			meHeldSession.disposeAndWait(),
			60_000,
		);
		meSnapshot = world.io.peekFile(meHeldFile);
		// The closing verification notice belongs to the session's System One work, not to this run: it is asserted by the quit
		// witness above, so it is excluded here and the run's own disclosure is required exactly once.
		expect(
			world.warnings
				.slice(meMark)
				.filter(
					(message) =>
						message !==
						"System One verification was not run because the session was closing; no judgment was recorded.",
				),
			"the quit discloses exactly the unsettled run, once",
		).toEqual(["A run did not settle within 5s of quit; its final message may not have been persisted."]);
		expect(qmAssistants(meHeldFile), "the held reply is not persisted while the quit waits").toEqual([]);
	} finally {
		meHold.release();
		meOutcome = await withDeadline(
			trace,
			"message end: the held run ends once its handler resumes",
			mePrompt,
			60_000,
		);
	}
	expect(meOutcome, "the held run ends without an error once its handler resumes").toBeUndefined();
	expect(world.io.peekFile(meHeldFile), "the resumed handler writes nothing to the session file").toBe(meSnapshot);
	expect(qmAssistants(meHeldFile), "the held reply is never persisted").toEqual([]);
	expect(world.provider.requests.length, "no provider round starts after the owner is disposed").toBe(meRequests);
	trace.mark("root", "message-end.held-quit");

	const meLiveHold = createBarrier();
	const meLiveReached = createBarrier();
	const meLive = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: "okf" },
		extensionFactories: [holdAssistantMessageEnd(meLiveHold, meLiveReached)],
	});
	const meLiveSession = meLive.session;
	await meLiveSession.bindExtensions({ uiContext: world.humanInput.ui });
	const meLiveFile = meLive.sessionManager.getSessionFile();
	if (meLiveFile === undefined) throw new Error("the live message control owner has no file");
	world.provider.enqueue("root", {
		name: "message-end-live-control",
		reply: { content: [{ type: "text", text: "The late reply" }] },
	});
	const meLivePrompt = meLiveSession.prompt("Start a reply that its extension releases before quit.");
	await withDeadline(trace, "live message end: the extension holds the reply", meLiveReached.promise);
	meLiveHold.release();
	await withDeadline(trace, "live message end: the reply completes before the quit", meLivePrompt);
	const meLiveMark = world.warnings.length;
	expect(
		await world.disposeSessionInBody(meLiveSession),
		"the live message control owner disposes cleanly",
	).toBeUndefined();
	expect(
		world.warnings.slice(meLiveMark).filter((message) => message.includes("did not settle")),
		"the released reply's quit discloses no unsettled run",
	).toEqual([]);
	expect(qmAssistants(meLiveFile), "the released reply is kept with its stop reason").toEqual([
		{ stopReason: "stop", text: "The late reply" },
	]);
	trace.mark("root", "message-end.live-control");
	// Compaction behind a held run: the compaction waits for the run to go idle, so it never starts its durable lifecycle. The quit
	// discloses the held run and the held compaction, the release rejects the compaction into the closed owner, and the file keeps the
	// bytes the quit left. The normal-order control commits once: one start, one success, no cancelled end.
	const pre = await runCompactionBehindHeldRun(world);
	expect(pre.inFlightAtStart, "the compaction is in flight, waiting for the held run, when the quit starts").toBe(
		true,
	);
	expect(pre.quitWarnings, "the quit discloses the held run, then the held compaction, once each").toEqual([
		"A run did not settle within 5s of quit; its final message may not have been persisted.",
		"A compaction did not settle within 5s of quit; its result is discarded.",
	]);
	expect(pre.heldOutcome, "the released compaction ends cancelled, not committed").toBeInstanceOf(Error);
	trace.claimRejection(pre.heldOutcome, "Compaction cancelled");
	expect(pre.heldRunOutcome, "the held run ends without an error once released").toBeUndefined();
	expect(pre.warningsAfterRelease, "the release discloses nothing further").toEqual(pre.quitWarnings);
	expect(pre.fileAfterRelease, "the release appends no byte after the quit").toBe(pre.fileAtQuit);
	expect(pre.lifecycleAfterRelease, "no compaction lifecycle opens behind a closed session").toEqual([]);
	expect(pre.requestsAfterRelease, "no provider request starts after the quit").toBe(pre.requestsAtQuit);
	expect(pre.control.disposal, "the normal-order control disposes cleanly").toBeUndefined();
	expect(pre.control.summary, "the control commits the handler's summary").toBe("The held summary.");
	expect(pre.control.lifecycle, "the control settles one lifecycle once, as a success").toEqual([
		{ type: "compaction_start", outcome: undefined },
		{ type: "compaction_end", outcome: "success" },
	]);
	expect(pre.control.compactionEntries, "the control keeps exactly one committed compaction entry").toBe(1);
	expect(pre.control.quitWarnings, "the control's quit discloses nothing").toEqual([]);
	trace.mark("root", "compaction.pre-start-behind-held-run");
	// Shutdown cleanup (SIGTERM/SIGHUP and quit): every cleanup step runs once, in its path's order, and a failing step never skips a
	// later one. The signal path runs dispose, drain, stop; the quit path runs drain, stop, dispose. Closing warnings stay held until
	// stop() releases them. Every failure is reported on stderr with each cause and the exit status is 1; the resume line is written on
	// the quit path only, after every step succeeded, and a clean shutdown exits 0.
	const signalClean = await runSignalShutdown({ fromSignal: true, resumeCommand: SIGNAL_RESUME_COMMAND });
	expect(signalClean.log, "a signal shutdown disposes, drains the input, then stops the terminal once").toEqual([
		"dispose",
		"drain",
		"stop",
	]);
	expect(signalClean.writesBeforeStop, "the held closing warning reaches no sink before stop()").toBe(0);
	expect(signalClean.warnings, "stop() releases the held warning exactly once").toEqual([SIGNAL_CLOSING_WARNING]);
	expect(signalClean.exits, "a clean signal shutdown exits 0").toEqual([0]);
	expect(signalClean.stderr, "a clean signal shutdown writes no failure line").toEqual([]);
	expect(signalClean.stdout, "the signal path writes no resume line").toEqual([]);
	const quitClean = await runSignalShutdown({ fromSignal: false, resumeCommand: SIGNAL_RESUME_COMMAND });
	expect(quitClean.log, "a quit drains, stops the terminal, then disposes, each once").toEqual([
		"drain",
		"stop",
		"dispose",
	]);
	expect(quitClean.writesBeforeStop, "the quit path stops the terminal before any warning is written").toBe(0);
	expect(quitClean.warnings, "the quit path's warning reaches the terminal once").toEqual([SIGNAL_CLOSING_WARNING]);
	expect(quitClean.exits, "a clean quit exits 0").toEqual([0]);
	expect(quitClean.stderr, "a clean quit writes no failure line").toEqual([]);
	expect(quitClean.stdout.join(""), "the quit path prints the resume line").toContain("To resume this session:");
	expect(quitClean.stdout.join(""), "the quit path prints the resume command").toContain(SIGNAL_RESUME_COMMAND);
	world.faultMatrix.witness("R42", { control: true });
	const signalAllFail = await runSignalShutdown({
		fromSignal: true,
		dispose: async () => {
			throw new Error("dispose failed");
		},
		drainInput: async () => {
			throw new Error("drain failed");
		},
		stop: () => {
			throw new Error("stop failed");
		},
	});
	expect(signalAllFail.log, "every signal step is attempted once, in order, after an earlier step fails").toEqual([
		"dispose",
		"drain",
		"stop",
	]);
	expect(signalAllFail.warnings, "the held warning is released before the failing stop").toEqual([
		SIGNAL_CLOSING_WARNING,
	]);
	expect(signalAllFail.stderr, "the signal path reports all three causes on stderr once").toEqual([
		"Shutdown failed: dispose failed (dispose failed; drain failed; stop failed)\n",
	]);
	expect(signalAllFail.exits, "a failing signal shutdown exits 1").toEqual([1]);
	expect(signalAllFail.stdout, "a failing signal shutdown writes no resume line").toEqual([]);
	const signalDisposeFailure = await runSignalShutdown({
		fromSignal: true,
		dispose: async () => {
			throw new AggregateError([new Error("cleanup a"), "cleanup b"], "dispose failed");
		},
	});
	expect(signalDisposeFailure.log, "a failing dispose still drains and stops the terminal").toEqual([
		"dispose",
		"drain",
		"stop",
	]);
	expect(signalDisposeFailure.writesBeforeStop, "the failing dispose's warning is still held until stop()").toBe(0);
	expect(signalDisposeFailure.warnings, "the failing dispose's closing warning is released, not lost").toEqual([
		SIGNAL_CLOSING_WARNING,
	]);
	expect(signalDisposeFailure.stderr, "the failing dispose reports every cause on stderr once").toEqual([
		"Shutdown failed: dispose failed (cleanup a; cleanup b)\n",
	]);
	expect(signalDisposeFailure.exits, "a failing dispose exits 1").toEqual([1]);
	// A disposal that fails with an aggregate AND another cleanup step failing: the report expands the nested aggregate too, so
	// none of the inner causes is lost behind the outer message.
	const signalNestedFailure = await runSignalShutdown({
		fromSignal: true,
		dispose: async () => {
			throw new AggregateError([new Error("cleanup a"), "cleanup b"], "dispose failed");
		},
		drainInput: async () => {
			throw new Error("drain failed");
		},
	});
	expect(signalNestedFailure.log, "a failing nested disposal and a failing drain still stop the terminal").toEqual([
		"dispose",
		"drain",
		"stop",
	]);
	expect(signalNestedFailure.stderr, "the report lists the nested disposal causes and the drain failure").toEqual([
		"Shutdown failed: dispose failed (dispose failed (cleanup a; cleanup b); drain failed)\n",
	]);
	expect(signalNestedFailure.exits, "a nested failure exits 1").toEqual([1]);
	expect(signalNestedFailure.stdout, "a nested failure writes no resume line").toEqual([]);
	const signalDrainFailure = await runSignalShutdown({
		fromSignal: true,
		drainInput: async () => {
			throw new Error("drain\u001b[2J broke");
		},
	});
	expect(signalDrainFailure.log, "a failing drain still stops the terminal").toEqual(["dispose", "drain", "stop"]);
	expect(signalDrainFailure.warnings, "a failing drain still releases the held warning").toEqual([
		SIGNAL_CLOSING_WARNING,
	]);
	expect(signalDrainFailure.stderr, "control characters in the failure cause are escaped, not written raw").toEqual([
		"Shutdown failed: drain\\x1b[2J broke\n",
	]);
	expect(signalDrainFailure.exits, "a failing drain exits 1").toEqual([1]);
	const quitDrainFailure = await runSignalShutdown({
		fromSignal: false,
		resumeCommand: SIGNAL_RESUME_COMMAND,
		drainInput: async () => {
			throw new Error("drain failed");
		},
	});
	expect(quitDrainFailure.log, "a failing quit drain still stops the terminal and disposes the runtime").toEqual([
		"drain",
		"stop",
		"dispose",
	]);
	expect(quitDrainFailure.warnings, "the quit path delivers its warning despite the failed drain").toEqual([
		SIGNAL_CLOSING_WARNING,
	]);
	expect(quitDrainFailure.stderr, "the quit path reports the drain failure on stderr").toEqual([
		"Shutdown failed: drain failed\n",
	]);
	expect(quitDrainFailure.exits, "a failing quit exits 1").toEqual([1]);
	expect(quitDrainFailure.stdout, "a failing quit writes no resume line").toEqual([]);
	const quitAllFail = await runSignalShutdown({
		fromSignal: false,
		resumeCommand: SIGNAL_RESUME_COMMAND,
		dispose: async () => {
			throw new Error("dispose failed");
		},
		drainInput: async () => {
			throw new Error("drain failed");
		},
		stop: () => {
			throw new Error("stop failed");
		},
	});
	expect(quitAllFail.log, "every quit step is attempted once, in order, after an earlier step fails").toEqual([
		"drain",
		"stop",
		"dispose",
	]);
	expect(quitAllFail.stderr, "the quit path reports all three causes on stderr once").toEqual([
		"Shutdown failed: drain failed (drain failed; stop failed; dispose failed)\n",
	]);
	expect(quitAllFail.exits, "a failing quit with three causes exits 1").toEqual([1]);
	expect(quitAllFail.stdout, "a failing quit with three causes writes no resume line").toEqual([]);
	world.faultMatrix.witness("R42", { control: false });
	trace.mark("root", "signal.shutdown");
	await verifyModeWitnesses(world);
	await verifyRuntimeUpdateStopHoldsQueuedInput(world);
	// Owner input queued behind a run that the quit ends. The input is admitted to the agent's queue behind the held reply; the quit ends
	// the run and no provider round starts for the input, so the closing session holds it complete with the held-queue warning. The live
	// control lets the same queued input run as the turn after its reply completes, with no held warning.
	const QUEUED_QUIT_WORDS = "Owner input queued behind the quit.";
	const qhHold = createBarrier();
	const qhReached = createBarrier();
	const qhCreated = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: "okf" },
	});
	const qhSession = qhCreated.session;
	const qhFile = qhCreated.sessionManager.getSessionFile();
	if (qhFile === undefined) throw new Error("the queued quit owner has no file");
	world.provider.enqueue("root", {
		name: "queued-quit-run",
		check: () => qhReached.release(),
		gate: qhHold.promise,
		reply: { content: [{ type: "text", text: "The held reply" }] },
	});
	const qhPrompt = qhSession
		.prompt("Start a reply that the owner queues input behind before the quit.")
		.catch((error: unknown) => error);
	await withDeadline(trace, "queued quit: the run reaches its held gate", qhReached.promise);
	if (world.systemOne.enabled) {
		world.systemOne.enterPhase("queued-quit-intake", {
			capabilities_authorized: { kind: "noul", probability: 0.02 },
			changes_model_pools: { kind: "noul", probability: 0.02 },
			local_commits_only: { kind: "noul", probability: 0.02 },
			lifts_delivery_block: { kind: "noul", probability: 0.02 },
			full_handoff: { kind: "noul", probability: 0.02 },
			optional_tool_0: { kind: "choice", choice: "request", confidence: 0.97 },
		});
	}
	await withDeadline(
		trace,
		"queued quit: the owner input is admitted behind the run",
		qhSession.followUp(QUEUED_QUIT_WORDS),
	);
	const qhMark = world.warnings.length;
	const qhRequests = world.provider.requests.length;
	await withDeadline(
		trace,
		"queued quit: the owner disposes while the run and its queued input are pending",
		qhSession.disposeAndWait(),
		60_000,
	);
	expect(
		world.warnings.slice(qhMark).filter((message) => message.includes("was not delivered")),
		"the quit holds the queued owner input complete, once, with its text",
	).toEqual([
		"A queued message was not delivered because the session closed before it could be delivered. It is kept in full in the pending queue: Owner input queued behind the quit.",
	]);
	expect(world.provider.requests.length, "the closing session starts no provider round for the held input").toBe(
		qhRequests,
	);
	expect(qmAssistants(qhFile), "the held run is kept as aborted with no reply").toEqual([
		{ stopReason: "aborted", text: "" },
	]);
	const qhOutcome = await withDeadline(trace, "queued quit: the held run ends", qhPrompt, 60_000);
	expect(qhOutcome, "the held run ends without an error").toBeUndefined();
	world.faultMatrix.witness("R15", { control: false });
	trace.mark("root", "queued-quit.held");
	// Live control: the same queued input behind a run that completes is delivered as that run's next turn, and nothing is held.
	const QUEUED_CONTROL_WORDS = "Owner input queued behind a reply that completes.";
	const qlHold = createBarrier();
	const qlReached = createBarrier();
	const qlCreated = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: { memorySystem: "okf" },
	});
	const qlSession = qlCreated.session;
	const qlFile = qlCreated.sessionManager.getSessionFile();
	if (qlFile === undefined) throw new Error("the queued quit live control owner has no file");
	world.provider.enqueue("root", {
		name: "queued-control-run",
		check: () => qlReached.release(),
		gate: qlHold.promise,
		reply: { content: [{ type: "text", text: "The held reply" }] },
	});
	world.provider.enqueue("root", {
		name: "queued-control-delivery",
		reply: { content: [{ type: "text", text: "The queued reply" }] },
	});
	const qlPrompt = qlSession
		.prompt("Start a reply that the owner queues input behind, then completes.")
		.catch((error: unknown) => error);
	await withDeadline(trace, "queued control: the run reaches its gate", qlReached.promise);
	if (world.systemOne.enabled) {
		world.systemOne.enterPhase("queued-control-intake", {
			capabilities_authorized: { kind: "noul", probability: 0.02 },
			changes_model_pools: { kind: "noul", probability: 0.02 },
			local_commits_only: { kind: "noul", probability: 0.02 },
			lifts_delivery_block: { kind: "noul", probability: 0.02 },
			full_handoff: { kind: "noul", probability: 0.02 },
			optional_tool_0: { kind: "choice", choice: "request", confidence: 0.97 },
		});
	}
	await withDeadline(
		trace,
		"queued control: the owner input is admitted behind the run",
		qlSession.followUp(QUEUED_CONTROL_WORDS),
	);
	const qlMark = world.warnings.length;
	qlHold.release();
	const qlOutcome = await withDeadline(
		trace,
		"queued control: the run and its queued turn complete",
		qlPrompt,
		60_000,
	);
	expect(qlOutcome, "the live control run ends without an error").toBeUndefined();
	expect(
		world.warnings.slice(qlMark).filter((message) => message.includes("was not delivered")),
		"a queued input that the run delivers is never held",
	).toEqual([]);
	expect(qmAssistants(qlFile), "the queued input runs as the turn after the completed reply").toEqual([
		{ stopReason: "stop", text: "The held reply" },
		{ stopReason: "stop", text: "The queued reply" },
	]);
	world.faultMatrix.witness("R15", { control: true });
	expect(await world.disposeSessionInBody(qlSession), "the live control owner disposes cleanly").toBeUndefined();
	trace.mark("root", "queued-quit.live-control");
	// Restart restore: the next session opened on the quit's file restores its held follow-up, held: counted and shown in the
	// queue, never delivered on its own, with its one restore notice, and without rewriting the record that names it. Control:
	// the next session opened on the live control's file restores nothing, because its queued input was delivered.
	const queuedRecordCount = (file: string): number =>
		(world.io.peekFile(file) ?? "")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { type?: string; customType?: string })
			.filter((entry) => entry.type === "custom" && entry.customType === QUEUED_INPUT_CUSTOM_TYPE).length;
	// The one restore notice for one held input on a host with no editor (`takeRestoredQueuedInputNotice("headless")`).
	const RESTORED_ONE_HEADLESS =
		"Restored 1 queued message from the previous run; they are held, not delivered, and stay held for the next interactive session on this session (RPC: pendingMessageCount in get_state counts them, clear_queue drops them).";
	const qhRecords = queuedRecordCount(qhFile);
	const qhNext = await world.createRootSession("root", {
		sessionManager: world.openSessionManager(qhFile),
		settings: { memorySystem: "okf" },
	});
	expect(
		{
			steering: qhNext.session.getSteeringMessages(),
			followUp: qhNext.session.getFollowUpMessages(),
			pending: qhNext.session.pendingMessageCount,
			deliverable: qhNext.session.deliverablePendingMessageCount,
			notice: qhNext.session.takeRestoredQueuedInputNotice("headless"),
			records: queuedRecordCount(qhFile),
		},
		"the next session restores the held follow-up, held, as its record names it",
	).toEqual({
		steering: [],
		followUp: [QUEUED_QUIT_WORDS],
		pending: 1,
		deliverable: 0,
		notice: RESTORED_ONE_HEADLESS,
		records: qhRecords,
	});
	world.faultMatrix.witness("R15r", { control: false });
	if (world.systemOne.enabled) {
		// R14r. Before the quit, the queued input was judged against the native optional tool and its intent staged; the quit held
		// the input before its delivery, so its staged intent was released with it and nothing reached the chain: the next session
		// restores the input held, with no optional-tool entry. Control: the owner resends the restored input in the next session
		// behind a held run. It is judged afresh with the question set the first process asked (no older intent and no backlog
		// exists in a fresh process), and its classified intent is committed once, where the run delivers it.
		const intentRecords = () =>
			qhNext.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === OPTIONAL_TOOL_INTENT_CUSTOM_TYPE
						? [readOptionalToolIntent(entry.data)]
						: [],
				);
		const intakeOf = (phase: string) => {
			const request = world.systemOne.decoded.find((decoded) => decoded.phase === phase);
			const state = request?.state as
				| { user_request?: unknown; optional_tools?: Array<{ toolName?: unknown; sourcePath?: unknown }> }
				| undefined;
			return {
				questions: Object.keys(request?.questions ?? {}).sort(),
				request: state?.user_request,
				tools: state?.optional_tools?.map((tool) => tool.toolName),
				sourcePath: state?.optional_tools?.[0]?.sourcePath,
			};
		};
		const quitIntake = intakeOf("queued-quit-intake");
		expect(
			{ request: quitIntake.request, tools: quitIntake.tools },
			"before the quit, the queued input was judged against the native optional tool",
		).toEqual({ request: QUEUED_QUIT_WORDS, tools: ["secret_store"] });
		expect(intentRecords(), "the quit commits no optional-tool intent: the held input is restored with none").toEqual(
			[],
		);
		world.faultMatrix.witness("R14r", { control: false });
		expect(qhNext.session.clearQueue().followUp, "the owner takes the restored input back to resend it").toEqual([
			QUEUED_QUIT_WORDS,
		]);
		const qrHold = createBarrier();
		const qrReached = createBarrier();
		world.provider.enqueue(
			"root",
			{
				name: "queued-resend-run",
				check: () => qrReached.release(),
				gate: qrHold.promise,
				reply: { content: [{ type: "text", text: "The held reply" }] },
			},
			{ name: "queued-resend-delivery", reply: { content: [{ type: "text", text: "The resent reply" }] } },
		);
		const qrPrompt = qhNext.session
			.prompt("Start a reply that the owner resends the restored input behind.")
			.catch((error: unknown) => error);
		await withDeadline(trace, "queued resend: the run reaches its gate", qrReached.promise);
		world.systemOne.enterPhase(
			"queued-resend-intake",
			{
				capabilities_authorized: { kind: "noul", probability: 0.02 },
				changes_model_pools: { kind: "noul", probability: 0.02 },
				local_commits_only: { kind: "noul", probability: 0.02 },
				lifts_delivery_block: { kind: "noul", probability: 0.02 },
				full_handoff: { kind: "noul", probability: 0.02 },
				optional_tool_0: { kind: "choice", choice: "request", confidence: 0.97 },
			},
			{
				expect: expectOwnerWords({
					sessionManager: () => qhNext.sessionManager,
					userRequests: [QUEUED_QUIT_WORDS],
					optionalToolNames: ["secret_store"],
				}),
			},
		);
		await withDeadline(
			trace,
			"queued resend: the restored input is admitted behind the run",
			qhNext.session.followUp(QUEUED_QUIT_WORDS),
		);
		expect(intentRecords(), "the resent input's judgment commits no intent before its delivery").toEqual([]);
		qrHold.release();
		expect(
			await withDeadline(trace, "queued resend: the run and its queued turn complete", qrPrompt, 60_000),
			"the resending run ends without an error",
		).toBeUndefined();
		expect(qmAssistants(qhFile), "the resent input runs as the turn after the held reply").toEqual([
			{ stopReason: "aborted", text: "" },
			{ stopReason: "stop", text: "The held reply" },
			{ stopReason: "stop", text: "The resent reply" },
		]);
		const resendIntake = intakeOf("queued-resend-intake");
		expect(
			resendIntake.questions,
			"the next session asks the resent words the question set the first process asked for them",
		).toEqual(quitIntake.questions);
		expect(intentRecords(), "the resent input commits its classified intent once, at its delivery").toEqual([
			{
				version: 1,
				status: "classified",
				taskRequest: QUEUED_QUIT_WORDS,
				allowedTools: [
					{
						toolName: "secret_store",
						sourcePath: typeof resendIntake.sourcePath === "string" ? resendIntake.sourcePath : "",
					},
				],
			},
		]);
		world.faultMatrix.witness("R14r", { control: true });
	}
	expect(await world.disposeSessionInBody(qhNext.session), "the restoring owner disposes cleanly").toBeUndefined();
	const qlNext = await world.createRootSession("root", {
		sessionManager: world.openSessionManager(qlFile),
		settings: { memorySystem: "okf" },
	});
	expect(
		{
			steering: qlNext.session.getSteeringMessages(),
			followUp: qlNext.session.getFollowUpMessages(),
			pending: qlNext.session.pendingMessageCount,
			notice: qlNext.session.takeRestoredQueuedInputNotice("headless"),
		},
		"the next session restores no queued input that was delivered",
	).toEqual({ steering: [], followUp: [], pending: 0, notice: undefined });
	world.faultMatrix.witness("R15r", { control: true });
	// Kept input (how the interactive queue keeps what the owner submits while compaction runs): the session keeps it held in
	// its durable record, so the next session restores it held. Control: kept input the owner took back is not restored.
	const KEPT_WORDS = "Owner input kept until compaction ends.";
	qlNext.session.keepQueuedInput("followUp", KEPT_WORDS);
	expect(
		await world.disposeSessionInBody(qlNext.session),
		"the control's next owner disposes cleanly",
	).toBeUndefined();
	const reopenQl = (extensionFactories?: readonly ExtensionFactory[]) =>
		world.createRootSession("root", {
			sessionManager: world.openSessionManager(qlFile),
			settings: { memorySystem: "okf" },
			...(extensionFactories ? { extensionFactories } : {}),
		});
	const restoredView = (session: AgentSession) => ({
		followUp: session.getFollowUpMessages(),
		pending: session.pendingMessageCount,
		deliverable: session.deliverablePendingMessageCount,
		notice: session.takeRestoredQueuedInputNotice("headless"),
	});
	const qkNext = await reopenQl();
	expect(restoredView(qkNext.session), "the next session restores the kept input, held").toEqual({
		followUp: [KEPT_WORDS],
		pending: 1,
		deliverable: 0,
		notice: RESTORED_ONE_HEADLESS,
	});
	world.faultMatrix.witness("R15k", { control: false });
	expect(qkNext.session.takeAllQueuedInput().followUp, "the owner takes the kept input back").toEqual([
		{ text: KEPT_WORDS },
	]);
	expect(
		await world.disposeSessionInBody(qkNext.session),
		"the kept input's next owner disposes cleanly",
	).toBeUndefined();
	const qtNext = await reopenQl();
	expect(restoredView(qtNext.session), "the next session restores no kept input the owner took back").toEqual({
		followUp: [],
		pending: 0,
		deliverable: 0,
		notice: undefined,
	});
	world.faultMatrix.witness("R15k", { control: true });
	expect(
		await world.disposeSessionInBody(qtNext.session),
		"the take-back's next owner disposes cleanly",
	).toBeUndefined();
	// A quit while a prompt's own turn is prepared: an extension's input hook holds the prompt, so it is accepted and named in the
	// own-turn record beside the written session file, and its user entry is not persisted. The quit closes the queue and never
	// rewrites that record, so the submission ends the prompt held (closed) and the next session restores it held, with its one
	// restore notice. Control, first in the same owner: the same held prompt the owner interrupts (its caller's signal) before the
	// quit ends cancelled and leaves the record, so the next session does not restore it.
	const ownTurnPath = ownTurnInputRecordPath(qlFile);
	// The prompts the own-turn record names, as submitted; undefined when there is no record.
	const ownTurnTexts = (): string[] | undefined => {
		const record = world.io.peekFile(ownTurnPath);
		return record === undefined
			? undefined
			: (JSON.parse(record) as { inputs: { text: string }[] }).inputs.map((input) => input.text);
	};
	const PREPARING_CONTROL_WORDS = "Owner prompt in preparation that the owner interrupts.";
	const PREPARING_WORDS = "Owner prompt still in preparation at the quit.";
	// The one restore notice for one restored prompt that was being prepared, on a host with no editor.
	const RESTORED_PREPARING_HEADLESS =
		"Restored 1 prompt that was being prepared from the previous run; they are held, not delivered, and stay held for the next interactive session on this session (RPC: pendingMessageCount in get_state counts them, clear_queue drops them).";
	const prepControl = { hold: createBarrier(), reached: createBarrier() };
	const prepQuit = { hold: createBarrier(), reached: createBarrier() };
	const prepHolds = new Map([
		[PREPARING_CONTROL_WORDS, prepControl],
		[PREPARING_WORDS, prepQuit],
	]);
	const prepOwner = await reopenQl([
		(pi) => {
			pi.on("input", async (event) => {
				const held = prepHolds.get(event.text);
				if (held === undefined) return;
				held.reached.release();
				await held.hold.promise;
			});
		},
	]);
	const prepSession = prepOwner.session;
	await prepSession.bindExtensions({ uiContext: world.humanInput.ui });
	const prepControlVerdicts: Array<{ accepted: boolean; ended: unknown }> = [];
	const prepInterrupt = new AbortController();
	const prepControlPrompt = prepSession.prompt(PREPARING_CONTROL_WORDS, {
		signal: prepInterrupt.signal,
		preflightResult: (accepted, ended) => prepControlVerdicts.push({ accepted, ended }),
	});
	await withDeadline(trace, "preparing control: the prompt waits in its input hook", prepControl.reached.promise);
	expect(ownTurnTexts(), "the own-turn record names the prompt being prepared").toEqual([PREPARING_CONTROL_WORDS]);
	prepInterrupt.abort();
	prepControl.hold.release();
	expect(
		await withDeadline(trace, "preparing control: the interrupted prompt ends", prepControlPrompt),
		"the interrupted prompt ends without an error",
	).toBeUndefined();
	expect(prepControlVerdicts, "the interrupted prompt is not accepted, and ends cancelled by the interrupt").toEqual([
		{ accepted: false, ended: { state: "cancelled", reason: "interrupted" } },
	]);
	expect(ownTurnTexts(), "the interrupted prompt leaves the own-turn record").toBeUndefined();
	const prepQuitVerdicts: Array<{ accepted: boolean; ended: unknown }> = [];
	const prepQuitPrompt = prepSession.prompt(PREPARING_WORDS, {
		preflightResult: (accepted, ended) => prepQuitVerdicts.push({ accepted, ended }),
	});
	await withDeadline(trace, "preparing quit: the prompt waits in its input hook", prepQuit.reached.promise);
	expect(ownTurnTexts(), "the own-turn record names the prompt the quit cuts").toEqual([PREPARING_WORDS]);
	// The quit closes the queue and cancels the submission before disposeAndWait first awaits; the hook returns after that.
	const prepClosing = prepSession.disposeAndWait();
	prepQuit.hold.release();
	expect(
		await withDeadline(
			trace,
			"preparing quit: the held prompt ends and the owner disposes",
			Promise.all([prepQuitPrompt, prepClosing]),
			60_000,
		),
		"the prompt the quit cut ends without an error, and the owner disposes cleanly",
	).toEqual([undefined, undefined]);
	expect(
		prepQuitVerdicts,
		"the prompt the quit cut is not accepted, and ends held because the session closed",
	).toEqual([{ accepted: false, ended: { state: "held", reason: "closed" } }]);
	expect(ownTurnTexts(), "the closed session leaves the own-turn record naming the prompt").toEqual([PREPARING_WORDS]);
	const prepNext = await reopenQl();
	expect(
		restoredView(prepNext.session),
		"the next session restores the prompt the quit cut, held, and not the interrupted one",
	).toEqual({
		followUp: [PREPARING_WORDS],
		pending: 1,
		deliverable: 0,
		notice: RESTORED_PREPARING_HEADLESS,
	});
	world.faultMatrix.witness("owner-input-preflight-restart", { control: false });
	world.faultMatrix.witness("owner-input-preflight-restart", { control: true });
	expect(prepNext.session.takeAllQueuedInput().followUp, "the owner takes the restored prompt back").toEqual([
		{ text: PREPARING_WORDS },
	]);
	expect(await world.disposeSessionInBody(prepNext.session), "the restoring owner disposes cleanly").toBeUndefined();
	// The files a crash cut names, as they stand now: one that does not exist is absent.
	const presentFiles = (paths: readonly string[]): Map<string, string> => {
		const files = new Map<string, string>();
		for (const path of paths) {
			const content = world.io.peekFile(path);
			if (content !== undefined) files.set(path, content);
		}
		return files;
	};
	// A crash while a prompt's own turn is prepared: the session file and the own-turn record are captured while the prompt waits in
	// its input hook, and the restart cuts back to that capture. The restart's interrupt cancels the submission before its first
	// await (the hook returns after that), so the prompt ends cancelled and its record is removed: the control, nothing would be
	// restored without the cut. The cut writes the record back, so the next session restores the prompt held, with its one notice.
	const PREPARING_CRASH_WORDS = "Owner prompt still in preparation at the crash.";
	const prepCrash = { hold: createBarrier(), reached: createBarrier() };
	const crashOwner = await reopenQl([
		(pi) => {
			pi.on("input", async (event) => {
				if (event.text !== PREPARING_CRASH_WORDS) return;
				prepCrash.reached.release();
				await prepCrash.hold.promise;
			});
		},
	]);
	await crashOwner.session.bindExtensions({ uiContext: world.humanInput.ui });
	expect(restoredView(crashOwner.session), "the crash owner opens with nothing restored").toEqual({
		followUp: [],
		pending: 0,
		deliverable: 0,
		notice: undefined,
	});
	const crashVerdicts: Array<{ accepted: boolean; state: string | undefined }> = [];
	const crashPrompt = crashOwner.session.prompt(PREPARING_CRASH_WORDS, {
		preflightResult: (accepted, ended) => crashVerdicts.push({ accepted, state: ended?.state }),
	});
	await withDeadline(trace, "preparing crash: the prompt waits in its input hook", prepCrash.reached.promise);
	expect(ownTurnTexts(), "the own-turn record names the prompt the crash cuts").toEqual([PREPARING_CRASH_WORDS]);
	const crashCapture = presentFiles([qlFile, ownTurnPath]);
	expect([...crashCapture.keys()], "the crash capture holds the session file and the own-turn record").toEqual([
		qlFile,
		ownTurnPath,
	]);
	const crashRestart = world.restart({
		owner: crashOwner.session,
		sessionFile: qlFile,
		cut: { manifest: () => presentFiles([qlFile, ownTurnPath]), capture: crashCapture },
		rewindSqlite: false,
		retainedClaims: [],
		reopen: { settings: { memorySystem: "okf" } },
		check: {
			...crashCutChecks("the crash owner disposes cleanly"),
			disposed: (result) => {
				expect(result, "the crash owner disposes cleanly").toBeUndefined();
				expect(crashVerdicts, "the prompt the restart interrupted is not accepted, and ends cancelled").toEqual([
					{ accepted: false, state: "cancelled" },
				]);
				expect(ownTurnTexts(), "the interrupted prompt leaves the own-turn record before the cut").toBeUndefined();
				world.faultMatrix.witness("owner-input-preflight-crash", { control: true });
			},
		},
	});
	prepCrash.hold.release();
	const crashNext = await withDeadline(trace, "preparing crash: the restart reopens the file", crashRestart, 60_000);
	expect(
		await withDeadline(trace, "preparing crash: the cut prompt ends", crashPrompt),
		"the prompt the crash cut ends without an error",
	).toBeUndefined();
	expect(restoredView(crashNext.session), "the next session restores the prompt the crash cut, held").toEqual({
		followUp: [PREPARING_CRASH_WORDS],
		pending: 1,
		deliverable: 0,
		notice: RESTORED_PREPARING_HEADLESS,
	});
	world.faultMatrix.witness("owner-input-preflight-crash", { control: false });
	expect(crashNext.session.takeAllQueuedInput().followUp, "the owner takes the restored prompt back").toEqual([
		{ text: PREPARING_CRASH_WORDS },
	]);
	expect(
		await world.disposeSessionInBody(crashNext.session),
		"the crash's next owner disposes cleanly",
	).toBeUndefined();
	// R7 and R36, System One off (the queued directives' on-mode intake asks questions no reading of this phase derives): a queued
	// owner directive promoted to its own turn, then crash-cut while that turn is prepared. A held prompt owns the foreground in its
	// input hook while the directive is queued behind it; the owner interrupts the held prompt, so the directive takes the
	// foreground as its own turn (`PendingInputQueueController.promote`), keeping its queued record. The control directive's turn
	// runs and delivers it, so it becomes the owner's rule; the cut directive is held at `before_agent_start`, before its user entry,
	// and the capture is taken there. The restart's interrupt returns it to the queue held, and the cut writes back the record that
	// names it: the next session restores it held, once, and not the delivered one, and only the delivered directive is a rule.
	// The rules are project-scoped per agent directory, so this owner has its own.
	if (!world.systemOne.enabled) {
		const promotedDir = `${world.agentDir}-promoted`;
		const PROMOTED_CONTROL_HOLD = "Owner prompt held while the delivered directive waits.";
		const PROMOTED_CONTROL_WORDS = "Owner directive delivered after promotion: no TDD in this project.";
		const PROMOTED_HOLD = "Owner prompt held while the cut directive waits.";
		const PROMOTED_WORDS = "Owner directive promoted before the cut: skip the full test suite.";
		const promotedControlHold = { hold: createBarrier(), reached: createBarrier() };
		const promotedCutHold = { hold: createBarrier(), reached: createBarrier() };
		const promotedHolds = new Map([
			[PROMOTED_CONTROL_HOLD, promotedControlHold],
			[PROMOTED_HOLD, promotedCutHold],
		]);
		const promotedStart = { hold: createBarrier(), reached: createBarrier() };
		const promoted = await world.createRootSession("root", {
			sessionManager: world.createSessionManager(promotedDir),
			agentDir: promotedDir,
			settings: { memorySystem: "okf" },
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						const held = promotedHolds.get(event.text);
						if (held === undefined) return;
						held.reached.release();
						await held.hold.promise;
					});
					pi.on("before_agent_start", async (event) => {
						if (event.prompt !== PROMOTED_WORDS) return;
						promotedStart.reached.release();
						await promotedStart.hold.promise;
					});
				},
			],
		});
		const promotedSession = promoted.session;
		await promotedSession.bindExtensions({ uiContext: world.humanInput.ui });
		const promotedFile = promoted.sessionManager.getSessionFile();
		if (promotedFile === undefined) throw new Error("the promoted directives' owner has no file");
		const promotedOwnTurn = ownTurnInputRecordPath(promotedFile);
		const ruleForbids = (session: AgentSession) => session.getOwnerRulePolicies().map((policy) => policy.forbid);
		// The texts the latest queued record of `file` names, in order.
		const latestQueuedTexts = (file: string): string[] | undefined =>
			(world.io.peekFile(file) ?? "")
				.split("\n")
				.filter((line) => line.length > 0)
				.map(
					(line) =>
						JSON.parse(line) as { type?: string; customType?: string; data?: { inputs?: { text: string }[] } },
				)
				.filter((entry) => entry.type === "custom" && entry.customType === QUEUED_INPUT_CUSTOM_TYPE)
				.at(-1)
				?.data?.inputs?.map((input) => input.text);
		world.provider.enqueue(
			"root",
			{ name: "promoted-open", reply: { content: [{ type: "text", text: "The session is open." }] } },
			{
				name: "promoted-control-delivery",
				reply: { content: [{ type: "text", text: "The delivered directive ran." }] },
			},
		);
		await withDeadline(
			trace,
			"promoted: the opening turn writes the session file",
			promotedSession.prompt("Open the session the promoted directives run in."),
		);
		// One promotion: `words` is queued behind a prompt held in its input hook, and the owner interrupts that prompt.
		const promote = async (held: typeof promotedControlHold, holdWords: string, words: string, label: string) => {
			const interrupt = new AbortController();
			const holding = promotedSession.prompt(holdWords, { signal: interrupt.signal });
			await withDeadline(trace, `${label}: the held prompt waits in its input hook`, held.reached.promise);
			const verdicts: Array<{ accepted: boolean; state: string | undefined }> = [];
			const queued = promotedSession.prompt(words, {
				streamingBehavior: "followUp",
				preflightResult: (accepted, ended) => verdicts.push({ accepted, state: ended?.state }),
			});
			interrupt.abort();
			held.hold.release();
			expect(
				await withDeadline(trace, `${label}: the interrupted prompt ends`, holding),
				"the interrupted prompt ends without an error",
			).toBeUndefined();
			return { queued, verdicts };
		};
		const promotedControl = await promote(
			promotedControlHold,
			PROMOTED_CONTROL_HOLD,
			PROMOTED_CONTROL_WORDS,
			"promoted control",
		);
		expect(
			await withDeadline(
				trace,
				"promoted control: the directive's own turn completes",
				promotedControl.queued,
				60_000,
			),
			"the promoted control directive's turn ends without an error",
		).toBeUndefined();
		expect(
			{
				verdicts: promotedControl.verdicts,
				reply: qmAssistants(promotedFile).at(-1),
				rules: ruleForbids(promotedSession),
			},
			"the promoted directive is accepted as its own turn, runs, and its delivery makes it the owner's rule",
		).toEqual({
			verdicts: [{ accepted: true, state: undefined }],
			reply: { stopReason: "stop", text: "The delivered directive ran." },
			rules: [["tdd_workflow"]],
		});
		const promotedCut = await promote(promotedCutHold, PROMOTED_HOLD, PROMOTED_WORDS, "promoted cut");
		await withDeadline(trace, "promoted cut: the directive's own turn is prepared", promotedStart.reached.promise);
		const promotedCapture = presentFiles([promotedFile, promotedOwnTurn]);
		expect(
			{
				files: [...promotedCapture.keys()],
				queued: latestQueuedTexts(promotedFile),
				rules: ruleForbids(promotedSession),
			},
			"the cut is taken while the promoted directive is named by the queued record only, and is not yet a rule",
		).toEqual({ files: [promotedFile], queued: [PROMOTED_WORDS], rules: [["tdd_workflow"]] });
		const promotedMark = world.warnings.length;
		const promotedRestart = world.restart({
			owner: promotedSession,
			sessionFile: promotedFile,
			cut: { manifest: () => presentFiles([promotedFile, promotedOwnTurn]), capture: promotedCapture },
			rewindSqlite: false,
			retainedClaims: [],
			reopen: { agentDir: promotedDir, settings: { memorySystem: "okf" } },
			check: crashCutChecks("the promoted directives' owner disposes cleanly"),
		});
		promotedStart.hold.release();
		const promotedNext = await withDeadline(
			trace,
			"promoted cut: the restart reopens the file",
			promotedRestart,
			60_000,
		);
		expect(
			await withDeadline(trace, "promoted cut: the directive's submission ends", promotedCut.queued),
			"the cut directive's submission ends without an error",
		).toBeUndefined();
		expect(
			{
				verdicts: promotedCut.verdicts,
				held: world.warnings.slice(promotedMark).filter((message) => message.includes("was not delivered")),
			},
			"the interrupted turn returns the promoted directive to the queue held, once, with its text",
		).toEqual({
			verdicts: [{ accepted: false, state: "held" }],
			held: [
				`A queued message was not delivered because its turn ended before it could be delivered. It is kept in full in the pending queue; restore it to the editor to send it again: ${PROMOTED_WORDS}`,
			],
		});
		expect(
			{ ...restoredView(promotedNext.session), rules: ruleForbids(promotedNext.session) },
			"the next session restores the cut directive held, once, and not the delivered one; only the delivered directive is a rule",
		).toEqual({
			followUp: [PROMOTED_WORDS],
			pending: 1,
			deliverable: 0,
			notice: RESTORED_ONE_HEADLESS,
			rules: [["tdd_workflow"]],
		});
		world.faultMatrix.witness("R7", { control: false });
		world.faultMatrix.witness("R7", { control: true });
		world.faultMatrix.witness("R36", { control: false });
		world.faultMatrix.witness("R36", { control: true });
		expect(promotedNext.session.takeAllQueuedInput().followUp, "the owner takes the restored directive back").toEqual(
			[{ text: PROMOTED_WORDS }],
		);
		expect(
			await world.disposeSessionInBody(promotedNext.session),
			"the promoted directives' next owner disposes cleanly",
		).toBeUndefined();
	}
	trace.mark("root", "queued-quit.restart-restore");

	// RPC host shutdown: the host runs on a real runtime of the world with its process effects injected. A SIGTERM through its termination
	// handler delivers the dispose's closing warning as a warning event on the open stream, and a warning written after the host released
	// its stream reaches the terminal's sink. A failing dispose reports every cause on stderr and exits with the signal's status (143); the
	// input-end path exits 0 when clean and 1 when the dispose fails. The flush after a SIGTERM is bounded at one second.
	const rpcSigterm = await runRpcHost(world, trace, {
		trigger: "sigterm",
		disposeFails: false,
		flushNeverResolves: false,
	});
	expect(rpcSigterm.startupErrors, "the RPC host starts without an error").toEqual([]);
	expect(
		rpcSigterm.lines.find((line) => line.id === "rpc-state"),
		"the scripted command is answered by the host",
	).toMatchObject({ type: "response", command: "get_state", success: true });
	expect(
		rpcSigterm.lines.filter((line) => line.message === RPC_CLOSING_WARNING).map((line) => line.type),
		"the closing warning reaches the open stream once, as a warning event",
	).toEqual(["warning"]);
	expect(rpcSigterm.exits, "a clean SIGTERM shutdown exits with the signal's status").toEqual([143]);
	expect(rpcSigterm.stderr, "a clean SIGTERM shutdown writes no failure line").toEqual([]);
	expect(rpcSigterm.sinkWarnings, "the released stream hands a later warning to the terminal's sink").toEqual([
		RPC_LATE_WARNING,
	]);
	expect(rpcSigterm.flushRequests, "the SIGTERM shutdown flushes the stream once").toBe(1);
	world.faultMatrix.witness("R42", { control: true });
	// Input end and output failures during a SIGTERM dispose: neither ends the shutdown early, and the exit waits for the dispose.
	const rpcHeld = await runRpcHost(world, trace, { trigger: "sigterm", holdDispose: "input-end" });
	expect(rpcHeld).toMatchObject(RPC_INPUT_END_HELD_EXPECTED);
	const rpcOwner = await runRpcHost(world, trace, { trigger: "sigterm", holdDispose: "output-failures" });
	expect(rpcOwner).toMatchObject(RPC_OUTPUT_OWNER_EXPECTED);
	const rpcSigtermFails = await runRpcHost(world, trace, {
		trigger: "sigterm",
		disposeFails: true,
		flushNeverResolves: false,
	});
	expect(rpcSigtermFails.stderr, "a failing dispose reports every cause on stderr, once").toEqual([
		"RPC shutdown failed: dispose failed (cleanup a; cleanup b)\n",
	]);
	expect(rpcSigtermFails.exits, "a failing SIGTERM shutdown exits with the signal's status").toEqual([143]);
	expect(
		rpcSigtermFails.lines.filter((line) => line.message === RPC_CLOSING_WARNING).map((line) => line.type),
		"the failing dispose's closing warning still reaches the open stream",
	).toEqual(["warning"]);
	expect(rpcSigtermFails.sinkWarnings, "a failing dispose still releases the stream").toEqual([RPC_LATE_WARNING]);
	world.faultMatrix.witness("R42", { control: false });
	const rpcFlushBound = await runRpcHost(world, trace, {
		trigger: "sigterm",
		disposeFails: false,
		flushNeverResolves: true,
	});
	expect(rpcFlushBound.exits, "a flush that never resolves does not hold a SIGTERM exit").toEqual([143]);
	expect(rpcFlushBound.stderr, "a flush that is cut off by its bound is not a failure").toEqual([]);
	expect(rpcFlushBound.elapsedMs, "the SIGTERM flush waits its one-second bound").toBeGreaterThanOrEqual(900);
	expect(rpcFlushBound.elapsedMs, "the SIGTERM flush is not held to the wait deadline").toBeLessThan(10_000);
	expect(rpcFlushBound.sinkWarnings, "the bounded flush still releases the stream").toEqual([RPC_LATE_WARNING]);
	const rpcInputEnd = await runRpcHost(world, trace, {
		trigger: "stdin-end",
		disposeFails: false,
		flushNeverResolves: false,
	});
	expect(rpcInputEnd.exits, "a clean shutdown when the input ends exits 0").toEqual([0]);
	expect(rpcInputEnd.stderr, "a clean shutdown when the input ends writes no failure line").toEqual([]);
	expect(rpcInputEnd.sinkWarnings, "the input-end shutdown releases the stream too").toEqual([RPC_LATE_WARNING]);
	const rpcInputEndFails = await runRpcHost(world, trace, {
		trigger: "stdin-end",
		disposeFails: true,
		flushNeverResolves: false,
	});
	expect(rpcInputEndFails.exits, "a failing shutdown when the input ends exits 1").toEqual([1]);
	expect(rpcInputEndFails.stderr, "a failing shutdown when the input ends reports every cause").toEqual([
		"RPC shutdown failed: dispose failed (cleanup a; cleanup b)\n",
	]);
	// The output stream fails (a client that went away): the host disposes in order and exits 1, and the closing warning the dispose
	// raises goes to the terminal's sink, not to the dead stream. Before this, the output guard ended the process at once.
	const rpcOutputFailure = await runRpcHost(world, trace, {
		trigger: "output-failure",
		disposeFails: false,
		flushNeverResolves: false,
	});
	expect(rpcOutputFailure.exits, "an output failure shuts the host down in order and exits 1").toEqual([1]);
	expect(rpcOutputFailure.stderr, "a clean dispose after an output failure writes no failure line").toEqual([]);
	expect(rpcOutputFailure.flushRequests, "a dead output stream is not flushed").toBe(0);
	expect(rpcOutputFailure.sinkWarnings, "the closing warning reaches the terminal sink, then the late one").toEqual([
		RPC_CLOSING_WARNING,
		RPC_LATE_WARNING,
	]);
	expect(
		rpcOutputFailure.lines.filter((line) => line.message === RPC_CLOSING_WARNING),
		"the closing warning is not written to the dead stream",
	).toEqual([]);
	const rpcOutputFailureFails = await runRpcHost(world, trace, {
		trigger: "output-failure",
		disposeFails: true,
		flushNeverResolves: false,
	});
	expect(rpcOutputFailureFails.exits, "an output failure with a failing dispose exits 1").toEqual([1]);
	expect(rpcOutputFailureFails.stderr, "the failing dispose is reported after an output failure").toEqual([
		"RPC shutdown failed: dispose failed (cleanup a; cleanup b)\n",
	]);
	trace.mark("root", "rpc.shutdown");
	expect(await runDiscardScanBounds(world)).toEqual(DISCARD_SCAN_BOUNDS_EXPECTED);
	const runtimeDiscard = await runDiscardThroughRuntime(world);
	expect(runtimeDiscard).toMatchObject({
		rejection:
			"Session replacement activation failed; the previous session was restored: the candidate's activation is refused",
		candidateKept: true,
		restoredWarnings: [
			`Usage handoff: the paid usage rows of ${runtimeDiscard.candidateFile} could not be counted (Scripted IO fault runtime-discard-scan-read: read '${runtimeDiscard.candidateFile}'), so this rejected replacement's session file is kept as recovery evidence.`,
		],
		routed: [],
	});
	expect(await runSdkConstructionFailure(world)).toEqual(SDK_CONSTRUCTION_FAILURE_EXPECTED);
	// The expected witness holds each fault outcome next to its control (control, disposalControl, workDirectory's controls).
	for (const id of ["R40", "R41", "R42"]) {
		world.faultMatrix.witness(id, { control: false });
		world.faultMatrix.witness(id, { control: true });
	}
}

/**
 * R45: a runtime-update stop with owner input queued. A fresh root reloads its runtime through runtime_update, verifies the
 * reload with read, and is held at its next provider request while the owner steers. Fault: the agent stops the update. The
 * stop ends the run at that tool batch, before the loop polls steering, so no round is opened for the steer: the run holds
 * it, complete, in the pending queue with its turn-ended notice. Control: the same update completed instead leaves no active
 * update, so the loop delivers the queued steer as its next turn. Each owner runs System One off in its own binding.
 */
async function verifyRuntimeUpdateStopHoldsQueuedInput(world: HarnessWorld): Promise<void> {
	const words = "Owner steer queued behind the runtime update.";
	const loadedNotice =
		"Runtime update loaded. Priority: verify the change using read, then call runtime_update complete before resuming the original task. Import success alone is not task verification. Existing history is preserved.";
	for (const action of ["stop", "complete"] as const) {
		const stop = action === "stop";
		const label = `runtime-update-${action}`;
		const agentDir = `${world.agentDir}-${label}`;
		const sessionManager = world.createSessionManager(agentDir);
		const session = (
			await world.createRootSession("root", {
				agentDir,
				sessionManager,
				systemOneEnabled: false,
				settings: { memorySystem: "okf", autoLearn: { enabled: false } },
			})
		).session;
		world.systemOne.enterPhase(label, {});
		const hold = createBarrier();
		const reached = createBarrier();
		const requestMark = world.provider.requests.length;
		const warningMark = world.warnings.length;
		const steeredTurns = () =>
			sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						JSON.stringify(entry.message.content).includes(words),
				).length;
		let disposal: Promise<{ readonly error: unknown } | undefined> | undefined;
		try {
			expect(
				session
					.getActiveToolNames()
					.filter((name) => name === "read" || name === "runtime_update")
					.sort(),
				`${label}: the root holds runtime_update and its verification tool`,
			).toEqual(["read", "runtime_update"]);
			const readBefore = session.getToolDefinition("read");
			world.provider.enqueue(
				"root",
				calls(`${label}-reload`, [
					{
						id: `${label}-reload-1`,
						name: "runtime_update",
						arguments: { action: "reload", verificationTool: "read" },
					},
				]),
				calls(`${label}-verify`, [{ id: `${label}-verify-1`, name: "read", arguments: { path: LIMITS_PATH } }]),
				{
					...calls(`${label}-${action}`, [
						{ id: `${label}-${action}-1`, name: "runtime_update", arguments: { action } },
					]),
					check: () => reached.release(),
					gate: hold.promise,
				},
				...(stop ? [] : [text(`${label}-steered`, "The steered turn.")]),
			);
			const run = session.prompt("Reload the runtime, verify it, then decide on the update.").then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			await withDeadline(world.trace, `${label}: the decision request is held`, reached.promise);
			await withDeadline(world.trace, `${label}: the owner steers behind the update`, session.steer(words));
			expect(session.getSteeringMessages(), `${label}: the steer waits behind the held decision`).toEqual([words]);
			hold.release();
			expect(
				await withDeadline(world.trace, `${label}: the run ends`, run, 60_000),
				`${label}: the run resolves`,
			).toBe("resolved");
			expect(
				world.provider.requests.slice(requestMark).map((request) => request.model.id),
				stop
					? "the reload, its verification and the stop each reach the provider once, and no round follows the stop"
					: "the reload, its verification, the completion and the steered turn each reach the provider once",
			).toEqual(stop ? ["root", "root", "root"] : ["root", "root", "root", "root"]);
			const state = session.runtimeUpdates.getState();
			expect(state, `${label}: the reload loaded and was verified before the agent's decision`).toMatchObject({
				status: stop ? "stopped" : "complete",
				mode: "reload",
				verificationTool: "read",
				attempts: 1,
				turns: 2,
				verificationAfter: expect.any(String),
				...(stop ? { error: "Stopped by the agent; original task remains unfinished." } : {}),
			});
			if (!stop) expect(state?.error, "the completed update records no error").toBeUndefined();
			expect(session.getToolDefinition("read"), `${label}: the reload rebound the native tools`).not.toBe(
				readBefore,
			);
			expect(
				session.messages.flatMap((message) =>
					message.role === "custom" && message.customType === "runtime-update-notice" ? [message.content] : [],
				),
				`${label}: the update announced its loaded runtime once, and nothing else`,
			).toEqual([loadedNotice]);
			const warnings = world.warnings.splice(warningMark);
			if (stop) {
				expect(warnings, "the stop holds the queued steer its run no longer delivers").toEqual([
					`A queued message was not delivered because its turn ended before it could be delivered. It is kept in full in the pending queue; restore it to the editor to send it again: ${words}`,
				]);
				expect(steeredTurns(), "the stopped run delivered no turn for the steer").toBe(0);
				expect(session.getSteeringMessages(), "the stop keeps the complete steer in the pending queue").toEqual([
					words,
				]);
				expect(session.deliverablePendingMessageCount, "the held steer cannot be delivered by a later run").toBe(0);
				expect(session.agent.hasQueuedMessages(), "the agent queue holds no copy of the held steer").toBe(false);
				expect(
					session.takeAllQueuedInput().steering.map((input) => input.text),
					"the owner restores the complete held steer",
				).toEqual([words]);
				expect(session.pendingMessageCount, "the restored steer leaves the pending queue").toBe(0);
			} else {
				expect(warnings, "the completed update holds nothing").toEqual([]);
				expect(steeredTurns(), "the completed update delivers the queued steer once").toBe(1);
				expect(session.pendingMessageCount, "the delivered steer leaves the pending queue").toBe(0);
			}
			disposal = world.disposeSessionInBody(session);
			expect(await disposal, `${label}: the owner is disposed cleanly`).toBeUndefined();
			expect(world.warnings.splice(warningMark), `${label}: disposal discloses nothing`).toEqual([]);
			world.faultMatrix.witness("R45", { control: !stop });
		} finally {
			hold.release();
			if (disposal === undefined) await world.disposeSessionInBody(session);
		}
	}
}
