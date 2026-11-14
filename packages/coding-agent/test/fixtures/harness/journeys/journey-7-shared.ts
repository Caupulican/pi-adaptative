import "../builtin-install.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { botSessionsDir } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
import type { DelegationRecord } from "../../../../src/core/delegation/leader-delegation-ledger.ts";
import type {
	PersistentBotRecord,
	PersistentTeamMessage,
} from "../../../../src/core/delegation/persistent-bot-team-store.ts";
import type { WorkerAgentView } from "../../../../src/core/delegation/worker-agent-control.ts";
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
	/** An appointed goal leader runs on the session's own model, so it shares the root's model and is told apart by its soul. */
	goalLeader: "root",
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
	teamOne: "j7-team-one",
	teamTwo: "j7-team-two",
	leader: "j7-leader",
	leaderDepth: "j7-leader-depth",
	helper: "j7-helper",
	idle: "j7-idle",
	stopLeader: "j7-stop-leader",
	stopHelper: "j7-stop-helper",
	goalLeader: "j7-goal-leader",
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
	return (request) => (request.context.systemPrompt ?? "").includes(fragment);
}

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
 * Waits until the roster shows `state` for the bot: its session's turn started, queued or settled. The poll ends with the
 * wait, whether the state came or the deadline passed, so a failed wait leaves nothing spinning behind it.
 */
export async function waitForBotRosterState(
	world: HarnessWorld,
	session: AgentSession,
	agentId: string,
	state: string,
): Promise<void> {
	let ended = false;
	try {
		await withDeadline(
			world.trace,
			`the roster shows ${agentId} as ${state}`,
			(async () => {
				while (!ended && botRosterState(session, agentId) !== state)
					await new Promise<void>((resolve) => setImmediate(resolve));
			})(),
		);
	} finally {
		ended = true;
	}
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
