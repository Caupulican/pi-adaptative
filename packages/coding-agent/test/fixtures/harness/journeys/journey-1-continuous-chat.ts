import "../builtin-install.ts";
import { OAuthRefreshRejectedError, registerOAuthProvider, unregisterOAuthProvider } from "@caupulican/pi-ai/oauth";
import { expect } from "vitest";
import { AuthStorage } from "../../../../src/core/auth-storage.ts";
import { CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES } from "../../../../src/core/memory/continuous-chat-index.ts";
import { CONTINUOUS_CHAT_SYSTEM_PROMPT } from "../../../../src/core/memory/continuous-chat-prompt.ts";
import { fail, type ScriptedRequest, type ScriptStep, text } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";

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
	icmReadContinuousNodes,
	icmReadContinuousRecords,
	icmReadScheduler,
	icmWaitForChatIdle,
} from "./shared.ts";

export async function runJourney1ContinuousChatPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// ICM continuous chat (Pi-adaptative-memory): summaryModel refusal that warns without stopping the chat, append-only daily logs + 16-byte index,
	// exact <=512 B leaf vs >512 B model compaction + size-retry loop, 30,000-char tool clipping vs assistant splitting,
	// stable system prompt + <chat> view + Current time injection, and root zoom / date navigation.
	const icmAgentDir = `${world.agentDir}-icm`;
	const icmStore = icmContinuousStore(icmAgentDir);
	world.setModelReasoning("worker-c", true, { xhigh: "xhigh" });

	// I1 (summary-model refusal): a missing summaryModel, a disallowed external summary egress, and a non-xhigh summaryModel each warn
	// once and never stop the chat: the root turn is served, the message is logged, and the model-generated node it needs stays
	// pending without one summary request, because every summary attempt rechecks the settings before it sends anything.
	{
		const refusedSummaryCase = async (
			label: string,
			caseAgentDir: string,
			settings: NonNullable<Parameters<typeof world.createRootSession>[1]>["settings"],
			warning: string,
		): Promise<void> => {
			const warningMark = world.warnings.length;
			const requestMark = world.provider.requests.length;
			const caseStore = icmContinuousStore(caseAgentDir);
			// A persisting session: the chat logs only entries the session has persisted.
			const created = await world.createRootSession("root", {
				agentDir: caseAgentDir,
				sessionManager: world.createSessionManager(caseAgentDir),
				settings,
			});
			world.provider.enqueue("root", text(`${label}-reply`, "Acknowledged."));
			// Turn without a tool: its owner words are settled by a later submission, so this phase scripts no judgment.
			world.systemOne.enterPhase(label, {});
			// A message over 512 B cannot be an exact leaf: it needs a model-generated node.
			await withDeadline(
				trace,
				`${label} turn`,
				created.session.prompt(`Summarize this request. ${"z".repeat(600)}`),
			);
			const last = created.session.messages.at(-1);
			expect(
				last?.role === "assistant"
					? { stopReason: last.stopReason, text: JSON.stringify(last.content) }
					: undefined,
				`${label}: the refused summary settings do not stop the root turn`,
			).toEqual({ stopReason: "stop", text: JSON.stringify([{ type: "text", text: "Acknowledged." }]) });
			// Settled: both messages are logged and the scheduler has seen them, and the one model-generated leaf (the user message,
			// id 0) is blocked by the refusal and not yet due a retry. The other message is an exact leaf and needs no model.
			const settled = (): boolean => {
				const rootRaw = world.io.peekFile(caseStore.rootFile);
				const meta = world.guard.peekSqlite(caseStore.queueDatabase, "SELECT body FROM meta WHERE id = 1");
				const work = world.guard.peekSqlite(
					caseStore.queueDatabase,
					"SELECT level, ordinal, status, retry_after, reason FROM work",
				);
				if (rootRaw === undefined || meta?.length !== 1 || work === undefined) return false;
				const state = JSON.parse(String(meta[0]!.body)) as {
					totalMessages: number;
					nextLeaf: number;
					generation: number;
				};
				const row = work[0];
				return (
					(JSON.parse(rootRaw) as { readonly nextId: number }).nextId === 2 &&
					state.totalMessages === 2 &&
					state.nextLeaf === 2 &&
					work.length === 1 &&
					row?.level === 0 &&
					row.ordinal === 0 &&
					row.status === "blocked" &&
					Number(row.retry_after) >= state.generation &&
					row.reason === warning
				);
			};
			await withDeadline(trace, `${label} refused node settled`, world.io.waitForMutation(settled), 60_000);
			const records = icmReadContinuousRecords(world, caseStore);
			expect(
				records.map((record) => ({ id: record.id, kind: record.kind })),
				`${label}: the turn's two messages are logged`,
			).toEqual([
				{ id: 0, kind: "user" },
				{ id: 1, kind: "pi" },
			]);
			expect(records[0]?.text, `${label}: the over-512-byte request is logged whole`).toContain("z".repeat(600));
			expect(
				icmReadContinuousNodes(world, caseStore).map((node) => [node.level, node.ordinal]),
				`${label}: the exact leaf is published; the model-generated one stays pending`,
			).toEqual([[0, 1]]);
			expect(
				world.provider.requests.slice(requestMark).filter((request) => request.model.id !== "root"),
				`${label}: no summary request is sent while the settings are refused`,
			).toEqual([]);
			expect(
				world.warnings.slice(warningMark).filter((message) => message === warning),
				`${label}: the refusal is reported once`,
			).toEqual([warning]);
			expect(await world.disposeSessionInBody(created.session)).toBeUndefined();
		};
		await refusedSummaryCase(
			"icm-missing-summary-model",
			`${icmAgentDir}-fail-missing`,
			{ memorySystem: "icm" },
			'The ICM chat needs a cheap model for its compactions, and contextPolicy.memory.history.summaryModel is not set: set it to a configured model, for example "<provider>/<model>". If that model is not local, also set contextPolicy.memory.history.allowExternalSummaryEgress to true.',
		);
		await refusedSummaryCase(
			"icm-summary-egress-denied",
			`${icmAgentDir}-fail-egress`,
			{
				memorySystem: "icm",
				contextPolicy: {
					memory: { history: { summaryModel: "harness-script/worker-c", allowExternalSummaryEgress: false } },
				},
			},
			"The ICM chat's summary model harness-script/worker-c is not local, and external summary egress is not allowed: set contextPolicy.memory.history.allowExternalSummaryEgress to true to allow it.",
		);
		await refusedSummaryCase(
			"icm-summary-model-not-xhigh",
			`${icmAgentDir}-fail-xhigh`,
			{
				memorySystem: "icm",
				contextPolicy: {
					memory: { history: { summaryModel: "harness-script/worker-b", allowExternalSummaryEgress: true } },
				},
			},
			'The ICM chat\'s summary model harness-script/worker-b does not support xhigh thinking, which its compactions require: set contextPolicy.memory.history.summaryModel to a reasoning model that supports xhigh, for example "<provider>/<model>".',
		);
		trace.mark("root", "icm.summary-refusal");
	}

	// I2 (continuous chat storage, leaf threshold, model compaction + size retry, and 30,000-char bounds):
	// - Turn 1: user message <= 512 B (id 0, exact leaf), read tool call (id 1, exact leaf; 0+2 merges with 0 worker-c calls),
	//   read result > 30,000 chars (id 2, clipped to <= 30,000 chars with toolClipping metadata; > 512 B so worker-c compacts leaf 2
	//   after a first >512 B reply triggers the "Too long: your line is ..." retry), and a 30,050-char assistant reply that splits
	//   into id 3 (30,000 chars -> worker-c compacts leaf 3; 2+2 and 0+4 merge without extra worker-c calls) and id 4 (50 chars, exact leaf).
	const icmLongPath = projectPath("src", "icm-long-echo.txt");
	const icmLongEcho = `HEAD-MARKER-${"x".repeat(31_000)}-TAIL-MARKER\n`;
	world.io.writeFileSync(icmLongPath, icmLongEcho);
	try {
		const icmRoot = await world.createRootSession("root", {
			agentDir: icmAgentDir,
			sessionManager: world.createSessionManager(icmAgentDir),
			settings: icmContinuousSettings(),
		});
		const splitPiReply = `SPLIT-START-Retry limit is seven per hour-${"p".repeat(29_998)}-SPLIT-END`;
		world.provider.enqueue(
			"worker-c",
			{
				name: "icm-leaf-2-oversized",
				check: (request) => {
					const text = JSON.stringify(request.context.messages);
					if (!text.includes("HEAD-MARKER-") || !text.includes("-TAIL-MARKER")) {
						throw new Error("leaf 2 compaction did not receive the clipped 30,000-char tool output");
					}
				},
				reply: { content: [{ type: "text", text: `echo: ${"oversized-summary-".repeat(35)}` }] },
			},
			{
				name: "icm-leaf-2-retry-accepted",
				check: (request) => {
					const text = JSON.stringify(request.context.messages);
					if (!text.includes("Too long: your line is")) {
						throw new Error("worker-c did not receive the >512 B size-retry prompt");
					}
				},
				reply: {
					content: [
						{
							type: "text",
							text: "echo: HEAD-MARKER..TAIL-MARKER.",
						},
					],
				},
			},
			{
				name: "icm-leaf-3-split-head",
				check: (request) => {
					if (!JSON.stringify(request.context.messages).includes("SPLIT-START-Retry limit is seven per hour")) {
						throw new Error("worker-c did not receive the 30,000-char first chunk of the split assistant reply");
					}
					world.faultMatrix.witness("R10", { control: true });
				},
				reply: { content: [{ type: "text", text: "pi: Retry limit is seven per hour (part 1)." }] },
			},
		);
		let turn1SystemPrompt = "";
		let turn1ToolNames: string[] = [];
		world.provider.enqueue(
			"root",
			{
				name: "icm-turn-1-call",
				check: (request) => {
					turn1SystemPrompt = request.context.systemPrompt ?? "";
					turn1ToolNames = (request.context.tools ?? []).map((tool) => tool.name);
				},
				reply: {
					content: [
						{ type: "thinking", thinking: "Read the long echo fixture." },
						{ type: "toolCall", id: "icm-turn-1-read", name: "read", arguments: { path: icmLongPath } },
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "icm-turn-1-reply",
				reply: {
					content: [{ type: "text", text: splitPiReply }],
				},
			},
		);
		world.systemOne.enterPhase("icm-turn-1", ICM_INTAKE_JUDGMENTS);
		await withDeadline(
			trace,
			"ICM turn 1",
			icmRoot.session.prompt("Record the retry limit decision and read the long echo file."),
		);
		await icmWaitForChatIdle(world, icmAgentDir, 5, (_records, nodes) =>
			nodes.some((node) => node.level === 2 && node.ordinal === 0),
		);
		expect(
			{
				hasPromptBlock: turn1SystemPrompt.includes(CONTINUOUS_CHAT_SYSTEM_PROMPT),
				hasPiReplyLine: turn1SystemPrompt.includes("- pi: Pi's replies"),
				hasCurrentDateInSystemPrompt: turn1SystemPrompt.includes("Current date:"),
				hasZoom: turn1ToolNames.includes("zoom"),
				hasDate: turn1ToolNames.includes("date"),
				hasLegacyMemory: turn1ToolNames.includes("memory"),
				hasLegacyMemorySearch: turn1ToolNames.includes("memory_search"),
			},
			"ICM root exposes the Pi-adaptative-memory system prompt (without Current date:) and only zoom + date tools",
		).toEqual({
			hasPromptBlock: true,
			hasPiReplyLine: true,
			hasCurrentDateInSystemPrompt: false,
			hasZoom: true,
			hasDate: true,
			hasLegacyMemory: false,
			hasLegacyMemorySearch: false,
		});

		// I3 (<chat> view projection + root zoom & date navigation):
		// - Root calls zoom(0, 2) (tree children 0 and 1, <=512 B echo), zoom(2, 1, 0) (raw source of clipped record 2;
		//   30,000 B fits on 1 root page of 32,768 B, and >512 B so worker-c compacts its echo leaf 9), and date(3) (timestamp of Pi's reply).
		let leaf9RetriedOnWorkerC = false;
		world.provider.enqueue(
			"worker-c",
			{
				name: "icm-leaf-9-transient-503",
				reply: {
					stopReason: "error",
					errorMessage: "HTTP 503 Service Unavailable: upstream overloaded",
					content: [],
				},
			},
			{
				name: "icm-leaf-9-zoom-raw",
				check: () => {
					leaf9RetriedOnWorkerC = true;
				},
				reply: { content: [{ type: "text", text: "echo: zoom(2, 1) raw clipped source." }] },
			},
		);
		const icmNavOutputs: Record<string, string> = {};
		let turn2ChatView = "";
		let turn2StateText = "";
		world.provider.enqueue(
			"root",
			{
				name: "icm-turn-2-zoom-tree",
				check: (request) => {
					const raw = JSON.stringify(request.context.messages);
					if (raw.includes("<chat>")) turn2ChatView = raw;
					if (raw.includes("Current time: ")) turn2StateText = raw;
				},
				reply: {
					content: [
						{ type: "thinking", thinking: "Expand 0+2 in the summary tree." },
						{ type: "toolCall", id: "icm-zoom-tree", name: "zoom", arguments: { id: 0, n: 2 } },
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "icm-turn-2-zoom-raw",
				check: (request) => {
					icmNavOutputs.tree = icmLatestResult(request, "zoom").text;
				},
				reply: {
					content: [
						{ type: "thinking", thinking: "Read raw page 0 of message 2." },
						{ type: "toolCall", id: "icm-zoom-raw", name: "zoom", arguments: { id: 2, n: 1, page: 0 } },
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "icm-turn-2-date",
				check: (request) => {
					icmNavOutputs.raw2 = icmLatestResult(request, "zoom").text;
				},
				reply: {
					content: [
						{ type: "thinking", thinking: "Read timestamp of message 3." },
						{ type: "toolCall", id: "icm-date-3", name: "date", arguments: { id: 3 } },
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "icm-turn-2-reply",
				check: (request) => {
					icmNavOutputs.date3 = icmLatestResult(request, "date").text;
				},
				reply: {
					content: [{ type: "text", text: "Observed the summary tree, raw echo, and date." }],
				},
			},
		);
		world.systemOne.enterPhase("icm-turn-2", ICM_INTAKE_JUDGMENTS);
		await withDeadline(trace, "ICM turn 2", icmRoot.session.prompt("Inspect the summary tree, raw echo, and date."));
		await icmWaitForChatIdle(world, icmAgentDir, 13);

		const icmRecords = icmReadContinuousRecords(world, icmStore);
		const icmIdxBytes = Buffer.byteLength(world.io.readFileSync(icmStore.messagesIdx));
		expect(
			{
				recordCount: icmRecords.length,
				indexBytes: icmIdxBytes,
				kindsFirstFive: icmRecords.slice(0, 5).map((record) => record.kind),
				echo2Clipped:
					icmRecords[2]!.text.length <= 30_000 &&
					icmRecords[2]!.toolClipping !== undefined &&
					icmRecords[2]!.text.includes("HEAD-MARKER-") &&
					icmRecords[2]!.text.includes("-TAIL-MARKER"),
				piSplitLengths: [icmRecords[3]!.text.length, icmRecords[4]!.text.length],
				piSplitTail: icmRecords[4]!.text.endsWith("-SPLIT-END"),
				hasChatView:
					turn2ChatView.includes("0+1|user: Record the retry limit decision") &&
					turn2ChatView.includes("3+1|pi: Retry limit is seven per hour (part 1)."),
				hasCurrentTimeState: turn2StateText.includes("Current time: "),
				zoomTreeHasChildren:
					icmNavOutputs.tree?.includes("0+1|user: Record the retry limit decision") &&
					icmNavOutputs.tree?.includes("1+1|tool: read"),
				zoomRawHeader: icmNavOutputs.raw2?.startsWith("message 2 (echo, "),
				zoomRawHasClipBanner: icmNavOutputs.raw2?.includes("tool output clipped:"),
				zoomRawHasMarkers:
					icmNavOutputs.raw2?.includes("HEAD-MARKER-") && icmNavOutputs.raw2?.includes("-TAIL-MARKER"),
				date3MatchesRecord: icmNavOutputs.date3 === icmRecords[3]!.date,
				leaf9RetriedOnWorkerC,
			},
			"Pi-adaptative-memory persists daily JSONL + 16B index, clips tool output at 30k chars, splits assistant output at 30k chars, retries transient compaction errors without blacklisting the model, and serves zoom/date",
		).toEqual({
			recordCount: 13,
			indexBytes: 13 * CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES,
			kindsFirstFive: ["user", "tool", "echo", "pi", "pi"],
			echo2Clipped: true,
			piSplitLengths: [30_000, splitPiReply.length - 30_000],
			piSplitTail: true,
			hasChatView: true,
			hasCurrentTimeState: true,
			zoomTreeHasChildren: true,
			zoomRawHeader: true,
			zoomRawHasClipBanner: true,
			zoomRawHasMarkers: true,
			date3MatchesRecord: true,
			leaf9RetriedOnWorkerC: true,
		});
		world.faultMatrix.witness("R10", { control: false });
		expect(await world.disposeSessionInBody(icmRoot.session), "the ICM root disposes cleanly").toBeUndefined();
		await verifyTurnRetrySpacing(world, `${icmAgentDir}-r10s`);

		const r5ProviderId = "r5-oauth-401";
		const r5AuthPath = `${icmAgentDir}-r5-auth.json`;
		let r5RefreshAttempts = 0;
		registerOAuthProvider({
			id: r5ProviderId,
			name: "R5 OAuth 401 Recovery",
			login: async () => {
				throw new Error("unused");
			},
			refreshToken: async () => {
				r5RefreshAttempts += 1;
				throw new OAuthRefreshRejectedError(r5ProviderId, "revoked", "invalid_grant");
			},
			getApiKey: (cred) => cred.access,
		});
		try {
			const r5AuthFirst = AuthStorage.create(r5AuthPath);
			r5AuthFirst.set(r5ProviderId, {
				type: "oauth",
				access: "r5-rejected-access",
				refresh: "r5-refused-refresh",
				expires: Date.now() + 60_000,
			});
			const r5FirstRecovery = await r5AuthFirst.recoverRejectedOAuthApiKey(r5ProviderId, "r5-rejected-access");
			const r5AuthReloaded = AuthStorage.create(r5AuthPath);
			const r5PersistedCred = r5AuthReloaded.get(r5ProviderId);
			const r5SecondRecovery = await r5AuthReloaded.recoverRejectedOAuthApiKey(r5ProviderId, "r5-rejected-access");
			expect(
				{
					r5FirstRecovery,
					r5SecondRecovery,
					r5RefreshAttempts,
					persistedRefreshRefused: r5PersistedCred?.type === "oauth" ? r5PersistedCred.refreshRefused : undefined,
				},
				"401 OAuth access-token recovery persists refreshRefused to disk so a restarted AuthStorage never retries the refused refresh token",
			).toEqual({
				r5FirstRecovery: undefined,
				r5SecondRecovery: undefined,
				r5RefreshAttempts: 1,
				persistedRefreshRefused: true,
			});
		} finally {
			unregisterOAuthProvider(r5ProviderId);
			world.io.rmSync(r5AuthPath, { force: true });
		}

		trace.mark("root", "icm.continuous-chat-core");
	} finally {
		world.io.rmSync(icmLongPath, { force: true });
	}
}

/** The scripted outage every failed attempt of the R10s leaf meets. */
const R10S_UNAVAILABLE = "HTTP 503 Service Unavailable: upstream overloaded";
/** How the adapter fails the leaf once both of an attempt's requests met the outage. */
const R10S_STOPPED = `Continuous-chat compaction stopped (error): ${R10S_UNAVAILABLE}`;

/**
 * R10s: a turn waiting on a failed leaf retries it on its own alarm, 1 s then 2 s, on a fresh chat whose only leaf
 * that needs the summary model is message 1. Each attempt of that leaf costs two worker-c requests: the adapter sends
 * once more at once after an error reply. The control: the same failure with no waiting turn arms nothing. Each alarm
 * is also advanced to 1 ms before its delay first, where it must not fire.
 */
async function verifyTurnRetrySpacing(world: HarnessWorld, agentDir: string): Promise<void> {
	const trace = world.trace;
	const label = "r10s";
	const failedLine = `Continuous-chat compaction 1+1 failed: ${R10S_STOPPED}`;
	const longReply = `R10S-SPACING-${"s".repeat(600)}`;
	const leafTask = (request: ScriptedRequest): void => {
		if (!JSON.stringify(request.context.messages).includes("R10S-SPACING-")) {
			throw new Error("worker-c did not receive the R10s leaf task");
		}
	};
	const unavailable = (name: string): ScriptStep => ({
		...fail(`${label}-${name}`, R10S_UNAVAILABLE),
		check: leafTask,
	});
	const workerSteps = (mark: number): string[] =>
		world.provider.reached.slice(mark).filter((step) => step.startsWith("worker-c:"));
	const root = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: icmContinuousSettings(),
	});
	const store = icmContinuousStore(agentDir);

	// Turn A logs message 0 (an exact leaf) and message 1, whose leaf fails with no turn waiting on it.
	const warningMark = world.warnings.length;
	const reachedMark = world.provider.reached.length;
	world.provider.enqueue("worker-c", unavailable("idle-a"), unavailable("idle-b"));
	world.provider.enqueue("root", {
		name: `${label}-turn-a`,
		reply: { content: [{ type: "text", text: longReply }] },
	});
	// Turn A uses no tool, so its owner words are settled by the next submission: the carries_0 screen and the owner-policy classification are scripted on turn B.
	world.systemOne.enterPhase(`${label}-turn-a`, {});
	await withDeadline(trace, "R10s turn A", root.session.prompt("Record the R10s spacing reply."));
	await withDeadline(
		trace,
		"R10s leaf 1 blocked",
		world.io.waitForMutation(() => {
			const queue = icmReadScheduler(world, store);
			return queue !== undefined && queue.running === 0 && queue.readyLeaves === 0 && queue.blocked === 1;
		}),
		60_000,
	);
	expect(
		{
			armed: world.timers.armedDelays("continuous-chat"),
			steps: workerSteps(reachedMark),
			warnings: world.warnings.slice(warningMark),
		},
		"a leaf that fails with no turn waiting arms no retry alarm",
	).toEqual({
		armed: [],
		steps: [`worker-c:${label}-idle-a`, `worker-c:${label}-idle-b`],
		warnings: [failedLine],
	});
	world.faultMatrix.witness("R10s", { control: true });

	// Turn B waits on leaf 1: its arrival retries the leaf, then each failure arms the next alarm until one succeeds.
	const turnMark = world.provider.reached.length;
	world.provider.enqueue(
		"worker-c",
		unavailable("arrival-a"),
		unavailable("arrival-b"),
		unavailable("first-alarm-a"),
		unavailable("first-alarm-b"),
		{
			name: `${label}-second-alarm`,
			check: leafTask,
			reply: { content: [{ type: "text", text: "pi: R10s spacing reply." }] },
		},
	);
	world.provider.enqueue("root", { name: `${label}-turn-b`, reply: { content: [{ type: "text", text: "Done." }] } });
	const waits: string[] = [];
	const unsubscribe = root.session.subscribe((event) => {
		if (event.type === "continuous_chat_prefix_wait") {
			waits.push(`${event.phase} ${event.built}/${event.needed}/${event.failed}`);
		}
	});
	let settled = false;
	world.systemOne.enterPhase(`${label}-turn-b`, {
		...ICM_INTAKE_JUDGMENTS,
		carries_0: { kind: "noul", probability: 0.02 },
	});
	const turnB = root.session.prompt("Answer after the R10s retries.").finally(() => {
		settled = true;
	});
	const firstDelay = await withDeadline(trace, "R10s first alarm", world.timers.whenArmed("continuous-chat"));
	const firstEarly = world.timers.advance("continuous-chat", firstDelay - 1);
	const secondArm = world.timers.nextArmed("continuous-chat");
	const firstFired = world.timers.advance("continuous-chat", 1);
	const secondDelay = await withDeadline(trace, "R10s second alarm", secondArm);
	const secondEarly = world.timers.advance("continuous-chat", secondDelay - 1);
	const settledBeforeLastAlarm = settled;
	const secondFired = world.timers.advance("continuous-chat", 1);
	await withDeadline(trace, "R10s turn B", turnB);
	unsubscribe();
	await icmWaitForChatIdle(world, agentDir, 4);
	expect(
		{
			delays: [firstDelay, secondDelay],
			fired: [firstEarly, firstFired, secondEarly, secondFired],
			settledBeforeLastAlarm,
			armed: world.timers.armedDelays("continuous-chat"),
			firstWait: waits[0],
			lastWait: waits.at(-1),
			ends: waits.filter((wait) => wait.startsWith("end ")).length,
			steps: workerSteps(turnMark),
			warnings: world.warnings.slice(warningMark),
		},
		"the waiting turn retries its failed leaf after 1 s, then 2 s, and its third attempt opens the turn",
	).toEqual({
		delays: [1_000, 2_000],
		fired: [0, 1, 0, 1],
		settledBeforeLastAlarm: false,
		armed: [],
		firstWait: "start 0/1/0",
		lastWait: "end 1/1/0",
		ends: 1,
		steps: [
			`worker-c:${label}-arrival-a`,
			`worker-c:${label}-arrival-b`,
			`worker-c:${label}-first-alarm-a`,
			`worker-c:${label}-first-alarm-b`,
			`worker-c:${label}-second-alarm`,
		],
		warnings: [failedLine, failedLine, failedLine],
	});
	world.faultMatrix.witness("R10s", { control: false });
	expect(await world.disposeSessionInBody(root.session), "the R10s root disposes cleanly").toBeUndefined();
	trace.mark("root", "icm.r10s-turn-retry-spacing");
}
