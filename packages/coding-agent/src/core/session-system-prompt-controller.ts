import type { Api, Model } from "@caupulican/pi-ai";
import type { SessionManager } from "../kernel/node.ts";
import type { CacheCustody } from "./context/cache-custody.ts";
import { cacheLaneKey } from "./context/cache-observation-recorder.ts";
import {
	appendSessionSystemPromptOverride,
	readSessionSystemPromptOverride,
} from "./session-system-prompt-override.ts";
import type { SystemPromptBuilder } from "./system-prompt-builder.ts";

export interface SessionSystemPromptControllerDeps {
	builder: SystemPromptBuilder;
	getSessionManager(): Pick<SessionManager, "getLatestCustomEntryOnBranch" | "appendCustomEntry">;
	isStreaming(): boolean;
	getActiveToolNames(): string[];
	getModel(): Model<Api> | undefined;
	getCustody(): Pick<CacheCustody, "sanction">;
	/** The session's base prompt and the prompt the next request will send. */
	getPrompts(): { base: string; live: string };
	/** Makes `prompt` both the base and the live prompt. */
	installPrompt(prompt: string): void;
	/** Whether the foreground run in progress carries a third party's words (`RunTurnOrigin.authority`). */
	isThirdPartyRun(): boolean;
}

/** The variant of the session's prompt a request sent: the owner's, or the one with the owner's memory withheld. */
export type SystemPromptLineage = "owner" | "memory-withheld";

/**
 * Owner-authored replacement of the session's whole system prompt, scoped to the session branch.
 *
 * The override is recorded on the active branch and read by the prompt builder on every build. This
 * controller owns the transitions: an owner edit or reset, and a branch change that brings another
 * override (or none). Each is a sanctioned break of the cached system prefix, and each writes the live
 * prompt directly, because a conditional refresh would skip a prompt an extension has modified.
 *
 * It also owns the variant each request sends: the held prompt stays the owner's text, and a run that carries a third
 * party's words sends it with the owner's memory withheld (`forRequest`). Each switch between the two is sanctioned.
 */
export class SessionSystemPromptController {
	private readonly deps: SessionSystemPromptControllerDeps;
	/** The override the live prompt currently reflects; a branch change matters only when it moves this. */
	private applied: string | undefined;
	/** The lineage of the session's last foreground request. */
	private sentLineage: SystemPromptLineage | undefined;

	constructor(deps: SessionSystemPromptControllerDeps) {
		this.deps = deps;
		this.applied = this.get();
	}

	/** The active branch's override, or undefined when the generated prompt is in force. */
	get(): string | undefined {
		return readSessionSystemPromptOverride(this.deps.getSessionManager());
	}

	/** The generated prompt for the active tools, ignoring any override. */
	renderGenerated(): string {
		return this.deps.builder.renderGeneratedSystemPrompt(this.deps.getActiveToolNames());
	}

	/**
	 * Replaces the prompt with owner text, or resets to the generated prompt with `undefined`. The text is
	 * checked against the current model's prompt budget before anything is recorded, so a rejected edit
	 * leaves the session unchanged.
	 */
	set(text: string | undefined): void {
		if (this.deps.isStreaming()) throw new Error("The system prompt can only be edited while the session is idle.");
		if (text !== undefined) this.deps.builder.enforceSystemPromptBudget(text);
		appendSessionSystemPromptOverride(this.deps.getSessionManager(), text);
		this.apply(
			text === undefined ? "owner reset the session system prompt" : "owner edited the session system prompt",
		);
	}

	/**
	 * The system prompt a request sends for the held prompt `prompt` (installed as the agent's `projectSystemPrompt`):
	 * a run that carries a third party's words gets it with the owner's memory withheld, any other request the prompt
	 * itself. The authority is read when the request's context is taken, so a run whose authority changes mid-run sends
	 * the other variant from its next turn on.
	 */
	forRequest(prompt: string): string {
		return this.deps.isThirdPartyRun() ? this.deps.builder.withholdMemory(prompt) : prompt;
	}

	/** The lineage of a sent system prompt, read from the text itself. */
	lineageOf(systemPrompt: string): SystemPromptLineage {
		return this.deps.builder.isMemoryWithheld(systemPrompt) ? "memory-withheld" : "owner";
	}

	/**
	 * A foreground request is about to go out with `systemPrompt`: when its lineage differs from the previous
	 * request's, the switch is a sanctioned break of the cached system prefix, issued before the guard classifies it.
	 */
	observeRequest(systemPrompt: string, model: Model<Api>): void {
		const lineage = this.lineageOf(systemPrompt);
		const previous = this.sentLineage;
		this.sentLineage = lineage;
		if (previous === undefined || previous === lineage) return;
		this.deps
			.getCustody()
			.sanction(
				"system",
				lineage === "owner"
					? "the owner's run sends the owner's memory again"
					: "a run that carries a third party's words sends no owner memory",
				{ lane: cacheLaneKey(model.api, model.provider, model.id) },
			);
	}

	/** The active branch changed: re-apply only when it carries a different override than the live prompt reflects. */
	branchChanged(): void {
		if (this.get() !== this.applied) this.apply("session branch changed");
	}

	/** Makes the branch's override (or its absence) the live prompt. A rebuild equal to the live prompt does nothing. */
	private apply(reason: string): void {
		this.applied = this.get();
		const rebuilt = this.deps.builder.rebuildSystemPrompt(this.deps.getActiveToolNames());
		const { base, live } = this.deps.getPrompts();
		if (rebuilt === base && rebuilt === live) return;
		const model = this.deps.getModel();
		this.deps
			.getCustody()
			.sanction("system", reason, model ? { lane: cacheLaneKey(model.api, model.provider, model.id) } : {});
		this.deps.installPrompt(rebuilt);
	}
}
