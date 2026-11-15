/**
 * Builds a loaded bot's own `AgentSession` from its definition: a resource loader that gives it the project context files
 * its read scope reaches and a profile's resources (none of the owner's system prompt files, extensions, skills, prompt
 * templates or themes), System One as the main session runs it (read at each use), and the options a bot's own session
 * takes: its pinned model, its standing, its identity, its tools, its private-path scope and its capability ceiling. What
 * only its host decides (each run's admission, where its notices go, its workers' run bound) comes in as the host's own.
 */

import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { namedAgentIdentity } from "../agent-identity.ts";
import { botSystemOneEvidenceDir } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import { contextFilesWithinReadScope } from "../delegation/worker-execution-policy.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../sdk.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { SystemOneHostSource } from "../system-one/session-source.ts";
import type { TimerSource } from "../util/timer-port.ts";
import type { BotSessionDefinition } from "./bot-session-profile.ts";

/** What a bot's own session is built from. */
export interface BotAgentSessionInput {
	readonly agentId: string;
	readonly agentDir: string;
	readonly definition: BotSessionDefinition;
	/** The name its identity carries (its profile's display name). */
	readonly displayName: string;
	/** Its memory block (its blackboard), as the store composes it for a session. */
	readonly memoryBlock: string;
	readonly sessionManager: SessionManager;
	/** Its own settings manager over the main session's settings storage. */
	readonly settingsManager: SettingsManager;
	readonly registry: ModelRegistry;
	/** The main session's System One as it is now. */
	systemOne(): SystemOneHostSource;
	readonly timers: TimerSource;
	/** What its host decides: each run's admission, its notices, its closing warnings and its workers' run bound. */
	readonly host: Required<
		Pick<CreateAgentSessionOptions, "admitRun" | "ownerNoticeLine" | "onClosingWarnings" | "workerRunCostBound">
	>;
}

/** Builds the bot's own session (see the module comment). */
export async function createBotAgentSession(input: BotAgentSessionInput): Promise<AgentSession> {
	const { agentId, agentDir, definition, settingsManager, registry } = input;
	const { cwd } = definition;
	// System One as the main session runs it now, read at each use: on or off, provider, transport.
	const systemOneHost: SystemOneHostSource = {
		get enabled() {
			return input.systemOne().enabled;
		},
		get provider() {
			return input.systemOne().provider;
		},
		get fetch() {
			return input.systemOne().fetch;
		},
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		installMissingPackages: false,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		// The prompt a worker of the bot carries: the project context files its read scope reaches, a profile's resources
		// before them, and none of the owner's own system prompt files (SYSTEM.md, APPEND_SYSTEM.md).
		agentsFilesOverride: (base) => ({
			agentsFiles: definition.contextFileScope
				? contextFilesWithinReadScope(base.agentsFiles, definition.contextFileScope)
				: base.agentsFiles,
		}),
		systemPromptOverride: () => undefined,
		appendSystemPromptOverride: () => (definition.resourceSystemPrompt ? [definition.resourceSystemPrompt] : []),
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		pinnedModel: true,
		authStorage: registry.authStorage,
		modelRegistry: registry,
		settingsManager,
		resourceLoader,
		sessionManager: input.sessionManager,
		model: definition.model,
		...(definition.thinkingLevel ? { thinkingLevel: definition.thinkingLevel } : {}),
		// A bot's own session: it runs the watches it arms and takes their wakes as parent inputs (idle starts a turn,
		// running steers).
		standing: { kind: "bot", agentId },
		...input.host,
		// System One as the main session runs it; its evidence stays in the bot's home.
		systemOneHost,
		systemOneEvidenceDir: botSystemOneEvidenceDir(agentDir, agentId),
		// Its own name, soul and memory block (its blackboard, which the store appends to after each turn) replace the main
		// agent's in the prompt, as a worker-path start opens on the same block.
		agentIdentity: namedAgentIdentity(input.displayName, definition.soul, agentId, input.memoryBlock),
		tools: [...definition.tools],
		privatePathScope: definition.privatePathScope,
		...(definition.capabilityEnvelope ? { capabilityEnvelope: definition.capabilityEnvelope } : {}),
		timers: input.timers,
	});
	return session;
}
