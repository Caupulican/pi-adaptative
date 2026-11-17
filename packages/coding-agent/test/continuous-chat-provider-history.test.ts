import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	type Context,
	createEmptyUsage,
	type Model,
	type UserMessage,
} from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type PathAliasLegendEntry,
	renderPathAliasLegend,
	renderPathAliasLegendFrame,
} from "../src/core/comms/host-injection-records.ts";
import { normalizeContinuousChatAppend } from "../src/core/memory/continuous-chat-contracts.ts";
import { ContinuousChatIngestor } from "../src/core/memory/continuous-chat-ingest.ts";
import {
	continuousChatRequestHistory,
	createContinuousChatPlanWrapper,
} from "../src/core/memory/continuous-chat-projection.ts";
import { IcmTurnCoordinator } from "../src/core/memory/continuous-chat-turn-coordinator.ts";
import type { AgentContext, AgentLoopConfig } from "../src/kernel/loop-config.ts";
import { advanceMessageContentRevision } from "../src/kernel/message-revision.ts";
import { convertToLlm, createCustomMessage } from "../src/kernel/messages.ts";
import { startPlannedAgentProviderRequestWithId } from "../src/kernel/provider-request-planner.ts";
import type { SessionEntry } from "../src/kernel/session/session-entries.ts";
import { HOST_REQUEST_ONLY_DETAILS } from "../src/kernel/transient-records.ts";
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

function fixture() {
	const frameRecords: AgentMessage[] = [];
	const transient: AgentMessage[] = [];
	const aliases = new Map<string, string>();
	const knowledgeRanges: Array<{ start: number; count: number } | undefined> = [];
	const cache = { authority: "project", stablePrefixLineCount: 0, lines: [] };
	const view = "<chat>\n</chat>";
	const controls = {
		covered: true,
		budget: 48_000,
		knowledge: "current fact",
		totalMessages: 0,
		transform: async (messages: AgentMessage[]) => messages,
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
		canRetain: () => controls.covered,
		allowsHistoryTokens: (_model, tokens) => tokens <= controls.budget,
	});
	const config: AgentLoopConfig = {
		model,
		convertToLlm,
		providerAccountKey: "first",
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
	async function begin(text: string) {
		const previous = turns.current();
		if (previous) turns.end(previous);
		const handle = await turns.begin();
		const user: UserMessage = { role: "user", content: text, timestamp: handle.turnId };
		source.messages.push(user);
		handle.markStart(user);
		return handle;
	}
	async function send(content: AssistantMessage["content"] = [{ type: "text", text: "Done." }]) {
		const started = await startPlannedAgentProviderRequestWithId(source, config, undefined, (_model, context) => {
			wires.push(context);
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
		started.observeAssistant?.(provider, final);
		source.messages.push(final);
		return provider;
	}
	return { begin, send, config, controls, turns, source, wires, frameRecords, transient, aliases, knowledgeRanges };
}

describe("continuous chat at the native provider boundary", () => {
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

it("requires a live session message for every intervening project record", async () => {
	const message: UserMessage = { role: "user", content: "Read this.", timestamp: 1 };
	const entry: SessionEntry = {
		type: "message",
		id: "entry",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message,
	};
	const ingestor = new ContinuousChatIngestor({
		readEntry: (id) => (id === entry.id ? entry : undefined),
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
				records: normalizeContinuousChatAppend(input).map((unit, id) => ({
					id,
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
	ingestor.ingestEntries("owner", [entry.id]);
	await ingestor.flush();
	expect(ingestor.coversLiveArrivals("owner", 0, 1, [message])).toBe(true);
	expect(ingestor.coversLiveArrivals("owner", 0, 1, [{ ...message }])).toBe(false);
	expect(ingestor.coversLiveArrivals("different-session", 0, 1, [message])).toBe(false);
	expect(ingestor.coversLiveArrivals("owner", 0, 2, [message])).toBe(false);
});
