import "../builtin-install.ts";
import { expect } from "vitest";
import { ObjectiveMutationLedger } from "../../../../src/core/objective-execution/objective-mutation-ledger.ts";
import { RepositoryMutationObserver } from "../../../../src/core/objective-execution/repository-mutation-observer.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { createSessionWorkEvidenceJournal } from "../../../../src/core/system-one/session-work-diff.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import {
	ICM_INTAKE_JUDGMENTS,
	icmContinuousSettings,
	icmContinuousStore,
	icmLatestResult,
	icmReadContinuousRecords,
	icmWaitForChatIdle,
	latestBatchResults,
} from "./shared.ts";

export async function runJourney2ContinuousChatPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// ICM continuous-chat workers & runtime lease (Pi-adaptative-memory):
	// - A reader worker with memory.query receives the pinned parent <chat> birth view on its first turn, plus bounded zoom and date
	//   (4,096-byte page cap for workers, and string worker ids rejected by worker zoom's integer schema).
	// - Worker completion logs [worker-1] as kind "work" in the parent's continuous chat (deduped by claimId across session persistence),
	//   and root zoom("worker-1") pages the worker's transcript.
	// - Second live root on the same continuous-chat profile is refused by runtime.lease.json until the first root disposes.
	const wAgentDir = `${world.agentDir}-icm`;
	const wStore = icmContinuousStore(wAgentDir);
	world.setModelReasoning("worker-c", true, { xhigh: "xhigh" });

	const W_ICM_READER_PROFILE: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "w-icm-reader",
		description: "Read-only worker with continuous-chat zoom and date.",
		role: "explorer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "memory.query"],
		readOnly: true,
		toolNames: ["read", "zoom", "date"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: {},
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-08T00:00:00.000Z",
		updatedAt: "2026-10-08T00:00:00.000Z",
	};
	new OrchestrationProfileStore({
		agentDir: wAgentDir,
		cwd: HARNESS_PROJECT_CWD,
		projectTrusted: false,
	}).save(W_ICM_READER_PROFILE, "global");

	const wBigPath = projectPath("src", "w-big-echo.txt");
	const wBigEchoLines = Array.from(
		{ length: 90 },
		(_, idx) => `w-line-${String(idx).padStart(3, "0")}-${"w".repeat(64)}`,
	);
	const wBigEcho = `WORKER-ECHO-START-${wBigEchoLines.join("\n")}-WORKER-ECHO-END\n`;
	world.io.writeFileSync(wBigPath, wBigEcho);
	try {
		const wRoot = await world.createRootSession("root", {
			agentDir: wAgentDir,
			sessionManager: world.createSessionManager(wAgentDir),
			settings: icmContinuousSettings(),
		});
		world.provider.enqueue("worker-c", {
			name: "w-seed-leaf-2",
			reply: { content: [{ type: "text", text: "echo: 6 KB worker seed payload." }] },
		});
		world.provider.enqueue(
			"root",
			{
				name: "w-seed-call",
				reply: {
					content: [
						{ type: "thinking", thinking: "Read the 6 KB payload into continuous chat." },
						{ type: "toolCall", id: "w-seed-read", name: "read", arguments: { path: wBigPath } },
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "w-seed-reply",
				reply: {
					content: [{ type: "text", text: "Noted the 6 KB payload for worker zoom." }],
				},
			},
		);
		world.systemOne.enterPhase("w-icm-seed", ICM_INTAKE_JUDGMENTS);
		await withDeadline(trace, "w-icm seed turn", wRoot.session.prompt("Seed the 6 KB payload."));
		await icmWaitForChatIdle(world, wAgentDir, 4);

		// Turn 2: root dispatches the w-icm-reader worker via delegate. Starting Turn 2 pins the <chat> view of records 0..3
		// as the birth view that worker-1 inherits on its first turn.
		const wWorkerDone = createBarrier();
		const wWake = createBarrier();
		let workerBirthContext = "";
		let workerToolNames: string[] = [];
		const workerNavResults: Record<string, { isError: boolean; text: string }> = {};
		world.provider.enqueue(
			"root",
			calls("w-start", [
				{
					id: "w-start-1",
					name: "delegate",
					arguments: {
						action: "start",
						profileId: "w-icm-reader",
						instructions: "Inspect message 2 and message 0 in continuous chat, then submit your report.",
					},
				},
			]),
			{
				name: "w-start-reply",
				check: (request) => {
					const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
					if (started?.isError || !started?.text.includes("delegate started (running)")) {
						throw new Error(`the ICM reader worker did not start: ${started?.text ?? "no result"}`);
					}
				},
				reply: { content: [{ type: "text", text: "The ICM reader is started." }] },
			},
			{
				name: "w-wake",
				maxRequests: 8,
				until: (request) => {
					const everything = JSON.stringify(request.context.messages);
					const done =
						everything.includes("Background worker terminal handoff") && everything.includes("succeeded");
					if (done) wWake.release();
					return done;
				},
				reply: { content: [{ type: "text", text: "Background work is settling." }] },
			},
		);
		world.provider.enqueue(
			"worker-a",
			{
				name: "w-icm-worker-zoom-p0",
				check: (request) => {
					workerBirthContext = JSON.stringify(request.context.messages);
					workerToolNames = (request.context.tools ?? []).map((tool) => tool.name);
				},
				reply: {
					content: [
						{ type: "thinking", thinking: "Read page 0 of message 2 with the 4 KiB worker page cap." },
						{ type: "toolCall", id: "w-worker-zoom-2", name: "zoom", arguments: { id: 2, n: 1, page: 0 } },
					],
					usage: {
						input: 16,
						output: 8,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 24,
						details: { promptTokens: 16, answerTokens: 4, reasoningTokens: 4, serviceTier: "priority" },
						cost: { estimate: "base-rates", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
				},
			},
			{
				name: "w-icm-worker-date-0",
				check: (request) => {
					workerNavResults.zoom2 = icmLatestResult(request, "zoom");
				},
				reply: {
					content: [
						{ type: "thinking", thinking: "Check date of message 0." },
						{ type: "toolCall", id: "w-worker-date-0", name: "date", arguments: { id: 0 } },
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "w-icm-worker-refuse-name",
				check: (request) => {
					workerNavResults.date0 = icmLatestResult(request, "date");
				},
				reply: {
					content: [
						{ type: "thinking", thinking: "Attempt to zoom a worker name from inside a worker." },
						{ type: "toolCall", id: "w-worker-zoom-name", name: "zoom", arguments: { id: "worker-1" } },
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "w-icm-worker-post-read-disabled",
				check: (request) => {
					workerNavResults.zoomName = icmLatestResult(request, "zoom");
					const originalGetRetrieval = wRoot.settingsManager.getMemoryRetrievalSettings.bind(
						wRoot.settingsManager,
					);
					let disableScheduled = false;
					wRoot.settingsManager.getMemoryRetrievalSettings = () => {
						const current = originalGetRetrieval();
						if (!disableScheduled) {
							disableScheduled = true;
							queueMicrotask(() => {
								wRoot.settingsManager.getMemoryRetrievalSettings = originalGetRetrieval;
								wRoot.settingsManager.setMemoryRetrievalSettings({
									...originalGetRetrieval(),
									enabled: false,
								});
							});
						}
						return current;
					};
				},
				reply: {
					content: [
						{
							type: "thinking",
							thinking: "Call date(0) while retrieval is disabled mid-read.",
						},
						{ type: "toolCall", id: "w-worker-date-disabled", name: "date", arguments: { id: 0 } },
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "w-icm-worker-report",
				check: (request) => {
					workerNavResults.dateDisabledMidRead = icmLatestResult(request, "date");
					wRoot.settingsManager.setMemoryRetrievalSettings({
						...wRoot.settingsManager.getMemoryRetrievalSettings(),
						enabled: true,
					});
					wWorkerDone.release();
				},
				reply: {
					content: [
						{
							type: "toolCall",
							id: "w-worker-submit",
							name: "submit_report",
							arguments: {
								status: "completed",
								summary: "Observed #2 and #0 in continuous chat.",
							},
						},
					],
					stopReason: "toolUse",
				},
			},
		);
		world.provider.enqueue("worker-c", {
			name: "w-merge-6-2",
			check: (request) => {
				if (!JSON.stringify(request.context.messages).includes("Compaction: merge lines 6+1 and 7+1")) {
					throw new Error("worker-c did not receive the 6+1 and 7+1 parent merge task");
				}
			},
			reply: {
				content: [
					{
						type: "text",
						text: "echo: delegate started worker-1; pi: The ICM reader is started.",
					},
				],
			},
		});
		world.systemOne.enterPhase("w-icm-start", ICM_INTAKE_JUDGMENTS);
		await withDeadline(trace, "w-icm start turn", wRoot.session.prompt("Start the ICM reader worker."));
		await withDeadline(trace, "w-icm worker reported", wWorkerDone.promise);
		await withDeadline(trace, "w-icm handoff woke the root", wWake.promise, 60_000);
		await withDeadline(trace, "w-icm root idle", wRoot.session.waitForForegroundIdle());
		await icmWaitForChatIdle(world, wAgentDir, 10, (records) => records.some((record) => record.kind === "work"));

		// Root zooms the worker's transcript via zoom({ id: "worker-1", page: 0 }).
		// Because worker-1's transcript contains the 4 KiB zoom echo, root's zoom("worker-1") result is > 512 B,
		// so worker-c compacts its echo leaf.
		world.provider.enqueue("worker-c", {
			name: "w-root-zoom-worker-echo-leaf",
			reply: { content: [{ type: "text", text: "echo: worker-1 transcript page 1." }] },
		});
		let rootWorkerLogText = "";
		world.provider.enqueue(
			"root",
			{
				name: "w-root-zoom-worker-call",
				reply: {
					content: [
						{ type: "thinking", thinking: "Inspect worker-1's transcript." },
						{ type: "toolCall", id: "w-root-zoom-worker", name: "zoom", arguments: { id: "worker-1", page: 0 } },
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "w-root-zoom-worker-reply",
				check: (request) => {
					rootWorkerLogText = icmLatestResult(request, "zoom").text;
				},
				reply: {
					content: [{ type: "text", text: "Observed worker-1's transcript." }],
				},
			},
		);
		world.systemOne.enterPhase("w-icm-root-zoom-worker", ICM_INTAKE_JUDGMENTS);
		await withDeadline(trace, "w-icm root zoom worker", wRoot.session.prompt("Zoom worker-1."));
		await icmWaitForChatIdle(world, wAgentDir, 14);

		const wRecords = icmReadContinuousRecords(world, wStore);
		const wWorkRecords = wRecords.filter((record) => record.kind === "work");
		expect(
			{
				workerHasBirthView:
					workerBirthContext.includes("<chat>") &&
					workerBirthContext.includes("2+1|echo: 6 KB worker seed payload."),
				workerTools: workerToolNames.filter((name) => name === "zoom" || name === "date").sort(),
				workerZoomIs4kPaged:
					workerNavResults.zoom2?.isError === false &&
					workerNavResults.zoom2.text.includes("page 1/2") &&
					Buffer.byteLength(workerNavResults.zoom2.text, "utf8") <= 4_500,
				workerDate0Ok:
					workerNavResults.date0?.isError === false && workerNavResults.date0.text === wRecords[0]!.date,
				workerNameRefused: workerNavResults.zoomName?.isError === true,
				workerPostReadFenceBlockedWhenDisabledMidRead:
					workerNavResults.dateDisabledMidRead?.isError === true &&
					/Memory retrieval is disabled/i.test(workerNavResults.dateDisabledMidRead.text),
				workRecordCount: wWorkRecords.length,
				workRecordPrefix: wWorkRecords[0]?.text === "[worker-1] Observed #2 and #0 in continuous chat.",
				rootWorkerLogHasHeader: rootWorkerLogText.startsWith("agent worker-1 page 1"),
				rootWorkerLogHasReply: rootWorkerLogText.includes("Observed #2 and #0 in continuous chat."),
			},
			"worker inherits pinned <chat> birth view, uses 4 KiB zoom + date, blocks delivery when retrieval is disabled mid-read, logs [worker-1] once, and root zooms worker-1",
		).toEqual({
			workerHasBirthView: true,
			workerTools: ["date", "zoom"],
			workerZoomIs4kPaged: true,
			workerDate0Ok: true,
			workerNameRefused: true,
			workerPostReadFenceBlockedWhenDisabledMidRead: true,
			workRecordCount: 1,
			workRecordPrefix: true,
			rootWorkerLogHasHeader: true,
			rootWorkerLogHasReply: true,
		});

		const r4DeclaredPath = projectPath("r4-declared-write.txt");
		const r4UndeclaredPath = projectPath("r4-undeclared-write.txt");
		try {
			const r4Ledger = new ObjectiveMutationLedger();
			const r4Observer = new RepositoryMutationObserver(r4Ledger);
			r4Observer.setWorkEvidenceJournal(createSessionWorkEvidenceJournal(() => wRoot.sessionManager));

			const r4CleanToken = await r4Observer.begin({
				callId: "r4-clean-call",
				objectiveId: "r4-clean-objective",
				cwd: HARNESS_PROJECT_CWD,
				effect: "typed_owned_write",
			});
			world.io.writeFileSync(r4DeclaredPath, "declared content\n");
			await r4Observer.finish({
				token: r4CleanToken,
				declaredOwnedPaths: [r4DeclaredPath],
				operationSucceeded: true,
			});

			const r4UndeclaredToken = await r4Observer.begin({
				callId: "r4-undeclared-call",
				objectiveId: "r4-undeclared-objective",
				cwd: HARNESS_PROJECT_CWD,
				effect: "typed_owned_write",
			});
			world.io.writeFileSync(r4UndeclaredPath, "undeclared content\n");
			await r4Observer.finish({
				token: r4UndeclaredToken,
				declaredOwnedPaths: [r4DeclaredPath],
				operationSucceeded: true,
			});

			expect(
				{
					cleanBlockReason: r4Observer.deliveryBlockReason("r4-clean-objective"),
					cleanProvenPaths: r4Ledger.provenOwnedPaths("r4-clean-objective"),
					undeclaredBlockReason: r4Observer.deliveryBlockReason("r4-undeclared-objective"),
					undeclaredProvenPaths: r4Ledger.provenOwnedPaths("r4-undeclared-objective"),
				},
				"TypedObservationGroup initializes with the production session work-evidence journal before branchAnchor exists and blocks undeclared mutations on completion",
			).toEqual({
				cleanBlockReason: undefined,
				cleanProvenPaths: ["r4-declared-write.txt"],
				undeclaredBlockReason: "shell_mutation_unattributed",
				undeclaredProvenPaths: [],
			});
		} finally {
			world.io.rmSync(r4DeclaredPath, { force: true });
			world.io.rmSync(r4UndeclaredPath, { force: true });
		}

		// Second live root on the same continuous-chat profile is refused by runtime.lease.json while wRoot is open.
		const wSecond = await world.createRootSession("root", {
			agentDir: wAgentDir,
			settings: icmContinuousSettings(),
		});
		await withDeadline(
			trace,
			"w-icm concurrent root blocked by lease",
			wSecond.session.prompt("Attempt concurrent root turn while lease is held."),
		);
		const wSecondLast = wSecond.session.messages.at(-1);
		expect(
			wSecondLast?.role === "assistant"
				? { stopReason: wSecondLast.stopReason, error: wSecondLast.errorMessage }
				: undefined,
			"runtime.lease.json blocks a second live root on the same continuous-chat store",
		).toEqual({
			stopReason: "error",
			error: expect.stringMatching(
				/ICM project chat is unavailable: The ICM chat for this project is owned by pid \d+ on .+ still running\./,
			),
		});
		world.faultMatrix.witness("R27", { control: true });
		// R27: the live owner's lease is captured while it holds the chat, since its disposal removes the file.
		const readLease = (holder: string): { readonly text: string; readonly pid: number; readonly token: string } => {
			const text = world.io.peekFile(wStore.leaseFile);
			if (text === undefined) throw new Error(`the ${holder} holds no runtime.lease.json`);
			return { text, ...(JSON.parse(text) as { readonly pid: number; readonly token: string }) };
		};
		const wLiveOwner = readLease("live ICM owner");
		expect(wLiveOwner.pid, "the live ICM lease names this process").toBe(world.processTable.self);
		expect(await world.disposeSessionInBody(wSecond.session)).toBeUndefined();
		expect(await world.disposeSessionInBody(wRoot.session)).toBeUndefined();
		expect(world.io.existsSync(wStore.leaseFile), "disposing the owner releases runtime.lease.json").toBe(false);
		// The owner process dies with its lease on disk: the captured lease is written back and the process advances, so the
		// recorded owner answers ESRCH. A fresh root on the same store replaces it during its memory activation.
		world.io.writeFileSync(wStore.leaseFile, wLiveOwner.text);
		expect(world.processTable.advanceProcess().previousPid, "the dead process is the recorded lease owner").toBe(
			wLiveOwner.pid,
		);
		const wTakeover = await world.createRootSession("root", {
			agentDir: wAgentDir,
			settings: icmContinuousSettings(),
		});
		const wTakenOwner = readLease("fresh ICM root");
		expect(
			{ pid: wTakenOwner.pid, replaced: wTakenOwner.token !== wLiveOwner.token },
			"a fresh root takes over the runtime lease its dead owner left",
		).toEqual({ pid: world.processTable.self, replaced: true });
		world.faultMatrix.witness("R27", { control: false });
		expect(await world.disposeSessionInBody(wTakeover.session)).toBeUndefined();
		expect(world.io.existsSync(wStore.leaseFile), "disposing the takeover owner releases runtime.lease.json").toBe(
			false,
		);
		trace.mark("root", "icm.worker-and-lease");
	} finally {
		world.io.rmSync(wBigPath, { force: true });
	}
}
