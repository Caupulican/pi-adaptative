import "../builtin-install.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import { botSessionsDir } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { readBotNotices } from "../../../../src/core/bots/bot-notices.ts";
import {
	BOT_SESSION_USAGE_LABEL,
	SEMANTIC_USAGE_CUSTOM_TYPE,
	type SemanticAccountingReport,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
} from "../../../../src/core/cost/usage-records.ts";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
import type { DelegationRecord } from "../../../../src/core/delegation/leader-delegation-ledger.ts";
import type {
	PersistentBotRecord,
	PersistentBotView,
	PersistentTeamMessage,
} from "../../../../src/core/delegation/persistent-bot-team-store.ts";
import type { WorkerAgentView } from "../../../../src/core/delegation/worker-agent-control.ts";
import type { Settings } from "../../../../src/core/settings/settings-schema.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { HARNESS_PROVIDER, type ScriptedRequest, type ScriptStep } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { fencedToolOutput, ICM_INTAKE_JUDGMENTS, latestBatchResults, refusalDiagnostic } from "./shared.ts";

const { capabilities_authorized: _capabilities, ...intake } = ICM_INTAKE_JUDGMENTS;

/**
 * The judgments one owner prompt of this journey asks with System One on: the intake of a request that calls a tool. No
 * work is delegated with a profile, so no capability question is asked; a bot turn whose words name no claim kind asks
 * nothing, which is why every scripted answer here states a fact and names no test, check, commit or change.
 */
export const PHASE_JUDGMENTS = intake;

const { optional_tool_0: _optionalTool, ...ownerPolicy } = intake;

/**
 * The judgments the owner's words ask in a bot's own session with System One on: the owner-policy questions alone. A
 * bot's session holds no optional tool (`botSessionToolNames` offers no `secret_store`, the main session's one optional
 * tool, which no worker holds either), so no optional-tool question is asked; every edge class is granted and no rule is
 * written, so nothing else is.
 */
export const BOT_SESSION_JUDGMENTS = ownerPolicy;

/**
 * The judgments the owner's words ask in a bot's own session whose turn directs a worker: the owner-policy questions, as
 * for any owner request that calls a tool there. `delegate` and `assign` are not optional tools (only `secret_store` and
 * extension tools are), so they add no optional-tool question; the delegation gate is off by default, so neither of its
 * questions is asked; and every scripted bot and worker answer states a fact that names no claim kind, so no claim reading
 * is asked. Its own constant, so a question a bot's delegation comes to ask is declared here by id and the legs that call
 * no director tool keep asking exactly theirs.
 */
export const BOT_DELEGATION_JUDGMENTS = BOT_SESSION_JUDGMENTS;

/** The scripted model id of each actor: the bot's model is chosen when it is created, and the track carries it. */
export const MODEL_ID = {
	root: "root",
	retry: "worker-a",
	reader: "worker-a",
	held: "worker-a",
	watcher: "worker-c",
	leader: "worker-a",
	teamOne: "worker-b",
	teamTwo: "worker-c",
	helper: "worker-b",
	idle: "worker-c",
	stopLeader: "worker-a",
	stopHelper: "worker-b",
	/** The owner's bot whose priced answers are charged to the main session; its soul tells it apart on the shared model. */
	spender: "worker-b",
	/** The owner's bot whose session lives in its home; its soul tells it apart on the shared model. */
	homeBot: "worker-c",
	/** An appointed goal leader runs on the session's own model, so it shares the root's model and is told apart by its soul. */
	goalLeader: "root",
	/** The owner's bot that writes and directs workers of its own; its soul tells it apart on the shared model. */
	delegator: "worker-b",
	/** The owner's read-only bot that directs workers of its own; its soul tells it apart on the shared model. */
	readOnlyDelegator: "worker-a",
	/** The owner's bot that directs a worker under the main session's worker bound; its soul tells it apart on the shared model. */
	boundedDelegator: "worker-b",
	/** The workers the delegating bots and the owner's session start, each told apart by the marker its task carries. */
	delegateWorker: "worker-c",
	/**
	 * The owner's read-only bot that plans; its soul tells it apart on the shared model, and its plan steps' workers, which run
	 * on the session's model, are told apart by the step header their tasks start with.
	 */
	planner: "worker-a",
	/**
	 * The owner's bot whose stop, made before its second worker started and recorded late, ends only its first; its soul tells
	 * it apart on the shared model.
	 */
	scoper: "worker-b",
} as const;

/** Creates a bot the owner made, with its own soul on its own scripted model: a bot the owner messages runs as its own session. */
export function createOwnerBot(session: AgentSession, agentId: string, modelId: string, soul: string): void {
	session.upsertPersistentBot({
		agentId,
		displayName: displayNameFor(agentId),
		provider: HARNESS_PROVIDER,
		modelId,
		soul,
		createdBy: "owner",
	});
}

/** The provider/model reference a bot is created with. */
export function modelOf(id: (typeof MODEL_ID)[keyof typeof MODEL_ID]): string {
	return `${HARNESS_PROVIDER}/${id}`;
}

/** One script track per actor; a track is selected by its model id and, when actors share a model, by a matcher. */
export const TRACK = {
	root: "j7-root",
	retry: "j7-retry",
	reader: "j7-reader",
	held: "j7-held",
	watcher: "j7-watcher",
	watchStopper: "j7-watch-stopper",
	teamOne: "j7-team-one",
	teamTwo: "j7-team-two",
	leader: "j7-leader",
	leaderDepth: "j7-leader-depth",
	helper: "j7-helper",
	idle: "j7-idle",
	stopLeader: "j7-stop-leader",
	stopHelper: "j7-stop-helper",
	goalLeader: "j7-goal-leader",
	spender: "j7-spender",
	homeBot: "j7-home-bot",
	delegator: "j7-delegator",
	readOnlyDelegator: "j7-read-only-delegator",
	delegateWorker: "j7-delegate-worker",
	heldDelegateWorker: "j7-held-delegate-worker",
	rootDelegateWorker: "j7-root-delegate-worker",
	readOnlyDelegateWorker: "j7-read-only-delegate-worker",
	boundedDelegator: "j7-bounded-delegator",
	boundedDelegateWorker: "j7-bounded-delegate-worker",
	planner: "j7-planner",
	scoper: "j7-scoper",
	scopedFirstWorker: "j7-scoped-first-worker",
	scopedLaterWorker: "j7-scoped-later-worker",
} as const;

/**
 * The opening line of the soul the harness gives an appointed goal leader (`GOAL_LEADER_SOUL`): a request that carries it
 * is that leader's, not the root's, though both run on the session's model.
 */
export const GOAL_LEADER_OPENING = "You lead one goal for the orchestrator and nothing else.";

const isNotGoalLeader = (request: ScriptedRequest): boolean =>
	!(request.context.systemPrompt ?? "").includes(GOAL_LEADER_OPENING);

/** Scripts the orchestrator's own next requests: every root session of the journey shares this one track. */
export function enqueueRoot(world: HarnessWorld, ...steps: ScriptStep[]): void {
	world.provider.enqueueTrack(TRACK.root, MODEL_ID.root, isNotGoalLeader, ...steps);
}

/**
 * A matcher on a line only one actor's request carries: a bot's soul opens its system prompt on every turn of every
 * worker generation, so two bots that share a model cannot be confused for each other.
 */
export function soulMatcher(fragment: string): (request: ScriptedRequest) => boolean {
	let matcher = soulMatchers.get(fragment);
	if (!matcher) {
		matcher = (request) => (request.context.systemPrompt ?? "").includes(fragment);
		soulMatchers.set(fragment, matcher);
	}
	return matcher;
}

/** One matcher per soul, so a track scripted again for the same bot keeps the identity the provider checks. */
const soulMatchers = new Map<string, (request: ScriptedRequest) => boolean>();

/** Scripts one bot's requests on its own track, told apart from the actors that share its model. */
export function enqueueBot(
	world: HarnessWorld,
	track: string,
	modelId: string,
	soul: string,
	...steps: ScriptStep[]
): void {
	world.provider.enqueueTrack(track, modelId, soulMatcher(soul), ...steps);
}

/** The `<track>:<step>` key the provider records when a request reaches `step` on `track`. */
export function reached(track: string, step: string): string {
	return `${track}:${step}`;
}

/** The whole conversation a request carries, as one text. */
export function requestJson(request: ScriptedRequest): string {
	return JSON.stringify(request.context.messages);
}

/** Whether the request's conversation carries `text` anywhere. */
export function carries(request: ScriptedRequest, text: string): boolean {
	return requestJson(request).includes(text);
}

/** Where `text` first appears in the request's conversation, or -1: two messages are in order when this grows. */
export function positionOf(request: ScriptedRequest, text: string): number {
	return requestJson(request).indexOf(text);
}

/** The offered tool names of a request. */
export function offeredTools(request: ScriptedRequest): string[] {
	return (request.context.tools ?? []).map((tool) => tool.name);
}

/**
 * The actions a tool's schema offers in a request, as the model is given them: a union of literals reaches a model as an
 * `enum` or as `anyOf` constants, depending on how the schema was normalized.
 */
export function offeredActions(request: ScriptedRequest, toolName: string): string[] {
	const tool = (request.context.tools ?? []).find((candidate) => candidate.name === toolName);
	const action = (
		tool?.parameters as { properties?: { action?: { enum?: string[]; anyOf?: { const?: string }[] } } } | undefined
	)?.properties?.action;
	return action?.enum ?? (action?.anyOf ?? []).map((entry) => entry.const ?? "");
}

/**
 * The root's first request of a phase that uses `bot`. The tool is deferred: a root is offered `tool_search` and loads
 * the `bot` schema by name before its first call, after which the tool is offered. The step makes that load and pins
 * what the root was offered before it.
 */
export function loadBotToolStep(name: string): ScriptStep {
	return {
		name,
		check: (request) => {
			const offered = offeredTools(request);
			if (!offered.includes("tool_search") || offered.includes("bot"))
				throw new Error(`before it is loaded, bot is deferred behind tool_search: ${offered.join(", ")}`);
		},
		reply: {
			content: [{ type: "toolCall", id: `${name}-1`, name: "tool_search", arguments: { query: "select:bot" } }],
			stopReason: "toolUse",
		},
	};
}

/** One tool result of the request's latest batch. */
export interface BatchResult {
	readonly toolName: string;
	readonly isError: boolean;
	readonly text: string;
}

/** The last result of `toolName` in the request's latest batch, as the tool reported it. */
export function lastResult(request: ScriptedRequest, toolName: string): BatchResult | undefined {
	return latestBatchResults(request)
		.filter((result) => result.toolName === toolName)
		.at(-1);
}

/** The JSON an accepted tool call answered with, read out of the fence the harness stores it in. */
export function acceptedJson(request: ScriptedRequest, toolName: string): Record<string, unknown> {
	const result = lastResult(request, toolName);
	if (result === undefined) throw new Error(`the latest batch carries no ${toolName} result`);
	if (result.isError) throw new Error(`${toolName} was refused: ${result.text}`);
	return JSON.parse(fencedToolOutput(result.text)) as Record<string, unknown>;
}

/** The diagnostic the harness recorded for a refused tool call. */
export function refusedResult(request: ScriptedRequest, toolName: string): BatchResult {
	const result = lastResult(request, toolName);
	if (result === undefined) throw new Error(`the latest batch carries no ${toolName} result`);
	if (!result.isError) throw new Error(`${toolName} was accepted, not refused: ${result.text}`);
	return result;
}

/** The words a refused call was refused with: the diagnostic of its failure record, or its own output. */
export function refusalOf(request: ScriptedRequest, toolName: string): { tool: string; sentence: string } {
	const result = refusedResult(request, toolName);
	return {
		tool: result.toolName,
		sentence: refusalDiagnostic(result.text) ?? fencedToolOutput(result.text).trim(),
	};
}

/** The stored bot record, re-read from the shared store so another session's write is visible. */
export function botRecord(session: AgentSession, agentId: string): PersistentBotRecord {
	const store = session.getBotTeamStore();
	store.reload(true);
	const record = store.getBot(agentId);
	if (record === undefined) throw new Error(`the store holds no bot ${agentId}`);
	return record;
}

/** Every bot the shared store holds, retired ones included. */
export function allBots(session: AgentSession): PersistentBotRecord[] {
	const store = session.getBotTeamStore();
	store.reload(true);
	return store.listBots({ includeRetired: true });
}

/**
 * The owner's messages the store keeps for a group, oldest first, taken out of the group's whole log: the log also holds
 * each member's answers, in the order they happened.
 */
export function teamMessages(session: AgentSession, teamId: string): PersistentTeamMessage[] {
	const store = session.getBotTeamStore();
	store.reload(true);
	return store.listTeamMessages(teamId).filter((message) => message.sender.kind === "operator");
}

/** The group's whole log in the order it was written: the owner's messages and the members' answers together. */
export function teamLog(session: AgentSession, teamId: string): PersistentTeamMessage[] {
	const store = session.getBotTeamStore();
	store.reload(true);
	return store.listTeamMessages(teamId);
}

/** The worker agents this session runs on one model, as the live roster holds them. */
export function agentsOn(session: AgentSession, modelId: string): WorkerAgentView[] {
	return session.backgroundLanes
		.listWorkerAgents()
		.filter((agent) => agent.modelRef === `${HARNESS_PROVIDER}/${modelId}`);
}

/** The only worker agent this session runs on one model; fails when there is none or several. */
export function onlyAgentOn(session: AgentSession, modelId: string): WorkerAgentView {
	const agents = agentsOn(session, modelId);
	if (agents.length !== 1) throw new Error(`expected one agent on ${modelId}, found ${agents.length}`);
	return agents[0]!;
}

/** Every delegation this session's leaders ran, oldest first. */
export function delegationsOf(session: AgentSession): DelegationRecord[] {
	return session.backgroundLanes.leaderDelegations();
}

/** The one delegation a leader ran in this session. */
export function delegationOf(session: AgentSession, leader: string): DelegationRecord {
	const records = delegationsOf(session).filter((record) => record.charter.leader === leader);
	if (records.length !== 1) throw new Error(`expected one delegation led by ${leader}, found ${records.length}`);
	return records[0]!;
}

/** The text a group message was stored with. */
export function storedMessageText(session: AgentSession, teamId: string, index: number): string {
	const message = teamMessages(session, teamId)[index];
	if (message === undefined) throw new Error(`the group ${teamId} holds no message at ${index}`);
	return message.text;
}

/** The bot ids a group message was stored for. */
export function storedMessageTargets(session: AgentSession, teamId: string, index: number): string[] {
	const message = teamMessages(session, teamId)[index];
	if (message === undefined) throw new Error(`the group ${teamId} holds no message at ${index}`);
	return [...message.targetAgentIds];
}

/** The delivery outcomes a group message was stored with, by member. */
export function storedMessageDeliveries(session: AgentSession, teamId: string, index: number): Array<[string, string]> {
	const message = teamMessages(session, teamId)[index];
	if (message === undefined) throw new Error(`the group ${teamId} holds no message at ${index}`);
	return message.deliveries.map((delivery) => [delivery.agentId, delivery.outcome]);
}

/** The chat a bot shows its owner: every word of the conversation the product reads back for it. */
export function chatText(session: AgentSession, agentId: string): string {
	const parts: string[] = [];
	for (const message of session.readBotChatMessages(agentId)) {
		const content: unknown = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; text?: string }>) {
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/** What the roster shows of a bot now: running, queued, idle or retired. */
export function botRosterState(session: AgentSession, agentId: string): string | undefined {
	return session.listPersistentBots().find((bot) => bot.agentId === agentId)?.state;
}

/**
 * Waits until the roster's view of the bot holds `what` (`holds`). The poll ends with the wait, whether the view came or
 * the deadline passed, so a failed wait leaves nothing spinning behind it.
 */
export async function waitForBotRosterView(
	world: HarnessWorld,
	session: AgentSession,
	agentId: string,
	what: string,
	holds: (view: PersistentBotView | undefined) => boolean,
): Promise<void> {
	const view = () => session.listPersistentBots().find((bot) => bot.agentId === agentId);
	let ended = false;
	try {
		await withDeadline(
			world.trace,
			`the roster shows ${agentId} ${what}`,
			(async () => {
				while (!ended && !holds(view())) await new Promise<void>((resolve) => setImmediate(resolve));
			})(),
		);
	} finally {
		ended = true;
	}
}

/** Waits until the roster shows `state` for the bot: its session's turn started, queued or settled. */
export function waitForBotRosterState(
	world: HarnessWorld,
	session: AgentSession,
	agentId: string,
	state: string,
): Promise<void> {
	return waitForBotRosterView(world, session, agentId, `as ${state}`, (view) => view?.state === state);
}

/** The owner-facing words of every notice the bot's session wrote to its chat. */
export function botNoticeTexts(world: HarnessWorld, agentId: string): string[] {
	const unreadable: string[] = [];
	const texts = readBotNotices(world.agentDir, agentId, (file, reason) => unreadable.push(`${file}: ${reason}`)).map(
		(record) => record.message.text,
	);
	if (unreadable.length > 0) throw new Error(`bot notices could not be read: ${unreadable.join("; ")}`);
	return texts;
}

/** The text of every file of the bot's own `sessions/` directory: the conversation as the bot's session wrote it. */
export function botSessionFilesText(world: HarnessWorld, agentId: string): string {
	const directory = botSessionsDir(world.agentDir, agentId);
	if (!existsSync(directory)) return "";
	return readdirSync(directory)
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.map((name) => readFileSync(join(directory, name), "utf8"))
		.join("\n");
}

/** Fails with `what` unless the value the phase read is the one the product promises. */
export function assertSeen(actual: unknown, what: string, expected: unknown): void {
	expect(actual, what).toEqual(expected);
}

/** One line of a JSONL session file, as the bot-charge readers need it. */
interface FileLine {
	type?: string;
	id?: string;
	customType?: string;
	data?: unknown;
}

/** The lines of a JSONL session file's text, blank lines skipped. */
export function fileLines(text: string): FileLine[] {
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as FileLine);
}

/**
 * The System One spend a bot's own session files record: their semantic usage entries, each receipt once by its report id,
 * as the session's cumulative usage counts them (`aggregateCumulativeUsageFromSessionEntries`). It is part of what the
 * bot spent, so the main session is charged it with the bot's model and worker spend; with System One off a bot's session
 * records none. `tokens` lists each receipt's input and output tokens, the scripted transport answer's usage.
 */
export function botSemanticSpend(
	world: HarnessWorld,
	agentId: string,
): { readonly receipts: number; readonly usd: number; readonly tokens: readonly string[] } {
	const seen = new Set<string>();
	const tokens: string[] = [];
	let usd = 0;
	for (const line of fileLines(botSessionFilesText(world, agentId))) {
		if (line.type !== "custom" || line.customType !== SEMANTIC_USAGE_CUSTOM_TYPE) continue;
		const report = line.data as SemanticAccountingReport | undefined;
		if (!report?.reportId || !report.usage || seen.has(report.reportId)) continue;
		seen.add(report.reportId);
		tokens.push(`${report.usage.input}/${report.usage.output}`);
		usd += report.usage.cost.total;
	}
	return { receipts: seen.size, usd, tokens };
}

/** The bot's charges the root's session file holds: the custom spawned-usage entries labelled as a bot session's, of its session. */
export function botCharges(rootFile: string, botSessionId: string): SpawnedUsageReport[] {
	return fileLines(readFileSync(rootFile, "utf8"))
		.filter((line) => line.type === "custom" && line.customType === SPAWNED_USAGE_CUSTOM_TYPE)
		.map((line) => line.data as SpawnedUsageReport)
		.filter((report) => report.label === BOT_SESSION_USAGE_LABEL && report.sourceSessionId === botSessionId);
}

/** The ids of the session headers in the bot's own session files: one per session file it ever opened. */
export function botSessionIds(world: HarnessWorld, agentId: string): string[] {
	return fileLines(botSessionFilesText(world, agentId))
		.filter((line) => line.type === "session")
		.map((line) => line.id ?? "");
}

/**
 * A root session whose file already exists, so a bot's charge can be settled in it: a main session buffers its entries
 * until one needs its file, and a bot's charge is settled only once that file holds it, so the root starts with one
 * recorded reply, as a session the owner already spoke in does.
 */
export async function createChargedRoot(
	world: HarnessWorld,
	label: string,
	settings?: Partial<Settings>,
): Promise<{ readonly session: AgentSession; readonly manager: SessionManager; readonly rootFile: string }> {
	const manager = world.createSessionManager();
	const rootModel = world.provider.model(MODEL_ID.root);
	manager.appendMessage({
		role: "assistant",
		api: rootModel.api,
		provider: rootModel.provider,
		model: rootModel.id,
		content: [{ type: "text", text: "The connection pool is configured." }],
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const rootFile = manager.getSessionFile();
	if (!manager.hasDurableSessionFile() || rootFile === undefined)
		throw new Error(`the ${label} root's seeded reply did not reach its file`);
	const { session } = await world.createRootSession(MODEL_ID.root, {
		sessionManager: manager,
		...(settings ? { settings } : {}),
	});
	return { session, manager, rootFile };
}
