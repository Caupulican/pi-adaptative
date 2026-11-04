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
}

/**
 * Owner-authored replacement of the session's whole system prompt, scoped to the session branch.
 *
 * The override is recorded on the active branch and read by the prompt builder on every build. This
 * controller owns the transitions: an owner edit or reset, and a branch change that brings another
 * override (or none). Each is a sanctioned break of the cached system prefix, and each writes the live
 * prompt directly, because a conditional refresh would skip a prompt an extension has modified.
 */
export class SessionSystemPromptController {
	private readonly deps: SessionSystemPromptControllerDeps;
	/** The override the live prompt currently reflects; a branch change matters only when it moves this. */
	private applied: string | undefined;

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
