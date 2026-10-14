import "../builtin-install.ts";
import { expect } from "vitest";
import { CONTINUOUS_CHAT_MESSAGE_INDEX_ENTRY_BYTES } from "../../../../src/core/memory/continuous-chat-index.ts";
import { CONTINUOUS_CHAT_SYSTEM_PROMPT } from "../../../../src/core/memory/continuous-chat-prompt.ts";
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
	icmReadContinuousRecords,
	icmWaitForChatIdle,
} from "./shared.ts";

export async function runJourney1ContinuousChatPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// ICM continuous chat (Pi-adaptative-memory): fail-closed summaryModel validation, append-only daily logs + 16-byte index,
	// exact <=512 B leaf vs >512 B model compaction + size-retry loop, 30,000-char tool clipping vs assistant splitting,
	// stable system prompt + <chat> view + Current time injection, and root zoom / date navigation.
	const icmAgentDir = `${world.agentDir}-icm`;
	const icmStore = icmContinuousStore(icmAgentDir);
	world.setModelReasoning("worker-c", true, { xhigh: "xhigh" });

	// I1 (fail-closed validation): missing summaryModel, disallowed external summary egress, and non-xhigh summaryModel each
	// emit a session warning, leave continuous-chat storage untouched, and block provider turns via createBlockedContinuousChatPlanWrapper.
	{
		const missingModel = await world.createRootSession("root", {
			agentDir: `${icmAgentDir}-fail-missing`,
			settings: { memorySystem: "icm" },
		});
		await withDeadline(
			trace,
			"missing summaryModel blocked turn",
			missingModel.session.prompt("Attempt turn without summaryModel."),
		);
		const missingLast = missingModel.session.messages.at(-1);
		expect(
			missingLast?.role === "assistant"
				? { stopReason: missingLast.stopReason, error: missingLast.errorMessage }
				: undefined,
			"missing summaryModel blocks ICM provider requests fail-closed",
		).toEqual({
			stopReason: "error",
			error: expect.stringContaining(
				"ICM project chat is unavailable: The ICM chat needs a cheap model for its compactions, and contextPolicy.memory.history.summaryModel is not set",
			),
		});
		expect(await world.disposeSessionInBody(missingModel.session)).toBeUndefined();

		const missingEgress = await world.createRootSession("root", {
			agentDir: `${icmAgentDir}-fail-egress`,
			settings: {
				memorySystem: "icm",
				contextPolicy: {
					memory: {
						history: {
							summaryModel: "harness-script/worker-c",
							allowExternalSummaryEgress: false,
						},
					},
				},
			},
		});
		await withDeadline(
			trace,
			"missing egress blocked turn",
			missingEgress.session.prompt("Attempt turn without summary egress."),
		);
		const egressLast = missingEgress.session.messages.at(-1);
		expect(
			egressLast?.role === "assistant"
				? { stopReason: egressLast.stopReason, error: egressLast.errorMessage }
				: undefined,
			"remote summaryModel without allowExternalSummaryEgress blocks ICM provider requests",
		).toEqual({
			stopReason: "error",
			error: expect.stringContaining(
				"ICM project chat is unavailable: The ICM chat's summary model harness-script/worker-c is not local, and external summary egress is not allowed",
			),
		});
		expect(await world.disposeSessionInBody(missingEgress.session)).toBeUndefined();

		const noXhigh = await world.createRootSession("root", {
			agentDir: `${icmAgentDir}-fail-xhigh`,
			settings: {
				memorySystem: "icm",
				contextPolicy: {
					memory: {
						history: {
							summaryModel: "harness-script/worker-b",
							allowExternalSummaryEgress: true,
						},
					},
				},
			},
		});
		await withDeadline(
			trace,
			"non-xhigh summaryModel blocked turn",
			noXhigh.session.prompt("Attempt turn with non-xhigh summaryModel."),
		);
		const xhighLast = noXhigh.session.messages.at(-1);
		expect(
			xhighLast?.role === "assistant"
				? { stopReason: xhighLast.stopReason, error: xhighLast.errorMessage }
				: undefined,
			"summaryModel without xhigh thinking blocks ICM provider requests",
		).toEqual({
			stopReason: "error",
			error: expect.stringContaining(
				"ICM project chat is unavailable: The ICM chat's summary model harness-script/worker-b does not support xhigh thinking",
			),
		});
		expect(await world.disposeSessionInBody(noXhigh.session)).toBeUndefined();
		trace.mark("root", "icm.fail-closed");
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
		world.provider.enqueue("worker-c", {
			name: "icm-leaf-9-zoom-raw",
			reply: { content: [{ type: "text", text: "echo: zoom(2, 1) raw clipped source." }] },
		});
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
			},
			"Pi-adaptative-memory persists daily JSONL + 16B index, clips tool output at 30k chars, splits assistant output at 30k chars, and serves zoom/date",
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
		});
		expect(await world.disposeSessionInBody(icmRoot.session), "the ICM root disposes cleanly").toBeUndefined();
		trace.mark("root", "icm.continuous-chat-core");
	} finally {
		world.io.rmSync(icmLongPath, { force: true });
	}
}
