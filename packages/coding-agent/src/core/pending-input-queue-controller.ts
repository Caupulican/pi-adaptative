import type { Agent } from "@caupulican/pi-agent-core/agent";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { ImageContent, TextContent } from "@caupulican/pi-ai";
import type { ExtensionRunner } from "./extensions/index.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import type { ExplicitGoalStartAuthority } from "./goals/natural-language-goal.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { SkillVaultController } from "./skill-vault.ts";

export interface PendingQueueSnapshot {
	steering: string[];
	followUp: string[];
	commands: string[];
}

export interface PendingInputQueueDeps {
	readonly agent: Agent;
	readonly skillVault: SkillVaultController;
	readonly goals: GoalSessionController;
	/** `_extensionRunner` is assigned after construction (definite-assignment field on AgentSession),
	 * so it must be read through a thunk rather than captured by value. */
	getExtensionRunner(): ExtensionRunner;
	getPromptTemplates(): ReadonlyArray<PromptTemplate>;
}

/**
 * Owns the three "pending input" queues that fill while the agent is mid-turn -- steering,
 * follow-up, and extension-command -- plus the command/skill-command text preparation shared by
 * `prompt()` and the queued path. Extracted from AgentSession (see
 * scripts/check-coordinator-boundaries.mjs, which enforces the coordinator's line-count ceiling)
 * because this already read as one responsibility: everything here is about deciding what to do
 * with input that arrives while a turn is in flight, and delivering it once one ends.
 *
 * AgentSession still owns eventing (`_emitQueueUpdate`/`_emit`) and calls back into this
 * controller for the underlying queue mechanics; this class has no event/emit dependency.
 */
export class PendingInputQueueController {
	private _steeringMessages: string[] = [];
	private _followUpMessages: string[] = [];
	private _queuedExtensionCommands: string[] = [];
	private readonly deps: PendingInputQueueDeps;

	constructor(deps: PendingInputQueueDeps) {
		this.deps = deps;
	}

	get count(): number {
		return this._steeringMessages.length + this._followUpMessages.length + this._queuedExtensionCommands.length;
	}

	getSteering(): readonly string[] {
		return this._steeringMessages;
	}

	getFollowUp(): readonly string[] {
		return this._followUpMessages;
	}

	getCommands(): readonly string[] {
		return this._queuedExtensionCommands;
	}

	snapshot(): PendingQueueSnapshot {
		return {
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
			commands: [...this._queuedExtensionCommands],
		};
	}

	parseCommandName(text: string): string {
		const spaceIndex = text.indexOf(" ");
		return spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	}

	/** Route explicit /skill:name through the same host-owned vault as model tool calls. */
	expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const result = this.deps.skillVault.load(skillName, "user");
		if (!result.ok) {
			this.deps.getExtensionRunner().emitError({
				extensionPath: "<skill-vault>",
				event: "skill_load",
				error: result.message,
			});
			return text;
		}
		return args || `Use loaded skill ${JSON.stringify(skillName)} for this request.`;
	}

	/** Throw an error if the text is an extension command. */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.deps.getExtensionRunner().getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/** Reject extension commands, then expand a queued message through the shared skill/template path. */
	prepareQueuedMessageText(text: string): string {
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}
		return expandPromptTemplate(this.expandSkillCommand(text), [...this.deps.getPromptTemplates()]);
	}

	/** Try to execute an extension command. Returns true if command was found and executed. */
	async tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = this.parseCommandName(text);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const runner = this.deps.getExtensionRunner();
		const command = runner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = runner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			runner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	private _createQueuedUserMessage(
		text: string,
		images: ImageContent[] | undefined,
		queuedGoalAuthority: ExplicitGoalStartAuthority | undefined,
	): AgentMessage {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...(images ?? [])];
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		if (queuedGoalAuthority) this.deps.goals.queueOwnerChatGoal(message, text, queuedGoalAuthority);
		return message;
	}

	/** Queue a steering message (already expanded, no extension command check). */
	queueSteer(text: string, images?: ImageContent[], queuedGoalAuthority?: ExplicitGoalStartAuthority): void {
		this._steeringMessages.push(text);
		this.deps.agent.steer(this._createQueuedUserMessage(text, images, queuedGoalAuthority));
	}

	/** Queue a follow-up message (already expanded, no extension command check). */
	queueFollowUp(text: string, images?: ImageContent[], queuedGoalAuthority?: ExplicitGoalStartAuthority): void {
		this._followUpMessages.push(text);
		this.deps.agent.followUp(this._createQueuedUserMessage(text, images, queuedGoalAuthority));
	}

	/** Queue an extension command to execute after the current agent run. */
	queueExtensionCommand(text: string): void {
		this._queuedExtensionCommands.push(text);
	}

	/** Pop the next queued extension command, if any. Caller is responsible for the isStreaming gate. */
	shiftCommand(): string | undefined {
		return this._queuedExtensionCommands.shift();
	}

	/**
	 * Remove a delivered message from whichever queue currently holds it (steering checked first,
	 * matching prior behavior). Returns which queue it was removed from, or undefined if it was not
	 * queued -- callers use that to decide whether a queue_update event is warranted.
	 */
	removeIfPending(messageText: string): "steering" | "followUp" | undefined {
		const steeringIndex = this._steeringMessages.indexOf(messageText);
		if (steeringIndex !== -1) {
			this._steeringMessages.splice(steeringIndex, 1);
			return "steering";
		}
		const followUpIndex = this._followUpMessages.indexOf(messageText);
		if (followUpIndex !== -1) {
			this._followUpMessages.splice(followUpIndex, 1);
			return "followUp";
		}
		return undefined;
	}

	/** Clear all three queues (including the agent's own mirrored queues) and return what was cleared. */
	clear(): PendingQueueSnapshot {
		const result = this.snapshot();
		this._steeringMessages = [];
		this._followUpMessages = [];
		this._queuedExtensionCommands = [];
		this.deps.agent.clearAllQueues();
		return result;
	}
}
