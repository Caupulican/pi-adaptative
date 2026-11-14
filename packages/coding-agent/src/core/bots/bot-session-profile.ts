/**
 * What a bot's session is built from (`BotSessionDefinition`).
 *
 * A bot of its own runs on its record (`ownBotSession`): its model and thinking, the read tools with the file and process
 * tools when it may write, a worker's private-path scope in the owner's project directory, and its soul.
 *
 * A bot made from a worker profile runs on what the worker admission compiled for it (`profileBotSession`, from
 * `BotSessionCompilation`): the admitted model and thinking, the plan's tools a session holds plus the watch it arms for
 * its own waits, the plan's working directory, its read roots (when the plan confines reads), write roots, private paths
 * and read-only grant as the session's private path scope, a capability ceiling of the plan's capabilities and cost bound
 * held by the session's tool gate, the soul a worker of it would carry and its resources as a system prompt. A profile
 * that needs what only a worker's run has, an independent verifier of each claim, a tool a session does not hold or a
 * limit only a worker's run counts (tokens, wall-clock time, attempts, tool calls), keeps the bot on the worker path.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { TOOL_SCHEMA_SEARCH_NAME } from "@caupulican/pi-ai";
import { checkSoulText } from "../agent-identity.ts";
import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import type { SessionPrivatePathScope } from "../autonomy/worker-session-private-scope.ts";
import { mapToolNamesForPlatform, STABLE_SHELL_TOOL_NAME } from "../default-tool-surface.ts";
import type { BotSessionCompilation } from "../delegation/bot-worker-start.ts";
import type { PersistentBotRecord } from "../delegation/persistent-bot-team-store.ts";
import { READ_TOOL_NAMES, REPO_READ_TOOL_NAME, WRITE_TOOL_NAMES } from "../delegation/worker-execution-policy.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { OrchestrationThinkingLevel, WorkerRole } from "../orchestration/contracts.ts";
import { isOrchestrationThinkingLevel } from "../orchestration/thinking-level-guard.ts";
import { workerPromptSoul } from "../orchestration/worker-execution-contract.ts";
import { TASK_WATCH_TOOL_NAME } from "../routines/routine-tool-names.ts";
import { SYSTEM_ONE_TOOL_NAME } from "../system-one/tool-names.ts";
import { requiredEnvelopeCapabilities, toolSurvivesReadOnly } from "../tool-capability-policy.ts";
import { LOOKUP_TOOL_NAME } from "../tools/lookup-tool-name.ts";
import { allToolNames } from "../tools/tool-definition-factory.ts";
import { botProfileOf } from "./bot-home.ts";

export interface BotSessionDefinition {
	/** What defines the session: an idle session whose key changed is rebuilt. */
	readonly key: string;
	readonly model: Model<Api>;
	readonly thinkingLevel?: OrchestrationThinkingLevel;
	/** What its turns are for, as a worker's role says it; its tool loop is supervised for that role. */
	readonly role: WorkerRole;
	readonly cwd: string;
	readonly tools: readonly string[];
	readonly privatePathScope: SessionPrivatePathScope;
	readonly capabilityEnvelope?: CapabilityEnvelope;
	readonly soul?: string;
	/** A profile's resources, appended to the system prompt as a worker's carries them. */
	readonly resourceSystemPrompt?: string;
	/** A profile's dollar bound on one turn, beside the owner's worker bound and the main session's. */
	readonly spendBoundUsd?: number;
}

/**
 * The tools of a bot of its own: the read tools, System One's tool (as a worker holds it; it is registered only while
 * System One is on) and `task_watch` for its own waits always, the file and process tools only when the bot may write.
 */
export function botSessionToolNames(canWrite: boolean): string[] {
	const reads = [...READ_TOOL_NAMES, REPO_READ_TOOL_NAME, LOOKUP_TOOL_NAME, SYSTEM_ONE_TOOL_NAME];
	// A read-only bot keeps what a read-only worker keeps: the shell is judged command by command (`privatePathScope.readOnlyShell`),
	// and so is a watched command, at arming and at every check (`WatchAdmission`), so `task_watch` widens nothing.
	return canWrite
		? [...reads, TOOL_SCHEMA_SEARCH_NAME, TASK_WATCH_TOOL_NAME, ...WRITE_TOOL_NAMES, "python", STABLE_SHELL_TOOL_NAME]
		: [
				...[...reads, STABLE_SHELL_TOOL_NAME].filter(toolSurvivesReadOnly),
				TOOL_SCHEMA_SEARCH_NAME,
				TASK_WATCH_TOOL_NAME,
			];
}

/** What defines a bot of its own: the fields its session is built from. A rename or a new description leaves it as it is. */
export function ownBotSessionKey(record: PersistentBotRecord): string {
	const { provider, modelId, thinkingLevel, soul, canWrite } = botProfileOf(record);
	return JSON.stringify([provider, modelId, thinkingLevel, soul, canWrite]);
}

/** A bot of its own, on its record and its model as the registry knows it now; throws the owner's words when it cannot run. */
export function ownBotSession(record: PersistentBotRecord, cwd: string, registry: ModelRegistry): BotSessionDefinition {
	const words = interfaceText().botTeam;
	const profile = botProfileOf(record);
	const model = registry.find(profile.provider, profile.modelId);
	if (!model || !registry.hasConfiguredAuth(model))
		throw new Error(words.botModelUnavailable(record.agentId, `${profile.provider}/${profile.modelId}`));
	// The soul is judged again here: a stored record can have been edited by hand.
	const soul = profile.soul === undefined ? { ok: true as const, soul: undefined } : checkSoulText(profile.soul);
	if (!soul.ok) throw new Error(words.botSoulRefused(record.agentId, soul.reason));
	return {
		key: ownBotSessionKey(record),
		model,
		...(isOrchestrationThinkingLevel(profile.thinkingLevel) ? { thinkingLevel: profile.thinkingLevel } : {}),
		role: profile.canWrite ? "implementer" : "explorer",
		cwd,
		tools: botSessionToolNames(profile.canWrite),
		// It writes as a worker writes (inside the project directory, never to a harness resource) and, as a worker, never
		// reaches an owner credential file: a call that would is refused before it runs.
		privatePathScope: { readOnlyShell: !profile.canWrite, confinedWrites: true, credentialExposure: "deny" },
		...(soul.soul !== undefined ? { soul: soul.soul } : {}),
	};
}

/** The tools a bot's session registers: the built-in tools and the ones the session hosts itself. */
const SESSION_HOSTED_TOOL_NAMES: ReadonlySet<string> = new Set([
	LOOKUP_TOOL_NAME,
	SYSTEM_ONE_TOOL_NAME,
	TASK_WATCH_TOOL_NAME,
]);

function sessionHolds(toolName: string): boolean {
	return (allToolNames as ReadonlySet<string>).has(toolName) || SESSION_HOSTED_TOOL_NAMES.has(toolName);
}

/** The limits a worker's run counts and a session does not: tokens, wall-clock time, attempts and tool calls. */
const WORKER_COUNTED_LIMITS = ["maxTokens", "maxWallClockMs", "maxAttempts", "maxToolCalls"] as const;

export type ProfileBotSession =
	| { readonly route: "session"; readonly definition: BotSessionDefinition }
	/** Why only a worker's run can hold the bot, as a reason code. */
	| { readonly route: "worker"; readonly reason: string };

/** The session a bot made from a profile runs as, from what the worker admission compiled for it. */
export function profileBotSession(compiled: Extract<BotSessionCompilation, { ok: true }>): ProfileBotSession {
	const { profile, shipment, plan } = compiled;
	if (profile.requireIndependentVerification === true)
		return { route: "worker", reason: "independent_verification_required" };
	const planned = plan.toolManifests.map((manifest) => manifest.toolName);
	// A tool the profile names that a session does not hold (a worker's brokered tools) needs a worker's run; a tool the
	// plan adds on its own (YOLO's surface) is not the profile's to require.
	const named = new Set(mapToolNamesForPlatform(profile.toolNames));
	const unheld = planned.filter((name) => named.has(name) && !sessionHolds(name));
	if (unheld.length > 0) return { route: "worker", reason: `tools_need_worker:${unheld.join(",")}` };
	// A limit the profile sets that only a worker's run counts (its capability gateway and attempt tree) needs that run; a
	// session bounds its turns by cost alone.
	const workerLimits = WORKER_COUNTED_LIMITS.filter((field) => profile.budget[field] !== undefined);
	if (workerLimits.length > 0) return { route: "worker", reason: `limits_need_worker:${workerLimits.join(",")}` };
	// It arms its own waits as a worker's host does, outside the granted surface.
	const tools = [...new Set([...planned.filter(sessionHolds), TASK_WATCH_TOOL_NAME])];
	const capabilityEnvelope: CapabilityEnvelope = {
		id: `bot-profile:${profile.profileId}`,
		profileId: profile.profileId,
		capabilities: [...new Set([...plan.requiredCapabilities, ...requiredEnvelopeCapabilities(TASK_WATCH_TOOL_NAME)])],
		allowedTools: tools,
		...(plan.budget.maxCostUsd !== undefined ? { maxEstimatedUsd: plan.budget.maxCostUsd } : {}),
	};
	const privatePathScope: SessionPrivatePathScope = {
		readOnlyShell: plan.readOnly || plan.shellReadOnly,
		confinedWrites: true,
		credentialExposure: "deny",
		...(plan.writePaths.length > 0 ? { writeRoots: plan.writePaths } : {}),
		...(plan.readConfined ? { readRoots: plan.readPaths } : {}),
		...(plan.deniedPaths.length > 0 ? { deniedPaths: plan.deniedPaths } : {}),
	};
	const soul = workerPromptSoul(shipment);
	const definition = {
		model: shipment.model,
		thinkingLevel: shipment.modelBinding.thinkingLevel,
		role: shipment.profile.role,
		cwd: plan.cwd,
		tools,
		privatePathScope,
		capabilityEnvelope,
		...(soul !== undefined ? { soul } : {}),
		...(compiled.resourceSystemPrompt ? { resourceSystemPrompt: compiled.resourceSystemPrompt } : {}),
		...(profile.budget.maxCostUsd !== undefined ? { spendBoundUsd: profile.budget.maxCostUsd } : {}),
	};
	const { model, ...defining } = definition;
	return {
		route: "session",
		definition: { ...definition, key: JSON.stringify([`${model.provider}/${model.id}`, defining]) },
	};
}
