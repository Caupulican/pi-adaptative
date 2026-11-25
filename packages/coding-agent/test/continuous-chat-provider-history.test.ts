import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	type Context,
	createEmptyUsage,
	type Model,
	type UserMessage,
} from "@caupulican/pi-ai";
import { observeHistoryWork, providerMessagePrefix, responsesInputPrefix } from "@caupulican/pi-ai/history-work";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../../ai/src/providers/openai-responses-shared.ts";
import { BACKGROUND_TOOL_COMPLETION_TYPE } from "../src/core/background-tool-handoff-text.ts";
import {
	type PathAliasLegendEntry,
	renderPathAliasLegend,
	renderPathAliasLegendFrame,
} from "../src/core/comms/host-injection-records.ts";
import {
	liveWorkerHandoffOf,
	recordLiveWorkerHandoff,
	recordLiveWorkerReport,
} from "../src/core/delegation/worker-handoff-provenance.ts";
import { normalizeContinuousChatAppend } from "../src/core/memory/continuous-chat-contracts.ts";
import {
	CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE,
	ContinuousChatIngestor,
} from "../src/core/memory/continuous-chat-ingest.ts";
import { ContinuousChatMessageDependencies } from "../src/core/memory/continuous-chat-message-dependencies.ts";
import {
	continuousChatRequestHistory,
	createContinuousChatPlanWrapper,
} from "../src/core/memory/continuous-chat-projection.ts";
import type { ProviderHistoryContinuation } from "../src/core/memory/continuous-chat-provider-history.ts";
import { IcmTurnCoordinator } from "../src/core/memory/continuous-chat-turn-coordinator.ts";
import {
	clearedDiscoveredSkillText,
	DISCOVERED_SKILL_RECORD_KIND,
	DISCOVERED_SKILL_RECORD_KIND_PREFIX,
	discoveredSkillDigest,
} from "../src/core/skill-header-record.ts";
import type { AgentContext, AgentLoopConfig } from "../src/kernel/loop-config.ts";
import { advanceMessageContentRevision, immutableHistoryMessage } from "../src/kernel/message-revision.ts";
import { convertToLlm, createCustomMessage } from "../src/kernel/messages.ts";
import { startPlannedAgentProviderRequestWithId } from "../src/kernel/provider-request-planner.ts";
import type { SessionEntry } from "../src/kernel/session/session-entries.ts";
import {
	HOST_REQUEST_ONLY_DETAILS,
	HOST_TRANSIENT_CLEARED_DETAILS,
	transientRecordMessageOf,
} from "../src/kernel/transient-records.ts";
import type { AgentMessage } from "../src/kernel/types.ts";

const model: Model<Api> = {
	id: "native",
	name: "Native",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function aliasLegend(entries: readonly PathAliasLegendEntry[], frame: boolean) {
	const record = { v: 1 as const, k: "path_alias_legend" as const, entries, ...(frame ? {} : { paused: false }) };
	return createCustomMessage(
		record.k,
		frame ? renderPathAliasLegendFrame(entries) : renderPathAliasLegend(record),
		false,
		{ cumulative: true, record },
		new Date(0).toISOString(),
	);
}

function fixture(certified = false) {
	const frameRecords: AgentMessage[] = [];
	const transient: AgentMessage[] = [];
	const aliases = new Map<string, string>();
	const knowledgeRanges: Array<{ start: number; count: number } | undefined> = [];
	const cache = { authority: "project", stablePrefixLineCount: 0, lines: [] };
	const view = "<chat>\n</chat>";
	const controls = {
		covered: true,
		continuation: {} as ProviderHistoryContinuation,
		handoff: undefined as AgentMessage | undefined,
		handoffValid: true,
		handoffRead: undefined as ((message: AgentMessage) => boolean) | undefined,
		terminalReceipt: undefined as ((message: AgentMessage) => readonly string[] | undefined) | undefined,
		beforeObserve: () => {},
		budget: 48_000,
		knowledge: "current fact",
		totalMessages: 0,
		transform: async (messages: AgentMessage[]) =>
			certified ? messages.map((message) => immutableHistoryMessage(message)!) : messages,
	};
	const turns = new IcmTurnCoordinator({
		started: Promise.resolve(),
		ingestor: { flush: async () => {}, settled: async () => {} },
		runtime: {
			reserveTurnBoundary: async () => ({
				view,
				viewCache: cache,
				birthView: view,
				birthViewCache: cache,
				boundaryId: 0,
				totalMessages: controls.totalMessages,
				viewRevision: 0,
				visibility: { key: "project", isCurrent: () => true },
				release() {},
			}),
		},
	});
	const source: AgentContext = { systemPrompt: "Help the owner.", messages: [], tools: [] };
	const project = createContinuousChatPlanWrapper({
		current: () => {
			const handle = turns.current();
			return handle && { handle, stateText: `time of turn ${handle.turnId}` };
		},
		proveContinuation: () => (controls.covered ? controls.continuation : undefined),
		readLiveHandoffAttempts: (message) =>
			controls.handoffValid && (controls.handoffRead?.(message) ?? controls.handoff === message)
				? ["attempt"]
				: undefined,
		readLiveTerminalReceipt: (message) => controls.terminalReceipt?.(message),
		allowsHistoryTokens: (_model, tokens) => tokens <= controls.budget,
	});
	const config: AgentLoopConfig = {
		model,
		convertToLlm,
		providerAccountKey: "first",
		providerMessageProjectionOwner: certified ? {} : undefined,
		onProviderRequestSnapshot: (snapshot) => {
			knowledgeRanges.push(snapshot.requestOnlyMessageRange);
		},
		planContext: project(async ({ messages }) => ({
			messages: await controls.transform(messages),
			carriedRecords: frameRecords.slice(),
			verifyPathAliases: (entries) => entries.every(({ id, path }) => aliases.get(id) === path),
			transientMessages: [
				...transient,
				createCustomMessage(
					"knowledge_context",
					controls.knowledge,
					false,
					HOST_REQUEST_ONLY_DETAILS,
					new Date(0).toISOString(),
				),
			],
		})),
	};
	const wires: Context[] = [];
	const inputs: ReturnType<typeof convertResponsesMessages>[] = [];
	async function begin(text: string | AgentMessage) {
		const previous = turns.current();
		if (previous) turns.end(previous);
		const handle = await turns.begin();
		const user: AgentMessage =
			typeof text === "string" ? { role: "user", content: text, timestamp: handle.turnId } : text;
		source.messages.push(user);
		handle.markStart(user);
		return handle;
	}
	async function send(content: AssistantMessage["content"] = [{ type: "text", text: "Done." }]) {
		const started = await startPlannedAgentProviderRequestWithId(source, config, undefined, (_model, context) => {
			wires.push(context);
			if (certified) {
				inputs.push(
					convertResponsesMessages(model, context, new Set([model.provider]), { reuseAcceptedPrefix: true }),
				);
			}
			const stream = new AssistantMessageEventStream();
			const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				responseId: `response-${wires.length}`,
				content,
				stopReason,
				timestamp: wires.length,
				usage: createEmptyUsage(),
			};
			stream.push({ type: "done", reason: stopReason, message });
			return stream;
		});
		const provider = await started.stream.result();
		const final = { ...provider, streamEndAt: 42 };
		controls.beforeObserve();
		started.observeAssistant?.(provider, final);
		source.messages.push(final);
		return provider;
	}
	return {
		begin,
		send,
		config,
		controls,
		turns,
		source,
		wires,
		inputs,
		frameRecords,
		transient,
		aliases,
		knowledgeRanges,
	};
}

describe("continuous chat at the native provider boundary", () => {
	it("keeps an owner prefix beyond the former token and row ceilings when it fits the active budget", async () => {
		const f = fixture(true);
		f.controls.budget = 90_000;
		await f.begin(`Inspect this evidence:\n${"data ".repeat(42_000)}`);
		const calls = Array.from({ length: 130 }, (_, index) => ({
			type: "toolCall" as const,
			name: "bash",
			id: `tool-${index}`,
			arguments: {},
		}));
		await f.send(calls);
		for (const call of calls)
			f.source.messages.push({
				role: "toolResult",
				toolName: call.name,
				toolCallId: call.id,
				isError: false,
				content: [{ type: "text", text: "checked" }],
				timestamp: 10,
			});
		await f.send();
		const previous = f.wires.at(-1)!.messages;
		expect(previous.length).toBeGreaterThan(128);
		await f.begin("Continue using that evidence.");
		await f.send();
		expect(f.wires.at(-1)!.messages.slice(0, previous.length)).toEqual(previous);
	});

	it.each(["current", "edited", "replayed", "revoked"] as const)(
		"checks exact background terminal custody before reusing a prefix (%s)",
		async (scenario) => {
			const f = fixture();
			await f.begin("Start a background check.");
			await f.send();
			const previous = f.wires[0]!.messages;
			const receipt = (time: number) =>
				createCustomMessage(
					BACKGROUND_TOOL_COMPLETION_TYPE,
					"The background check finished.",
					true,
					{},
					new Date(time).toISOString(),
				);
			const first = receipt(3);
			const replay = receipt(4);
			let valid = true;
			f.controls.terminalReceipt = (message) =>
				valid && (message === first || message === replay) ? ["call"] : undefined;
			if (scenario === "edited")
				f.controls.transform = async (messages) => [{ ...first, content: "Changed result." }, ...messages.slice(1)];
			await f.begin(first);
			await f.send();
			const accepted = f.wires[1]!.messages;
			if (scenario === "edited") {
				expect(JSON.stringify(accepted)).not.toContain("Start a background check.");
				return;
			}
			expect(accepted.slice(0, previous.length)).toEqual(previous);
			valid = scenario !== "revoked";
			await f.begin(scenario === "replayed" ? replay : "Summarize the check.");
			await f.send();
			const next = f.wires[2]!.messages;
			if (scenario === "current") expect(next.slice(0, accepted.length)).toEqual(accepted);
			else expect(JSON.stringify(next)).not.toContain("Start a background check.");
		},
	);

	it.each(["unchanged", "cleared on wire", "revoked between turns", "authority changed"] as const)(
		"retains a learned skill header without moving its accepted wire record when %s",
		async (variant) => {
			const f = fixture(true);
			const name = "plot-review";
			const kind = `${DISCOVERED_SKILL_RECORD_KIND_PREFIX}1`;
			const text = `DISCOVERED SKILL [1] "${name}"\nGuidance for reviewing plots.`;
			const sourceId = "chart-header-source";
			const authority = (scope: string) =>
				createCustomMessage(
					"authority_context",
					`Current scope ${scope}`,
					false,
					undefined,
					new Date(0).toISOString(),
				);
			if (variant === "authority changed") f.frameRecords.push(authority("original"));
			const discovered = createCustomMessage(
				kind,
				text,
				false,
				{
					record: { v: 1, k: DISCOVERED_SKILL_RECORD_KIND, name, sourceId, order: 1 },
					digest: discoveredSkillDigest(text, sourceId, 1),
				},
				new Date(0).toISOString(),
			);

			await f.begin("Assess this plot.");
			await f.send([
				{ type: "toolCall", name: "skill", id: "search", arguments: { action: "search", query: "review plots" } },
			]);
			f.source.messages.push({
				role: "toolResult",
				toolName: "skill",
				toolCallId: "search",
				isError: false,
				content: [{ type: "text", text: `skill search: ${name}` }],
				timestamp: 9,
			});
			f.transient.push(discovered);
			await f.send(
				variant === "cleared on wire"
					? [
							{
								type: "toolCall",
								name: "skill",
								id: "exclude",
								arguments: { action: "exclude", name, reason: "Owner excluded it" },
							},
						]
					: undefined,
			);
			if (variant === "cleared on wire") {
				f.source.messages.push({
					role: "toolResult",
					toolName: "skill",
					toolCallId: "exclude",
					isError: false,
					content: [{ type: "text", text: "skill excluded" }],
					timestamp: 10,
				});
				f.transient.splice(
					0,
					1,
					createCustomMessage(
						kind,
						clearedDiscoveredSkillText("1"),
						false,
						HOST_TRANSIENT_CLEARED_DETAILS,
						new Date(0).toISOString(),
					),
				);
				await f.send();
			}
			const previous = f.wires.at(-1)!.messages;
			const previousInput = f.inputs.at(-1)!;
			if (variant === "authority changed") f.frameRecords[0] = authority("changed");
			if (variant === "unchanged" || variant === "authority changed")
				f.frameRecords.push(transientRecordMessageOf(discovered)!);
			else f.transient.length = 0;
			await f.begin("Follow up on that review.");
			await f.send();
			const next = f.wires.at(-1)!.messages;
			if (variant === "revoked between turns" || variant === "authority changed") {
				expect(providerMessagePrefix(next)?.count).toBe(0);
				const wire = JSON.stringify(next);
				expect(wire).not.toContain("Done.");
				if (variant === "revoked between turns") expect(wire).not.toContain("Guidance for reviewing plots.");
				else {
					expect(wire).toContain("Current scope changed");
					expect(wire).not.toContain("Current scope original");
				}
				return;
			}
			expect(providerMessagePrefix(next)?.previous).toBe(previous);
			expect(providerMessagePrefix(next)?.count).toBe(previous.length);
			expect(responsesInputPrefix(f.inputs.at(-1)!)?.previous).toBe(previousInput);
			expect(JSON.stringify(next).match(/Guidance for reviewing plots\./g)).toHaveLength(1);
		},
	);

	it("bridges the exact dispatched tool history into the next Responses conversion", async () => {
		const f = fixture(true);
		await f.begin("Inspect the build.");
		await f.send([{ type: "toolCall", name: "bash", id: "build", arguments: {} }]);
		f.source.messages.push({
			role: "toolResult",
			toolName: "bash",
			toolCallId: "build",
			isError: false,
			content: [{ type: "text", text: "First failing check" }],
			timestamp: 9,
		});
		await f.send();
		const previous = f.wires[1]!.messages;
		const previousInput = f.inputs[1]!;
		expect(providerMessagePrefix(previous)).toBeDefined();

		await f.begin("Explain the failure.");
		const work = observeHistoryWork(f.source.messages);
		await f.send();
		const continued = f.wires[2]!.messages;
		const input = f.inputs[2]!;
		expect(providerMessagePrefix(continued)?.previous).toBe(previous);
		expect(providerMessagePrefix(continued)?.count).toBe(previous.length);
		expect(responsesInputPrefix(input)?.previous).toBe(previousInput);
		expect(responsesInputPrefix(input)?.count).toBe(previousInput.length);
		expect(input[0]).toBe(previousInput[0]);
		expect(work.providerRowsConverted).toBeLessThan(continued.length);
	});

	it("extends the previously dispatched tool request through two owner turns and preserves live fact placement", async () => {
		const f = fixture();
		await f.begin("Inspect the build.");
		await f.send([{ type: "toolCall", name: "bash", id: "build", arguments: {} }]);
		const tool = {
			role: "toolResult" as const,
			toolName: "bash",
			toolCallId: "build",
			isError: false,
			content: [{ type: "text" as const, text: "3 failures in 900 lines" }],
			timestamp: 8,
		};
		f.source.messages.push(tool);
		const reply = await f.send();
		const visited = JSON.stringify(f.wires[1]!.messages);
		f.controls.totalMessages = 4;
		await f.begin("Explain the first failure.");
		const second = await f.send();
		const next = f.wires[2]!.messages;
		expect(JSON.stringify(next.slice(0, f.wires[1]!.messages.length))).toBe(visited);
		expect(next.slice(-3)).toEqual([
			reply,
			expect.objectContaining({
				content: [
					{ type: "text", text: "time of turn 2" },
					{ type: "text", text: "Previous turn: chat IDs 0 through 3." },
				],
			}),
			expect.objectContaining({ content: "Explain the first failure." }),
		]);
		expect(next.filter((m) => JSON.stringify(m).includes("current fact"))).toHaveLength(1);
		expect(
			continuousChatRequestHistory({ wire: { kind: "chat" }, host: { turns: f.turns } }, f.source.messages),
		).toContainEqual(tool);
		await f.begin("Continue.");
		await f.send();
		expect(f.wires[3]!.messages.slice(0, next.length + 1)).toEqual([...next, second]);
	});

	it.each(["unchanged", "edited body", "replaced message"] as const)(
		"carries one worker handoff and its report rows only when its exact opening stays on the wire (%s)",
		async (variant) => {
			const f = fixture();
			await f.begin("Start the worker.");
			const previous = await f.send();
			const work = "Background work [Builder], chat ID 2: zoom({id:2,n:1,page:0})";
			const handoff = createCustomMessage(
				"background-worker-completion",
				"Worker finished.",
				true,
				{},
				new Date(3).toISOString(),
			);
			f.controls.continuation = { work: { text: work, isCurrent: () => true } };
			f.controls.handoff = handoff;
			f.controls.totalMessages = 3;
			if (variant !== "unchanged")
				f.controls.transform = async (messages) => [
					variant === "edited body" ? { ...handoff, content: "Edited body." } : { ...handoff, details: {} },
					...messages.slice(1),
				];
			await f.begin(handoff);
			await f.send([{ type: "toolCall", name: "bash", id: "inspect", arguments: {} }]);
			f.source.messages.push({
				role: "toolResult",
				toolName: "bash",
				toolCallId: "inspect",
				isError: false,
				content: [{ type: "text", text: "Worker evidence." }],
				timestamp: 4,
			});
			await f.send();
			for (const request of f.wires.slice(1)) {
				const text = JSON.stringify(request.messages);
				if (variant !== "unchanged") {
					expect(text).not.toContain("Start the worker.");
					expect(text).not.toContain(work);
				} else {
					expect(request.messages.slice(0, f.wires[0]!.messages.length + 1)).toEqual([
						...f.wires[0]!.messages,
						previous,
					]);
					expect(text.split(work)).toHaveLength(2);
					expect(text.split("Worker finished.")).toHaveLength(2);
				}
			}
		},
	);

	it.each(["handoff", "report", "report before assistant"] as const)(
		"opens a fresh window when retained %s evidence expires",
		async (revoked) => {
			const f = fixture();
			await f.begin("Start the worker.");
			await f.send();
			const work = "Pinned worker report.";
			let reportCurrent = true;
			const handoff = createCustomMessage(
				"background-worker-completion",
				"Worker finished.",
				true,
				{},
				new Date(3).toISOString(),
			);
			f.controls.continuation = { work: { text: work, isCurrent: () => reportCurrent } };
			f.controls.handoff = handoff;
			f.controls.totalMessages = 3;
			if (revoked === "report before assistant")
				f.controls.beforeObserve = () => {
					reportCurrent = false;
				};
			await f.begin(handoff);
			await f.send();
			expect(JSON.stringify(f.wires[1]?.messages)).toContain(work);
			f.controls.continuation = {};
			if (revoked === "report before assistant") {
				reportCurrent = true;
			} else {
				await f.begin("First follow-up.");
				await f.send();
				expect(JSON.stringify(f.wires[2]?.messages)).toContain(work);
				if (revoked === "handoff") f.controls.handoffValid = false;
				else reportCurrent = false;
			}
			await f.begin("Fresh follow-up.");
			await f.send();
			const wire = JSON.stringify(f.wires.at(-1)?.messages);
			expect(wire).toContain("Fresh follow-up.");
			expect(wire).not.toContain(work);
			expect(wire).not.toContain("Worker finished.");
		},
	);

	it.each([false, true])(
		"starts fresh on another handoff for the same attempt (previous prefix retained: %s)",
		async (retained) => {
			const f = fixture();
			if (retained) {
				await f.begin("Start the worker.");
				await f.send();
			}
			const first = createCustomMessage(
				"background-worker-completion",
				"Initial handoff.",
				true,
				{},
				new Date(2).toISOString(),
			);
			const replay = createCustomMessage(
				"background-worker-completion",
				"Replayed handoff.",
				true,
				{},
				new Date(3).toISOString(),
			);
			// Keep both inputs provable; a replay has fresh object identity but the same exact attempt.
			f.controls.handoff = first;
			f.controls.handoffRead = (message) => message === first || message === replay;
			await f.begin(first);
			await f.send();
			if (retained) expect(JSON.stringify(f.wires[1]?.messages)).toContain("Start the worker.");
			await f.begin(replay);
			await f.send();
			const wire = JSON.stringify(f.wires.at(-1)?.messages);
			expect(wire).toContain("Replayed handoff.");
			expect(wire).not.toContain("Initial handoff.");
			expect(wire).not.toContain("Start the worker.");
		},
	);

	it("ignores revisions outside the window and drops the window after an older dependency changes", async () => {
		const f = fixture();
		await f.begin("First original");
		await f.send();
		const first = f.source.messages[0] as UserMessage;
		const elsewhere: UserMessage = { role: "user", content: "Unrelated session", timestamp: 0 };
		advanceMessageContentRevision(elsewhere);
		await f.begin("Second input");
		await f.send();
		expect(JSON.stringify(f.wires[1]!.messages)).toContain("First original");

		first.content = "First corrected";
		advanceMessageContentRevision(first);
		await f.begin("Third input");
		await f.send();
		const third = JSON.stringify(f.wires[2]!.messages);
		expect(third).toContain("Third input");
		expect(third).not.toContain("First corrected");
		expect(third).not.toContain("Second input");
	});

	it("replans a derived message after its durable source changes across asynchronous planning", async () => {
		const f = fixture();
		await f.begin("Original text");
		let mutate = true;
		f.controls.transform = async (messages) => {
			const source = messages[0] as UserMessage;
			const clone = { ...source, content: `derived: ${source.content}` };
			if (mutate) {
				mutate = false;
				await Promise.resolve();
				source.content = "Corrected text";
				advanceMessageContentRevision(source);
			}
			return [clone];
		};
		await f.send();
		expect(f.wires).toHaveLength(1);
		expect(JSON.stringify(f.wires[0]!.messages)).toContain("derived: Corrected text");
		expect(JSON.stringify(f.wires[0]!.messages)).not.toContain("Original text");
	});

	it.each(["fresh wire", "retained terminal", "unrelated edit"] as const)(
		"checks %s at dispatch, after the accepted request snapshot",
		async (risk) => {
			const f = fixture();
			await f.begin("First input");
			const prior = risk === "retained terminal" ? await f.send() : undefined;
			if (prior) await f.begin("Second input");
			f.config.onProviderRequestSnapshot = ({ context }) => {
				if (risk === "unrelated edit") {
					advanceMessageContentRevision({ role: "user", content: "Not visible", timestamp: 0 });
				} else {
					// The earlier provider assistant and today's wire can have different objects than their durable anchors.
					advanceMessageContentRevision(prior ?? context.messages.at(-1)!);
				}
			};
			const response = await f.send();
			expect(response.stopReason).toBe(risk === "unrelated edit" ? "stop" : "error");
			expect(f.wires).toHaveLength(risk === "fresh wire" ? 0 : 1);
		},
	);

	it("keeps accepted alias deltas in place when the next frame introduces more mappings", async () => {
		const f = fixture();
		const first = { id: "p/old", path: "/workspace/old/file.ts" };
		const next = { id: "p/new", path: "/workspace/new/file.ts" };
		f.aliases.set(first.id, first.path);
		f.transient.push(aliasLegend([first], false));
		await f.begin("Explain p/old");
		await f.send();
		const initial = f.wires[0]!.messages;
		f.transient.length = 0;
		f.aliases.set(next.id, next.path);
		f.frameRecords.push(aliasLegend([first, next], true));
		await f.begin("Inspect p/new");
		await f.send();
		const extended = f.wires[1]!.messages;
		expect(extended.slice(0, initial.length)).toEqual(initial);
		const suffix = JSON.stringify(extended.slice(initial.length));
		expect(suffix).toContain(next.path);
		expect(suffix).not.toContain(first.path);
		expect(f.knowledgeRanges[1]).toEqual(f.knowledgeRanges[0]);
		const range = f.knowledgeRanges[1]!;
		expect(JSON.stringify(extended.slice(range.start, range.start + range.count))).toContain("current fact");

		f.aliases.set(first.id, "/elsewhere");
		f.frameRecords.length = 0;
		await f.begin("Use current mappings");
		await f.send();
		expect(JSON.stringify(f.wires[2]!.messages)).not.toContain(first.path);
	});

	it("drops optional history when admission asks for a replan and commits only the fresh request", async () => {
		const f = fixture();
		await f.begin("Old input");
		await f.send();
		await f.begin("Current input");
		const proposals: Context[] = [];
		f.config.admitProviderRequest = async ({ context, sourceContext, attempt }) => {
			proposals.push(context);
			return attempt === 0 ? { action: "replan", context: sourceContext } : { action: "send" };
		};
		await f.send();
		expect(proposals).toHaveLength(2);
		expect(JSON.stringify(proposals[0])).toContain("Old input");
		expect(JSON.stringify(proposals[1])).not.toContain("Old input");
		expect(f.wires.at(-1)).toBe(proposals[1]);
	});

	it.each(["knowledge", "account", "external arrival", "budget", "edited message", "branch"] as const)(
		"rebuilds the current view after a change to %s",
		async (change) => {
			const f = fixture();
			await f.begin("Old input");
			await f.send();
			switch (change) {
				case "knowledge":
					f.controls.knowledge = "replacement";
					break;
				case "account":
					f.config.providerAccountKey = "second";
					break;
				case "external arrival":
					f.controls.covered = false;
					break;
				case "budget":
					f.controls.budget = 6;
					break;
				case "edited message":
					advanceMessageContentRevision(f.source.messages[0]!);
					break;
				case "branch":
					f.source.messages = [];
					break;
			}
			await f.begin("New input");
			await f.send();
			const wire = JSON.stringify(f.wires[1]!.messages);
			expect(wire).not.toContain("Old input");
			expect(wire).toContain("New input");
			expect(wire).toContain(f.controls.knowledge);
		},
	);
});

it("rechecks cached message revisions after an edit or importing earlier custody", () => {
	const amended = {};
	const retained = new ContinuousChatMessageDependencies();
	retained.add([amended]);
	expect(retained.isCurrent()).toBe(true);
	advanceMessageContentRevision(amended);
	expect(retained.isCurrent()).toBe(false);

	const next = new ContinuousChatMessageDependencies();
	next.add([{}]);
	expect(next.isCurrent()).toBe(true);
	next.include(retained);
	expect(next.isCurrent()).toBe(false);
});

it("binds a complete live handoff to its exact details and body", () => {
	const details = { records: [{ attemptId: "attempt" }, { attemptId: "second" }] };
	const content = "Two workers finished.";
	recordLiveWorkerHandoff(details, content, details.records, 3);
	expect(liveWorkerHandoffOf(details, content)).toBeUndefined();
	recordLiveWorkerHandoff(details, content, [details.records[0]!, details.records[0]!], 2);
	expect(liveWorkerHandoffOf(details, content)).toBeUndefined();
	recordLiveWorkerHandoff(details, content, details.records, 2);
	expect(liveWorkerHandoffOf(details, content)?.attemptIds).toEqual(["attempt", "second"]);
	expect(liveWorkerHandoffOf({ ...details }, content)).toBeUndefined();
	expect(liveWorkerHandoffOf(details, "Modified.")).toBeUndefined();
});

it("requires a live session message for every intervening project record", async () => {
	const message: UserMessage = { role: "user", content: "Read this.", timestamp: 1 };
	const entry: SessionEntry = {
		type: "message",
		id: "entry",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message,
	};
	const reportData = { version: 1, name: "Builder", claimId: "attempt", text: "Finished.", timestamp: 2 };
	const report: SessionEntry = {
		type: "custom",
		customType: CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE,
		id: "report",
		parentId: entry.id,
		timestamp: new Date(2).toISOString(),
		data: reportData,
	};
	const fabricated: SessionEntry = {
		...report,
		id: "fabricated",
		parentId: report.id,
		data: { ...reportData, claimId: "fabricated-attempt" },
	};
	recordLiveWorkerReport(reportData);
	const entries = new Map([entry, report, fabricated].map((record) => [record.id, record]));
	let nextId = 0;
	const ingestor = new ContinuousChatIngestor({
		readEntry: (id) => entries.get(id),
		getParentInputConsumptionSource: () => ({
			sessionId: "owner",
			readEntries: async () => new Map(),
			findAncestors: async () => [],
			isAncestor: async () => false,
		}),
		appender: {
			append: async (input) => ({
				revision: 1,
				deduplicated: false,
				records: normalizeContinuousChatAppend(input).map((unit) => ({
					id: nextId++,
					schemaVersion: 1,
					kind: unit.kind,
					date: unit.date,
					text: unit.text,
					textBytes: unit.textBytes,
					sourceKey: unit.sourceKey,
					source: unit.source,
				})),
			}),
			appendMany: async () => [],
		},
		warn: () => {},
	});
	ingestor.ingestEntries("owner", [entry.id, report.id, fabricated.id]);
	await ingestor.flush();
	expect(ingestor.proveLiveArrivals("owner", 0, 1, [message])?.reports).toEqual([]);
	expect(ingestor.proveLiveArrivals("owner", 0, 1, [{ ...message }])).toBeUndefined();
	expect(ingestor.proveLiveArrivals("different-session", 0, 1, [message])).toBeUndefined();
	expect(ingestor.proveLiveArrivals("owner", 0, 2, [message])).toBeUndefined();
	const authority = { attemptIds: ["attempt"], isReportOnBranch: (id: string) => id === report.id };
	expect(ingestor.proveLiveArrivals("owner", 0, 2, [message], authority)?.reports).toEqual([
		{ id: 1, attemptId: "attempt", name: "Builder" },
	]);
	expect(
		ingestor.proveLiveArrivals("owner", 0, 2, [message], { ...authority, isReportOnBranch: () => false }),
	).toBeUndefined();
	expect(
		ingestor.proveLiveArrivals("owner", 0, 2, [message], { ...authority, attemptIds: ["other"] }),
	).toBeUndefined();
	expect(
		ingestor.proveLiveArrivals("owner", 0, 2, [message], { ...authority, attemptIds: ["attempt", "other"] }),
	).toBeUndefined();
	expect(
		ingestor.proveLiveArrivals("owner", 0, 3, [message], {
			attemptIds: ["attempt", "fabricated-attempt"],
			isReportOnBranch: () => true,
		}),
	).toBeUndefined();
});
