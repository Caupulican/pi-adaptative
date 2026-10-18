/**
 * Owner request classification, optional-tool intent checkpointing, rule-authority and
 * local-commit delivery bindings, model-pool policy updates, and session edge grants.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { type CustomMessage, createCustomMessage } from "../kernel/messages.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import {
	type EdgeGrantDetails,
	enforceSessionEdgeOperation,
	recordEdgeGrant,
	recordEdgeRevoke,
	type SessionEdgeDeps,
	sessionEdgeGrants,
} from "./agent-session-edge.ts";
import {
	EDGE_CLASSES,
	EDGE_GRANT_CUSTOM_TYPE,
	EDGE_REVOKE_CUSTOM_TYPE,
	type EdgeClass,
	type EdgeConfirmationHandler,
	type EdgeGrantView,
	isEdgeOperationGranted,
} from "./autonomy/edge-policy.ts";
import type { createRetentionDecisionEngine } from "./compaction/retention-decision-engine.ts";
import type { ToolInfo } from "./extensions/index.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { RouterCandidatePool } from "./model-router/candidate-pool.ts";
import {
	describePolicy,
	latestPoolPolicy,
	MODEL_POOL_POLICY_CUSTOM_TYPE,
	MODEL_POOLS,
	type ModelPoolChange,
	type ModelPoolPolicy,
	OwnerModelPolicy,
} from "./model-router/owner-model-policy.ts";
import { isLocalOrManagedRouterModel } from "./model-router/tool-escalation.ts";
import {
	deliveryClassificationUnavailableNote,
	RULE_CONFLICT_NOTE,
	RULE_SETTLED_USER_NOTE,
	RULE_SETTLED_WRITTEN_NOTE,
	readHeadBranch,
	resolveDeliveryBinding,
	resolveRuleAuthority,
} from "./objective-execution/local-commit-delivery.ts";
import { mayHoldUnownedWorktreeChanges } from "./objective-execution/worktree-ownership.ts";
import type { DecisionLedgerStore } from "./operator-projection/decision-ledger-store.ts";
import {
	type OwnerRulePolicy,
	renderOwnerRulesForMission as renderDurableOwnerRulesForMission,
} from "./project-rules/durable-owner-rules.ts";
import type { SessionProjectRules } from "./project-rules/session-project-rules.ts";
import type { RuntimeBuilder } from "./runtime-builder.ts";
import type { SettingsManager } from "./settings-manager.ts";
import {
	normalizeUserRequest,
	type SystemOneController,
	USER_REQUEST_RULE_BUDGET,
	type UserRequestClassificationOutcome,
} from "./system-one/controller.ts";
import { OperationGate } from "./system-one/operation-gate.ts";
import { operationGateLedgerBindings } from "./system-one/operation-gate-wiring.ts";
import { OwnerPolicyQueue, type OwnerWords } from "./system-one/owner-policy-queue.ts";
import { appendOwnerFollowUp, ownerFollowUpPath } from "./system-one/owner-question-routing.ts";
import {
	MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS,
	OPTIONAL_TOOL_INTENT_CUSTOM_TYPE,
	type OptionalToolCandidate,
	type OptionalToolIntent,
	type OptionalToolRequestContext,
	optionalToolRequestAliases,
	readOptionalToolIntent,
} from "./tool-applicability-gate.ts";
import { shareTextBudget } from "./util/text-budget.ts";

/**
 * Abort reason of an owner intent classification replaced by a newer owner request. The newer request
 * owns the optional-tool intent chain, so that JUDGMENT is stale; the request it was judging is still the
 * owner's input, is still admitted, and its owner policy is still judged, alone, where the owner-policy
 * queue settles it. Any other abort (the owner's interrupt, disposal, the caller's signal) cancels the
 * submission itself.
 */
export const OWNER_INTENT_SUPERSEDED = new Error(
	"Owner intent classification was superseded by a newer owner request.",
);

export type OwnerRequestClassificationOutcome =
	| UserRequestClassificationOutcome
	| {
			readonly status: "unavailable";
			readonly cancelled: true;
			readonly contextChanged: boolean;
			readonly reason: string;
	  }
	| { readonly status: "unavailable"; readonly superseded: true; readonly reason: string };

function cancelledOutcome(contextChanged: boolean): OwnerRequestClassificationOutcome {
	return {
		status: "unavailable",
		cancelled: true,
		contextChanged,
		reason: contextChanged
			? "The session context changed while the owner request was classified"
			: "Owner intent classification was cancelled",
	};
}

/** What a judgment continuing an intent entry reads from it: the intent it continues, and the owner words still pending in it. */
function continuedIntent(intent: OptionalToolIntent | undefined): {
	readonly previous: OptionalToolIntent | undefined;
	readonly pending: readonly string[];
} {
	if (intent === undefined || intent.status === "classified") return { previous: intent, pending: [] };
	return { previous: intent.resumeIntent, pending: intent.pendingRequests ?? [] };
}

/** Owner words accepted with a submission order: their text, the session that accepted them, and whether they were delivered. */
interface RegisteredOwnerWords {
	readonly text: string;
	readonly sessionId: string;
	delivered: boolean;
}

/**
 * How one optional-tool intent entry this controller appended continues the chain: the entry it was judged on, and the
 * owner words (by submission order) it read beyond that entry.
 */
interface OptionalIntentLink {
	readonly previousId: string | undefined;
	/** The branch's latest entry when this one was appended: following it walks the branch back as it grew. */
	readonly after: string | undefined;
	readonly words: ReadonlyMap<number, string>;
	/**
	 * A restatement of `previousId` after a judgment that decided nothing: it holds the words that entry holds, and decides
	 * none.
	 */
	readonly restates?: true;
}

/** One session's committed optional-tool chain as this controller appended it. */
interface OptionalIntentChain {
	readonly sessionId: string;
	readonly links: Map<string, OptionalIntentLink>;
	/**
	 * Owner words an entry of the chain holds (decided, or pending in an unresolved entry), or that the screen found to carry
	 * no instruction: no further optional-tool judgment reads them.
	 */
	readonly covered: Set<number>;
}

/**
 * A queued owner input's optional-tool intent, judged before the input is admitted and not in force: it is appended to the
 * chain only once the input is delivered and every word it read is delivered too, and only while the chain it was judged on
 * gained nothing but words it read (`stagedIsStale`). An input taken back, cleared, held or superseded never appends it.
 */
interface StagedOptionalIntent {
	readonly order: number;
	readonly sessionId: string;
	/** The committed entry the judgment continues, through any staged judgment it read. */
	readonly baseId: string | undefined;
	/** Every owner word the intent read, its own included. */
	readonly words: ReadonlyMap<number, string>;
	/** The words among `words` that `baseId` already holds pending (an unresolved base): the intent read them from it. */
	readonly heldByBase: ReadonlyMap<number, string>;
	/** Paused while it is judged; then the classified intent, or the unresolved one that keeps its words pending. */
	record: OptionalToolIntent;
	judging?: AbortController;
}

export interface SessionEdgeIntentControllerDeps {
	getSessionManager(): SessionManager;
	getSettingsManager(): SettingsManager;
	getModelRegistry(): ModelRegistry;
	getCwd(): string;
	getAgentDir(): string;
	isChildSession(): boolean;
	isDisposed(): boolean;
	getReflectionAbortSignal(): AbortSignal;
	getSystemOneController(): SystemOneController | undefined;
	getSemanticDecisionEngine(): ReturnType<typeof createRetentionDecisionEngine> | undefined;
	getDecisionLedger(): DecisionLedgerStore | undefined;
	getCurrentSubmissionEpoch(): number | undefined;
	getLastUserRequest(): string;
	getOwnerRulePolicies(): readonly OwnerRulePolicy[];
	getProjectRules(): SessionProjectRules;
	getWrittenMutationPaths(): Iterable<string>;
	getAllTools(): ToolInfo[];
	getToolSourceInfo(toolName: string): ReturnType<RuntimeBuilder["getToolSourceInfo"]>;
	getRouterCandidatePool(): RouterCandidatePool;
	withTaskDirectoryContext<T>(
		fn: () => Promise<T>,
		signal?: AbortSignal,
		onUnavailable?: (error: unknown) => T,
	): Promise<T>;
	noteSystemOneTaskDirectoryUnavailable(error: unknown): void;
	pushPendingNextTurnMessage(message: CustomMessage): void;
	setOperatorBlocker(blocker: string | undefined): void;
	emitWarning(message: string): void;
}

export class SessionEdgeIntentController {
	private readonly deps: SessionEdgeIntentControllerDeps;
	readonly ownerPolicy: OwnerPolicyQueue<OwnerRequestClassificationOutcome>;
	readonly modelPolicy: OwnerModelPolicy;
	private poolPolicyRead?: { branchKey: string; policy: ModelPoolPolicy | undefined };
	private operationGateInstance?: OperationGate;
	private edgeConfirmation?: EdgeConfirmationHandler;
	/** The committed optional-tool judgment in flight (one at a time: the owner-policy queue runs them); its paused entry heads the chain. */
	private committedIntentAbort?: AbortController;
	/**
	 * Owner words accepted with a submission order and not yet held by the committed optional-tool chain. A turn's own words
	 * are judged where they are read (its first tool call), so a queued input judged before them reads them as
	 * `pending_owner_requests`; delivered words no committed entry holds are read by the next committed judgment. Words leave
	 * when an entry covers them (`coverOwnerWords`) or when they never become owner input (`releaseOwnerWords`).
	 */
	private readonly ownerWords = new Map<number, RegisteredOwnerWords>();
	/** The committed chain of the current session; replaced when the session changes. */
	private intentChain?: OptionalIntentChain;
	/** Queued inputs' optional-tool intents, by submission order, waiting for their delivery (`promoteDeliveredIntents`). */
	private readonly stagedIntents = new Map<number, StagedOptionalIntent>();
	/**
	 * The owner submission order that last decided each owner-policy axis (handoff, delivery, rule authority, each model
	 * pool). Owner words are applied where they are delivered, and a steer is delivered ahead of an older follow-up, so
	 * older words can be applied after newer ones: they then decide only what no newer owner words decided.
	 */
	private readonly ownerDecisionOrders = new Map<string, number>();
	private lastOptionalIntentWarning?: string;
	private localCommitBranchValue?: string;
	private ruleAuthorityValue: "unset" | "ask" | "user" | "written" = "unset";
	private deliveryClassificationUnavailable = false;
	/** The last owner-policy settle failure reported, so a failure that persists is reported once until a settle succeeds. */
	private lastOwnerPolicyFailure?: string;
	private handoffValue = false;

	constructor(deps: SessionEdgeIntentControllerDeps) {
		this.deps = deps;
		this.ownerPolicy = new OwnerPolicyQueue<OwnerRequestClassificationOutcome>({
			classify: async (words) => {
				const note = await this.deps.withTaskDirectoryContext(
					() => this.settleOwnerWords(words),
					words.signal,
					(error) => {
						this.deps.noteSystemOneTaskDirectoryUnavailable(error);
						return undefined;
					},
				);
				this.lastOwnerPolicyFailure = undefined;
				if (note) this.pushRequestAuthorityNote(note);
			},
			screen: async (texts, signal) => {
				const outcome = await this.deps.getSystemOneController()?.screenOwnerWords(texts, signal ? { signal } : {});
				return outcome?.status === "screened" ? outcome.carriesInstruction : undefined;
			},
			reportFailure: (error) => this.noteOwnerPolicyFailure(error),
			// The screen judged these words to carry no instruction: no optional-tool judgment needs to read them, and an intent
			// that read them holds nothing they decide.
			setAside: (words) => {
				if (words.acceptedOrder !== undefined) this.coverOwnerWords([words.acceptedOrder]);
			},
		});
		this.modelPolicy = new OwnerModelPolicy(
			{
				isSubscription: (model) => this.deps.getModelRegistry().isUsingSubscription(model),
				isLocal: (model) => isLocalOrManagedRouterModel(model),
			},
			{
				// Allocation asks per candidate model: read the branch once per branch position.
				read: () => {
					const sessionManager = this.deps.getSessionManager();
					const branchKey = `${sessionManager.getSessionId()}:${sessionManager.getLeafId() ?? ""}`;
					if (this.poolPolicyRead?.branchKey !== branchKey) {
						this.poolPolicyRead = { branchKey, policy: latestPoolPolicy(sessionManager.getBranch()) };
					}
					return this.poolPolicyRead.policy;
				},
				record: (record) => this.deps.getSessionManager().appendCustomEntry(MODEL_POOL_POLICY_CUSTOM_TYPE, record),
			},
		);
	}

	get handoff(): boolean {
		return this.handoffValue;
	}

	get ruleAuthority(): "unset" | "ask" | "user" | "written" {
		return this.ruleAuthorityValue;
	}

	localCommitBranch(): string | undefined {
		return this.localCommitBranchValue;
	}

	renderOwnerRulesForMission(): string {
		const base = renderDurableOwnerRulesForMission(this.deps.getOwnerRulePolicies());
		const lines = [base];
		if (this.localCommitBranchValue !== undefined) {
			const branch = this.localCommitBranchValue || "the current branch";
			lines.push(
				`LOCAL COMMIT DELIVERY: this task commits only on ${branch}. Do not push. Other branches and worktrees rebase locally onto ${branch}.`,
			);
		}
		if (this.ruleAuthorityValue === "ask") lines.push(RULE_CONFLICT_NOTE);
		if (this.ruleAuthorityValue === "user") {
			lines.push("RULE AUTHORITY: the user's request is above AGENTS.md and standing user rules for this task.");
		}
		return lines.filter((line) => line.length > 0).join("\n");
	}

	get operationGate(): OperationGate {
		this.operationGateInstance ??= new OperationGate({
			settleOwnerPolicy: (signal) => this.ownerPolicy.settle("latest", signal),
			getEngine: () => this.deps.getSemanticDecisionEngine(),
			getRequest: () => this.deps.getLastUserRequest(),
			getScopeCwd: () => this.deps.getCwd(),
			getTurnKey: () => `${this.deps.getCurrentSubmissionEpoch() ?? "idle"}\u0000${this.deps.getLastUserRequest()}`,
			isGranted: () =>
				isEdgeOperationGranted(
					{ class: "operation.irreversible", operation: "", reason: "" },
					this.getEdgeGrants(),
				),
			askOperator: async (operation, signal) =>
				enforceSessionEdgeOperation(this.edgeDeps(), operation, "operation", signal),
			notify: (message) => {
				if (!this.handoffValue) this.deps.emitWarning(message);
			},
			...operationGateLedgerBindings({
				getLedger: () => this.deps.getDecisionLedger(),
				getSessionId: () => this.deps.getSessionManager().getSessionId(),
				getCwd: () => this.deps.getCwd(),
			}),
		});
		return this.operationGateInstance;
	}

	edgeDeps(): SessionEdgeDeps {
		return {
			getMode: () => this.deps.getSettingsManager().getEdgeSettings().mode,
			getBranch: () => this.deps.getSessionManager().getBranch(),
			getEdgeRecords: () =>
				this.deps.getSessionManager().getCustomEntriesOnBranch([EDGE_GRANT_CUSTOM_TYPE, EDGE_REVOKE_CUSTOM_TYPE]),
			getSettingsAllow: () => this.deps.getSettingsManager().getEdgeSettings().allow,
			getDenyCommands: () => this.deps.getSettingsManager().getEdgeSettings().deny,
			appendCustomEntry: (customType, data) => this.deps.getSessionManager().appendCustomEntry(customType, data),
			getCwd: () => this.deps.getCwd(),
			isChildSession: () => this.deps.isChildSession(),
			getConfirmation: () => (this.handoffValue ? undefined : this.edgeConfirmation),
			deferOwnerOperation: (operation) => {
				if (!this.handoffValue || this.deps.isChildSession()) return undefined;
				return appendOwnerFollowUp(
					ownerFollowUpPath(this.deps.getAgentDir(), this.deps.getSessionManager().getSessionId()),
					{
						question: `Authorize ${operation.class}: ${operation.operation}?`,
						reason: operation.reason,
						request: this.deps.getLastUserRequest(),
						at: new Date().toISOString(),
					},
				);
			},
			mayHoldUnownedWorktreeChanges: (signal) =>
				mayHoldUnownedWorktreeChanges(this.deps.getCwd(), [...this.deps.getWrittenMutationPaths()], signal),
		};
	}

	setEdgeConfirmation(handler: EdgeConfirmationHandler | undefined): void {
		this.edgeConfirmation = handler;
	}

	getEdgeGrants(): EdgeGrantView[] {
		return sessionEdgeGrants(this.edgeDeps());
	}

	writtenRuleText(): string {
		const lines: string[] = [];
		const seen = new Set<string>();
		for (const rule of this.deps.getProjectRules().getRules()) {
			const source = rule.source.path.includes("AGENTS.md")
				? "AGENTS.md"
				: rule.source.path.startsWith("owner:")
					? "user rule"
					: rule.source.path;
			const line = `${source}: ${rule.text.replace(/\s+/g, " ").trim()}`;
			if (seen.has(line)) continue;
			seen.add(line);
			lines.push(line);
		}
		return shareTextBudget(lines, USER_REQUEST_RULE_BUDGET).join("\n");
	}

	private pushRequestAuthorityNote(note: string): void {
		this.deps.pushPendingNextTurnMessage(
			createCustomMessage("request_authority", note, false, undefined, new Date().toISOString()),
		);
	}

	/**
	 * A settle of the owner's words failed. The words are kept by the queue and settled again after the owner's next message
	 * or the evaluator's next successful answer (`OwnerPolicyQueue.wake`), so nothing blocks on them; until then their outcome
	 * is unknown, which is treated like an evaluator outage: no handoff, and the model is told once per outage that a
	 * delivery limit the owner stated was not registered.
	 */
	private noteOwnerPolicyFailure(error: unknown): void {
		const reason = error instanceof Error ? error.message : String(error);
		this.handoffValue = false;
		if (reason !== this.lastOwnerPolicyFailure) {
			this.lastOwnerPolicyFailure = reason;
			this.deps.emitWarning(
				`The owner's words were not classified: ${reason}. They are kept and classified again after the owner's next message or System One's next successful answer.`,
			);
		}
		if (this.deliveryClassificationUnavailable) return;
		this.deliveryClassificationUnavailable = true;
		this.pushRequestAuthorityNote(deliveryClassificationUnavailableNote(reason, this.localCommitBranchValue));
	}

	private capabilitiesPending(): boolean {
		const granted = new Set(this.getEdgeGrants().map((grant) => grant.class));
		return EDGE_CLASSES.some((edgeClass) => !granted.has(edgeClass));
	}

	/**
	 * The one way owner words join the owner-policy queue, where they are delivered. Words judged when they were submitted (a
	 * queued steer, follow-up or prompt) carry that judgment and are applied as judged, in owner order, where the queue
	 * settles; they are never screened or judged again. A superseded judgment is carried too, so its words are not screened:
	 * the newer request took only the optional-tool chain from it, and the queue judges these words' owner policy alone, once,
	 * where it settles them. Words with no judgment, or one the evaluator could not give (an outage), are screened and
	 * classified at the queue. Delivered words are owner input: a staged optional-tool intent that waited for them is
	 * appended to the chain now (`promoteDeliveredIntents`).
	 */
	enqueueOwnerWords(
		text: string,
		acceptedOrder: number | undefined,
		judgment: OwnerRequestClassificationOutcome | undefined,
		signal?: AbortSignal,
	): void {
		if (!this.deps.getSystemOneController()) return;
		if (acceptedOrder !== undefined) {
			const registered = this.ownerWords.get(acceptedOrder);
			if (registered) registered.delivered = true;
			this.promoteDeliveredIntents();
		}
		const carried =
			judgment !== undefined &&
			(judgment.status === "classified" || ("superseded" in judgment && judgment.superseded === true));
		this.ownerPolicy.enqueue({
			text,
			...(acceptedOrder !== undefined ? { acceptedOrder } : {}),
			...(signal ? { signal } : {}),
			...(carried ? { judgment } : {}),
		});
	}

	/**
	 * Owner words accepted with this submission order: they wait here until a committed optional-tool entry holds them.
	 * Called where the order is assigned, before anything can await, so no judgment of newer words can start without seeing
	 * them. With no evaluator nothing is ever judged, so nothing is recorded; blank words decide nothing, so none reads them.
	 */
	registerOwnerWords(acceptedOrder: number, text: string): void {
		if (!this.deps.getSystemOneController() || normalizeUserRequest(text) === undefined) return;
		this.ownerWords.set(acceptedOrder, {
			text,
			sessionId: this.deps.getSessionManager().getSessionId(),
			delivered: false,
		});
	}

	/**
	 * These owner words never become owner input (withdrawn, cancelled, handled, or taken back, cleared or held before their
	 * delivery): no judgment reads them, and the optional-tool intent judged for them is dropped with them.
	 */
	releaseOwnerWords(acceptedOrder: number | undefined): void {
		if (acceptedOrder === undefined) return;
		this.ownerWords.delete(acceptedOrder);
		this.stagedIntents.delete(acceptedOrder);
	}

	/** An optional-tool entry of the committed chain holds these words: no later judgment reads them again. */
	private coverOwnerWords(orders: Iterable<number>): void {
		const covered = this.chain().covered;
		for (const order of orders) {
			covered.add(order);
			this.ownerWords.delete(order);
		}
	}

	private chain(): OptionalIntentChain {
		const sessionId = this.deps.getSessionManager().getSessionId();
		if (this.intentChain?.sessionId !== sessionId) {
			this.intentChain = { sessionId, links: new Map(), covered: new Set() };
		}
		return this.intentChain;
	}

	/**
	 * Registered words of the current session older than `below`, that no committed entry holds and `exclude` does not name,
	 * oldest first; `deliveredOnly` keeps the delivered ones. Words accepted in another session never join this session's
	 * judgment and are dropped.
	 */
	private registeredWords(
		below: number,
		exclude: ReadonlyMap<number, string>,
		deliveredOnly: boolean,
	): Array<[number, string]> {
		const sessionId = this.deps.getSessionManager().getSessionId();
		const read: Array<[number, string]> = [];
		for (const [order, words] of this.ownerWords) {
			if (words.sessionId !== sessionId) this.ownerWords.delete(order);
			else if (order < below && !exclude.has(order) && (words.delivered || !deliveredOnly))
				read.push([order, words.text]);
		}
		return read.sort((left, right) => left[0] - right[0]);
	}

	/**
	 * Whether the chain from `headId` back to `baseId` gained only entries that read nothing but `words`: an intent judged on
	 * `baseId` that read those words then describes the head too. An entry this controller did not append (an earlier
	 * process, another branch) is unknown, so no such intent describes the head.
	 */
	private chainReaches(
		headId: string | undefined,
		baseId: string | undefined,
		words: ReadonlyMap<number, string>,
	): boolean {
		const links = this.chain().links;
		let id = headId;
		while (id !== baseId) {
			const link = id === undefined ? undefined : links.get(id);
			if (link === undefined) return false;
			for (const order of link.words.keys()) if (!words.has(order)) return false;
			id = link.previousId;
		}
		return true;
	}

	/**
	 * Whether the branch's optional-tool entries from `fromId` up to `headId` are all entries this controller appended there,
	 * one after another: the branch only grew. A switch to another branch or session finds an entry it did not append.
	 */
	private chainDescends(headId: string | undefined, fromId: string | undefined): boolean {
		const links = this.chain().links;
		let id = headId;
		while (id !== fromId) {
			const link = id === undefined ? undefined : links.get(id);
			if (link === undefined) return false;
			id = link.after;
		}
		return true;
	}

	/**
	 * A staged intent is `stale` once it can never describe the chain: another session, a word it read never became owner
	 * input, its own words are already held by the chain, or the chain gained an entry that read words it did not.
	 */
	private stagedIsStale(staged: StagedOptionalIntent, sessionId: string, headId: string | undefined): boolean {
		const chain = this.chain();
		return (
			staged.sessionId !== sessionId ||
			chain.covered.has(staged.order) ||
			[...staged.words.keys()].some((order) => !chain.covered.has(order) && !this.ownerWords.has(order)) ||
			!this.chainReaches(headId, staged.baseId, staged.words)
		);
	}

	/**
	 * Appends each staged optional-tool intent whose words are all delivered now, newest first, and drops the stale ones. An
	 * intent appended this way already read every older word an older staged intent read, so that one is stale after it.
	 * Never while a committed judgment is in flight: its paused entry heads the chain until it settles.
	 */
	private promoteDeliveredIntents(): void {
		if (this.committedIntentAbort !== undefined || this.stagedIntents.size === 0) return;
		const manager = this.deps.getSessionManager();
		const sessionId = manager.getSessionId();
		const chain = this.chain();
		for (const staged of [...this.stagedIntents.values()].sort((left, right) => right.order - left.order)) {
			if (this.stagedIntents.get(staged.order) !== staged) continue;
			const headId = manager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.id;
			// A judgment still in flight keeps its place: its input is admitted on its outcome, and only delivery commits it.
			if (staged.judging) continue;
			if (this.stagedIsStale(staged, sessionId, headId)) {
				this.stagedIntents.delete(staged.order);
				continue;
			}
			if (
				![...staged.words.keys()].every(
					(order) => chain.covered.has(order) || this.ownerWords.get(order)?.delivered,
				)
			)
				continue;
			const id = manager.appendCustomEntry(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE, staged.record);
			const read = new Map([...staged.words].filter(([order]) => !staged.heldByBase.has(order)));
			chain.links.set(id, { previousId: headId, after: headId, words: read });
			this.coverOwnerWords(staged.words.keys());
			this.stagedIntents.delete(staged.order);
		}
	}

	private optionalToolCandidates(): OptionalToolCandidate[] {
		return this.deps.getAllTools().flatMap((tool) => {
			const source = this.deps.getToolSourceInfo(tool.name);
			const aliases = optionalToolRequestAliases(tool.name, source);
			return aliases ? [{ toolName: tool.name, sourcePath: source?.path ?? "", aliases }] : [];
		});
	}

	/** One System One judgment of owner words, resolved as unavailable as soon as `signals` or the reflection lane abort. */
	private async askOwnerIntent(
		controller: SystemOneController,
		request: string,
		rules: string,
		options: {
			readonly capabilitiesPending: boolean;
			readonly optionalTools: OptionalToolRequestContext;
			readonly optionalToolsOnly?: boolean;
		},
		signals: ReadonlyArray<AbortSignal | undefined>,
	): Promise<UserRequestClassificationOutcome> {
		const signal = AbortSignal.any([
			this.deps.getReflectionAbortSignal(),
			...signals.filter((candidate): candidate is AbortSignal => candidate !== undefined),
		]);
		const classification = controller.classifyUserRequest(request, rules, { ...options, signal });
		// An aborted judgment decides nothing, so its request does not wait for the evaluator to notice.
		classification.catch(() => undefined);
		let stopWatchingAbort = (): void => {};
		try {
			return await Promise.race([
				classification,
				new Promise<UserRequestClassificationOutcome>((resolve) => {
					const settle = () =>
						resolve({ status: "unavailable", reason: "Owner intent classification was aborted" });
					if (signal.aborted) return settle();
					signal.addEventListener("abort", settle, { once: true });
					stopWatchingAbort = () => signal.removeEventListener("abort", settle);
				}),
			]);
		} finally {
			stopWatchingAbort();
		}
	}

	/** The classified optional-tool intent of a judgment, or the warning that the integrations stay available without one. */
	private classifiedIntentOf(
		outcome: UserRequestClassificationOutcome,
		candidates: readonly OptionalToolCandidate[],
	): OptionalToolIntent | undefined {
		const intent =
			outcome.status === "classified" && outcome.classification.optionalToolIntent?.status === "classified"
				? outcome.classification.optionalToolIntent
				: undefined;
		if (intent) {
			this.lastOptionalIntentWarning = undefined;
			return intent;
		}
		// No usable judgment is not an owner decision: the unclassified words stay pending for the next classification, and
		// the integrations stay available.
		const warning = `Optional integrations stay available; owner intent for them was not classified: ${outcome.status === "unavailable" ? outcome.reason : "the judgment was uncertain"}.`;
		if (candidates.length && warning !== this.lastOptionalIntentWarning) {
			this.lastOptionalIntentWarning = warning;
			this.deps.emitWarning(warning);
		}
		return undefined;
	}

	/**
	 * The full classification of a queued owner input's words (written rules and still-pending capabilities included), once,
	 * before it is admitted. Its owner policy is carried into the owner-policy queue and applied there in owner order
	 * (`applyOwnerRequestOutcome`), never asked again. Its optional-tool intent is staged, never written: it continues the
	 * newest staged intent of older words (superseding that one's judgment if it is still in flight), else the committed
	 * chain, reads every older registered word neither holds, and is appended only when the input is delivered
	 * (`promoteDeliveredIntents`). A taken back, cleared or held input appends nothing.
	 */
	async judgeOwnerRequest(
		request: string,
		signal?: AbortSignal,
		acceptedOrder?: number,
	): Promise<OwnerRequestClassificationOutcome> {
		const rules = this.writtenRuleText();
		const capabilitiesPending = this.capabilitiesPending();
		if (signal?.aborted || this.deps.isDisposed()) return cancelledOutcome(false);
		// Without a submission order the words cannot be staged against the owner's other words: their optional-tool intent
		// is judged where they are delivered (the owner-policy queue), and only their owner policy is judged now.
		if (acceptedOrder === undefined) return this.judgeOwnerPolicy(request, rules, capabilitiesPending, signal);
		// Normal-off: no evaluator means no semantic intent is staged, aborted, scanned or warned about.
		const controller = this.deps.getSystemOneController();
		if (!controller) return { status: "skipped" };
		// A blank message carries no request to classify, so no intent is staged for it.
		if (normalizeUserRequest(request) === undefined) return { status: "skipped" };
		const manager = this.deps.getSessionManager();
		const sessionId = manager.getSessionId();
		const head = manager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE);
		let tip: StagedOptionalIntent | undefined;
		for (const staged of this.stagedIntents.values()) {
			if (staged.order >= acceptedOrder || (tip !== undefined && staged.order < tip.order)) continue;
			if (!this.stagedIsStale(staged, sessionId, head?.id)) tip = staged;
		}
		// The newer words own the optional-tool chain from here: an older judgment still in flight is stale, and its words
		// are read here from its paused record.
		tip?.judging?.abort(OWNER_INTENT_SUPERSEDED);
		this.stagedIntents.get(acceptedOrder)?.judging?.abort(OWNER_INTENT_SUPERSEDED);
		const snapshot = tip ? tip.record : readOptionalToolIntent(head?.data);
		const baseWords: ReadonlyMap<number, string> = tip
			? tip.words
			: snapshot !== undefined && snapshot.status !== "classified" && head !== undefined
				? (this.chain().links.get(head.id)?.words ?? new Map())
				: new Map();
		const { previous, pending } = continuedIntent(snapshot);
		// Older owner words no judgment has read yet (a turn's own words, judged only where its first tool call reads them,
		// or an older queued input) are read before these, in owner order.
		const carried = this.registeredWords(acceptedOrder, baseWords, false);
		const priorRequests = [...pending, ...carried.map(([, text]) => text)];
		const recoverable =
			request.length <= MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS &&
			priorRequests.length < 8 &&
			carried.every(([, text]) => text.length <= MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS);
		const pausedIntent: OptionalToolIntent = {
			version: 1,
			status: "paused",
			taskRequest: request.slice(0, MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS),
			allowedTools: [],
			...(recoverable
				? { ...(previous ? { resumeIntent: previous } : {}), pendingRequests: [...priorRequests, request] }
				: {}),
		};
		const judging = new AbortController();
		const staged: StagedOptionalIntent = {
			order: acceptedOrder,
			sessionId,
			baseId: tip ? tip.baseId : head?.id,
			words: new Map<number, string>([...baseWords, ...carried, [acceptedOrder, request]]),
			heldByBase: tip ? tip.heldByBase : baseWords,
			record: pausedIntent,
			judging,
		};
		this.stagedIntents.set(acceptedOrder, staged);
		const candidates = this.optionalToolCandidates();
		const outcome = await this.askOwnerIntent(
			controller,
			request,
			rules,
			{
				capabilitiesPending,
				optionalTools: {
					candidates,
					previous: recoverable ? previous : undefined,
					pendingRequests: recoverable ? priorRequests : [],
				},
			},
			[judging.signal, signal],
		);
		staged.judging = undefined;
		const current = this.stagedIntents.get(acceptedOrder) === staged;
		if (
			signal?.aborted ||
			this.deps.getReflectionAbortSignal().aborted ||
			(judging.signal.aborted && judging.signal.reason !== OWNER_INTENT_SUPERSEDED) ||
			this.deps.isDisposed()
		) {
			if (current) this.stagedIntents.delete(acceptedOrder);
			return cancelledOutcome(false);
		}
		// A newer owner request owns the optional-tool chain now: this stale judgment stages nothing, but its request
		// remains owner input for the caller to admit, and its owner policy is judged at the queue.
		if (judging.signal.aborted || !current) {
			if (current) this.stagedIntents.delete(acceptedOrder);
			return {
				status: "unavailable",
				superseded: true,
				reason: "Owner intent classification was superseded by a newer owner request",
			};
		}
		// The session or branch moved under the judgment: its request belongs to the old context, not the new one.
		if (
			manager.getSessionId() !== sessionId ||
			!this.chainDescends(manager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.id, head?.id)
		) {
			this.stagedIntents.delete(acceptedOrder);
			return cancelledOutcome(true);
		}
		staged.record = this.classifiedIntentOf(outcome, candidates) ?? { ...pausedIntent, status: "unresolved" };
		return outcome;
	}

	async enableCapabilitiesAuthorizedByUser(
		request: string,
		signal?: AbortSignal,
		trustedOwner = true,
		acceptedOrder?: number,
	): Promise<string | undefined> {
		const controller = this.deps.getSystemOneController();
		if (!controller) return undefined;
		// The owner's words are settled as delivered words are: their optional-tool intent is committed now.
		if (trustedOwner) return this.settleOwnerWords({ text: request, acceptedOrder, ...(signal ? { signal } : {}) });
		const outcome = await controller.classifyUserRequest(request, this.writtenRuleText(), {
			capabilitiesPending: this.capabilitiesPending(),
			...(signal ? { signal } : {}),
		});
		return this.applyOwnerRequestOutcome(request, outcome, acceptedOrder);
	}

	/**
	 * Settles delivered owner words where the owner-policy queue reaches them, in owner order. An optional-tool entry that
	 * already holds them (their own staged intent, or a newer one that read them) leaves only their owner policy: the
	 * judgment they carry, or one asked for it alone. Otherwise their optional-tool intent is judged into the committed chain
	 * now, with their owner policy when they carry none (`judgeCommittedIntent`).
	 */
	private async settleOwnerWords(words: OwnerWords<OwnerRequestClassificationOutcome>): Promise<string | undefined> {
		if (!this.deps.getSystemOneController()) return undefined;
		this.promoteDeliveredIntents();
		const carried = words.judgment;
		// A superseded judgment judged none of these words' owner policy: it is judged here.
		const judgment = carried !== undefined && !("superseded" in carried && carried.superseded) ? carried : undefined;
		const order = words.acceptedOrder;
		const rules = this.writtenRuleText();
		const capabilitiesPending = this.capabilitiesPending();
		if (order !== undefined && this.chain().covered.has(order)) {
			return this.applyOwnerRequestOutcome(
				words.text,
				judgment ?? (await this.judgeOwnerPolicy(words.text, rules, capabilitiesPending, words.signal)),
				order,
			);
		}
		const committed = await this.judgeCommittedIntent(
			words.text,
			order,
			judgment === undefined ? { rules, capabilitiesPending } : undefined,
			words.signal,
		);
		if (committed.ownPolicy) return this.applyOwnerRequestOutcome(words.text, committed.outcome, order);
		if (judgment !== undefined) return this.applyOwnerRequestOutcome(words.text, judgment, order);
		// A cancelled judgment is reported as such; otherwise the words' owner policy is judged alone.
		if ("cancelled" in committed.outcome && committed.outcome.cancelled)
			return this.applyOwnerRequestOutcome(words.text, committed.outcome, order);
		return this.applyOwnerRequestOutcome(
			words.text,
			await this.judgeOwnerPolicy(words.text, rules, capabilitiesPending, words.signal),
			order,
		);
	}

	/**
	 * Whether owner words of this submission order still decide `axis` where they are applied, recording them as its newest
	 * decider when they do: older words applied after newer ones decide only what no newer owner words decided. Words with
	 * no submission order (not the owner's) decide as they apply.
	 */
	private decidesOwnerAxis(axis: string, acceptedOrder: number | undefined): boolean {
		if (acceptedOrder === undefined) return true;
		if (acceptedOrder < (this.ownerDecisionOrders.get(axis) ?? 0)) return false;
		this.ownerDecisionOrders.set(axis, acceptedOrder);
		return true;
	}

	/**
	 * Applies one classification of the owner's words: handoff, model pools, delivery binding, rule authority and the
	 * capabilities it authorizes, each only where no newer owner words already decided it (`decidesOwnerAxis`). Returns the
	 * one line the model should see, and nothing when there is nothing to say.
	 */
	async applyOwnerRequestOutcome(
		request: string,
		outcome: OwnerRequestClassificationOutcome,
		acceptedOrder?: number,
	): Promise<string | undefined> {
		const controller = this.deps.getSystemOneController();
		if (!controller) return undefined;
		if (outcome.status === "skipped") return undefined;
		// A superseded judgment holds no owner policy, and is not an evaluator outage: the owner-policy queue judges those
		// words' policy itself (see its `classify`), so this judgment is never applied in its place.
		if ("superseded" in outcome && outcome.superseded) return undefined;
		if (outcome.status === "unavailable") {
			// Unknown is not a handoff: an owner question goes to the owner.
			if (this.decidesOwnerAxis("handoff", acceptedOrder)) this.handoffValue = false;
			// The binding is left exactly as it was -- but a silent "nothing changed" would read as a
			// classified "the user imposed nothing", which is how a stated no-push limit gets lost.
			// The model is told the limit was not registered so it honours the request itself. Once
			// per outage, not once per turn: the note stays true while the outage lasts, and
			// re-appending it every turn is the trailing-record churn the append-only prefix avoids.
			const firstOfOutage = !this.deliveryClassificationUnavailable;
			this.deliveryClassificationUnavailable = true;
			return firstOfOutage
				? deliveryClassificationUnavailableNote(outcome.reason, this.localCommitBranchValue)
				: undefined;
		}
		this.deliveryClassificationUnavailable = false;
		const classified = outcome.classification;
		if (this.decidesOwnerAxis("handoff", acceptedOrder)) this.handoffValue = classified.fullHandoff;
		if (classified.mayChangeModelPools) await this.applyModelPoolChange(controller, request, acceptedOrder);
		// Delivery is decided only by words that block or lift it; words that do neither keep the binding as it is.
		if (
			classified.localCommitsOnly !== classified.liftsDeliveryBlock &&
			this.decidesOwnerAxis("delivery", acceptedOrder)
		) {
			this.localCommitBranchValue = resolveDeliveryBinding(
				this.localCommitBranchValue,
				{ blocksPush: classified.localCommitsOnly, liftsPushBlock: classified.liftsDeliveryBlock },
				readHeadBranch(this.deps.getCwd()),
			);
		}
		const decidesRules = this.decidesOwnerAxis("rule_authority", acceptedOrder);
		if (decidesRules) this.ruleAuthorityValue = resolveRuleAuthority(classified);
		if (classified.capabilitiesAuthorized) {
			// Read where the outcome applies: a judgment applied later than it was made grants only what is still off.
			const granted = new Set(this.getEdgeGrants().map((grant) => grant.class));
			for (const edgeClass of EDGE_CLASSES) {
				if (edgeClass === "git.publish" && this.localCommitBranchValue !== undefined) continue;
				if (granted.has(edgeClass)) continue;
				this.grantEdge(edgeClass, "operator", { note: "explicit user request" });
			}
		}
		// The rule notes speak for the words that decided rule authority; newer owner words already said theirs.
		if (!decidesRules) return undefined;
		if (this.ruleAuthorityValue === "ask") return RULE_CONFLICT_NOTE;
		if (classified.fullHandoff && classified.rulesDiffer) {
			return this.ruleAuthorityValue === "user" ? RULE_SETTLED_USER_NOTE : RULE_SETTLED_WRITTEN_NOTE;
		}
		return undefined;
	}

	/**
	 * Judges delivered owner words into the committed optional-tool chain, now. The judgment continues the chain's head and
	 * reads, before these words and in owner order, every older delivered word no committed entry holds. Words older than an
	 * entry already in the chain (a follow-up delivered after a newer steer) rebuild that part of the chain: the newest words
	 * are judged again with every older word pending before them, so a late older word never replaces a newer decision, and
	 * if that judgment fails the head is restated and the older words wait for the next one. `policy` asks the owner-policy
	 * questions too; `ownPolicy` says whether the outcome answered them for these words (a rebuild judges the newest words'
	 * optional tools only). A cancelled judgment withdraws its own words and restores the head it found.
	 */
	private async judgeCommittedIntent(
		request: string,
		acceptedOrder: number | undefined,
		policy: { readonly rules: string; readonly capabilitiesPending: boolean } | undefined,
		signal: AbortSignal | undefined,
	): Promise<{ readonly outcome: OwnerRequestClassificationOutcome; readonly ownPolicy: boolean }> {
		if (signal?.aborted || this.deps.isDisposed()) {
			this.releaseOwnerWords(acceptedOrder);
			return { outcome: cancelledOutcome(false), ownPolicy: false };
		}
		// Normal-off: no evaluator means no semantic intent is recorded, aborted, scanned or warned about.
		const controller = this.deps.getSystemOneController();
		if (!controller) return { outcome: { status: "skipped" }, ownPolicy: policy !== undefined };
		// A blank message carries no request to classify, so no intent state is written for it.
		if (normalizeUserRequest(request) === undefined) {
			if (acceptedOrder !== undefined) this.coverOwnerWords([acceptedOrder]);
			return { outcome: { status: "skipped" }, ownPolicy: policy !== undefined };
		}
		const manager = this.deps.getSessionManager();
		const sessionId = manager.getSessionId();
		const chain = this.chain();
		const head = manager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE);
		const headIntent = readOptionalToolIntent(head?.data);
		const rebuild = acceptedOrder !== undefined ? this.rebuildBase(head?.id, acceptedOrder) : undefined;
		const rebuiltWords: ReadonlyMap<number, string> = rebuild?.words ?? new Map();
		// Words an unresolved head holds pending are read from it, never a second time from the registry.
		const headWords: ReadonlyMap<number, string> =
			head !== undefined && headIntent !== undefined && headIntent.status !== "classified"
				? (chain.links.get(head.id)?.words ?? new Map())
				: new Map();
		// Words without a submission order read no other owner words.
		const carried =
			acceptedOrder === undefined
				? []
				: this.registeredWords(
						Math.max(acceptedOrder, ...rebuiltWords.keys()),
						rebuild ? rebuiltWords : headWords,
						true,
					).filter(([order]) => order !== acceptedOrder);
		const ordered = [
			...rebuiltWords,
			...carried,
			...(acceptedOrder !== undefined ? [[acceptedOrder, request] as const] : []),
		].sort((left, right) => left[0] - right[0]);
		const words = new Map<number, string>(ordered);
		const judged = ordered.at(-1)?.[1] ?? request;
		const older = ordered.slice(0, -1).map(([, text]) => text);
		const { previous, pending } = continuedIntent(rebuild ? this.intentAt(rebuild.baseId) : headIntent);
		const priorRequests = [...pending, ...older];
		const recoverable =
			judged.length <= MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS &&
			priorRequests.length < 8 &&
			older.every((text) => text.length <= MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS);
		// While the judgment runs, the intent in force at the head stays in force.
		const inForce = continuedIntent(headIntent).previous;
		const pausedIntent: OptionalToolIntent = {
			version: 1,
			status: "paused",
			taskRequest: judged.slice(0, MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS),
			allowedTools: [],
			...(recoverable
				? { ...(inForce ? { resumeIntent: inForce } : {}), pendingRequests: [...priorRequests, judged] }
				: {}),
		};
		this.committedIntentAbort?.abort(OWNER_INTENT_SUPERSEDED);
		const intentAbort = new AbortController();
		this.committedIntentAbort = intentAbort;
		const pausedId = manager.appendCustomEntry(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE, pausedIntent);
		chain.links.set(pausedId, { previousId: head?.id, after: head?.id, words });
		const candidates = this.optionalToolCandidates();
		let outcome: UserRequestClassificationOutcome;
		try {
			outcome = await this.askOwnerIntent(
				controller,
				judged,
				policy?.rules ?? this.writtenRuleText(),
				{
					capabilitiesPending: policy?.capabilitiesPending ?? this.capabilitiesPending(),
					optionalTools: {
						candidates,
						previous: recoverable ? previous : undefined,
						pendingRequests: recoverable ? priorRequests : [],
					},
					optionalToolsOnly: policy === undefined || rebuild !== undefined,
				},
				[intentAbort.signal, signal],
			);
		} finally {
			if (this.committedIntentAbort === intentAbort) this.committedIntentAbort = undefined;
		}
		// The head as the judgment found it, restated: words a judgment left pending stay pending, unresolved, since nothing
		// judges them now.
		const restateHead = (): void => {
			const unsettled = headIntent !== undefined && headIntent.status !== "classified";
			const restoredId = manager.appendCustomEntry(
				OPTIONAL_TOOL_INTENT_CUSTOM_TYPE,
				headIntent === undefined
					? { version: 1, status: "unresolved", taskRequest: "", allowedTools: [] }
					: unsettled
						? { ...headIntent, status: "unresolved" }
						: headIntent,
			);
			chain.links.set(restoredId, {
				previousId: head?.id,
				after: pausedId,
				words: unsettled && head ? (chain.links.get(head.id)?.words ?? new Map()) : new Map(),
				restates: true,
			});
		};
		const latestIsPaused = () =>
			manager.getSessionId() === sessionId &&
			manager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.id === pausedId;
		const superseded = intentAbort.signal.aborted && intentAbort.signal.reason === OWNER_INTENT_SUPERSEDED;
		// A cancelled classification is no longer in flight and decided nothing: the intent stands as it found it.
		if (
			(signal?.aborted || this.deps.getReflectionAbortSignal().aborted || intentAbort.signal.aborted) &&
			latestIsPaused()
		)
			restateHead();
		if (
			signal?.aborted ||
			this.deps.getReflectionAbortSignal().aborted ||
			(intentAbort.signal.aborted && !superseded) ||
			this.deps.isDisposed()
		) {
			// Its own words were withdrawn with it; the older words it read wait for the next judgment again.
			this.releaseOwnerWords(acceptedOrder);
			return { outcome: cancelledOutcome(false), ownPolicy: false };
		}
		// A newer judgment owns the chain and reads these words from the registry: their owner policy is judged alone.
		if (superseded)
			return {
				outcome: {
					status: "unavailable",
					superseded: true,
					reason: "Owner intent classification was superseded by a newer owner request",
				},
				ownPolicy: false,
			};
		// No newer judgment replaced this one, yet its paused entry is no longer the branch's latest: the session or branch
		// moved under it. Its words belong to the old context, not the new one.
		if (!latestIsPaused()) return { outcome: cancelledOutcome(true), ownPolicy: false };
		const classifiedIntent = this.classifiedIntentOf(outcome, candidates);
		if (rebuild !== undefined && classifiedIntent === undefined) {
			// The newer decision stays in force; the older words stay uncovered for the next judgment to read.
			restateHead();
		} else {
			const id = manager.appendCustomEntry(
				OPTIONAL_TOOL_INTENT_CUSTOM_TYPE,
				classifiedIntent ?? { ...pausedIntent, status: "unresolved" },
			);
			chain.links.set(id, { previousId: rebuild ? rebuild.baseId : pausedId, after: pausedId, words });
			this.coverOwnerWords(words.keys());
		}
		this.promoteDeliveredIntents();
		return { outcome, ownPolicy: policy !== undefined && rebuild === undefined };
	}

	/**
	 * Where a judgment of words with this submission order continues the chain: below every entry, from the head down,
	 * that holds newer words, with the words those entries hold. Restatements are passed through; the first other entry
	 * that holds no newer word (only older words, or none: a judgment of words without an order) ends the walk, so no
	 * decision above it is discarded. Nothing when no entry holds newer words.
	 */
	private rebuildBase(
		headId: string | undefined,
		acceptedOrder: number,
	): { readonly baseId: string | undefined; readonly words: ReadonlyMap<number, string> } | undefined {
		const links = this.chain().links;
		const words = new Map<number, string>();
		let baseId: string | undefined;
		let found = false;
		let id = headId;
		while (id !== undefined) {
			const link = links.get(id);
			if (link === undefined) break;
			if (!link.restates) {
				if (![...link.words.keys()].some((order) => order > acceptedOrder)) break;
				for (const [order, text] of link.words) words.set(order, text);
				found = true;
				baseId = link.previousId;
			}
			id = link.previousId;
		}
		return found ? { baseId, words } : undefined;
	}

	private intentAt(id: string | undefined): OptionalToolIntent | undefined {
		const entry = id === undefined ? undefined : this.deps.getSessionManager().getEntry(id);
		return entry?.type === "custom" && entry.customType === OPTIONAL_TOOL_INTENT_CUSTOM_TYPE
			? readOptionalToolIntent(entry.data)
			: undefined;
	}

	/**
	 * The owner-policy judgment of owner words, without the optional-tool chain: no optional tool is asked, and nothing
	 * of the optional-tool intent (its entries, the staged and in-flight judgments, the registered words) is read or
	 * written, so the chain stays as it is. A cancellation or a session switch while it runs is reported as
	 * `judgeCommittedIntent` reports it.
	 */
	private async judgeOwnerPolicy(
		request: string,
		rules: string,
		capabilitiesPending: boolean,
		signal?: AbortSignal,
	): Promise<OwnerRequestClassificationOutcome> {
		const controller = this.deps.getSystemOneController();
		if (!controller) return { status: "skipped" };
		const sessionId = this.deps.getSessionManager().getSessionId();
		const outcome = await controller.classifyUserRequest(request, rules, {
			capabilitiesPending,
			signal: AbortSignal.any([this.deps.getReflectionAbortSignal(), ...(signal ? [signal] : [])]),
		});
		if (signal?.aborted || this.deps.getReflectionAbortSignal().aborted || this.deps.isDisposed())
			return cancelledOutcome(false);
		if (this.deps.getSessionManager().getSessionId() !== sessionId) return cancelledOutcome(true);
		return outcome;
	}

	async applyModelPoolChange(controller: SystemOneController, request: string, acceptedOrder?: number): Promise<void> {
		let evaluated: Awaited<ReturnType<SystemOneController["evaluateModelPools"]>>;
		try {
			evaluated = await controller.evaluateModelPools(request);
		} catch (error) {
			this.deps.emitWarning(
				`Model policy not changed: System One could not read the request (${error instanceof Error ? error.message : String(error)})`,
			);
			return;
		}
		// Only models that can actually run count: a pool that is on but has no authenticated model, or
		// a local runtime that is off, allocates nothing.
		const runnable = this.deps
			.getRouterCandidatePool()
			.models.filter((model) => this.deps.getModelRegistry().hasConfiguredAuth(model));
		// A pool newer owner words already decided keeps their decision.
		const change: ModelPoolChange = {};
		for (const pool of MODEL_POOLS) {
			const enable = evaluated.change[pool];
			if (enable !== undefined && this.decidesOwnerAxis(`model_pool:${pool}`, acceptedOrder)) change[pool] = enable;
		}
		const outcome = this.modelPolicy.apply(change, runnable);
		if (outcome.kind === "applied") this.deps.emitWarning(`Model policy: ${describePolicy(outcome.policy)}`);
		else if (outcome.kind === "refused") this.deps.emitWarning(`Model policy not changed: ${outcome.reason}`);
	}

	getModelPolicy(): ModelPoolPolicy {
		return this.modelPolicy.policy;
	}

	isModelAllowed(model: Model<Api>): boolean {
		return this.modelPolicy.allows(model);
	}

	grantEdge(edgeClass: EdgeClass, source: "operator" | "instructions", details: EdgeGrantDetails = {}): void {
		recordEdgeGrant(this.edgeDeps(), edgeClass, source, details);
		// The owner acted at the edge: whatever was waiting on them is no longer a blocker.
		if (source === "operator") this.deps.setOperatorBlocker(undefined);
	}

	revokeEdge(edgeClass: EdgeClass): boolean {
		return recordEdgeRevoke(this.edgeDeps(), edgeClass);
	}

	/** The owner's interrupt cancels every optional-tool judgment in flight, committed or staged. */
	abortOptionalIntent(): void {
		this.committedIntentAbort?.abort();
		for (const staged of this.stagedIntents.values()) staged.judging?.abort();
	}
}
