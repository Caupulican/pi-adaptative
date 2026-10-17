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
import { normalizeUserRequest, type SystemOneController, USER_REQUEST_RULE_BUDGET } from "./system-one/controller.ts";
import { OperationGate } from "./system-one/operation-gate.ts";
import { operationGateLedgerBindings } from "./system-one/operation-gate-wiring.ts";
import { OwnerPolicyQueue } from "./system-one/owner-policy-queue.ts";
import { appendOwnerFollowUp, ownerFollowUpPath } from "./system-one/owner-question-routing.ts";
import {
	MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS,
	OPTIONAL_TOOL_INTENT_CUSTOM_TYPE,
	type OptionalToolCandidate,
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

export type OwnerRequestClassificationOutcome = Awaited<
	ReturnType<SessionEdgeIntentController["classifyOwnerRequest"]>
>;

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
	private optionalIntentAbort?: AbortController;
	/** The newest owner submission order whose optional-tool judgment started: an older one never writes the intent checkpoint. */
	private newestJudgedOwnerOrder = 0;
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
				// A superseded judgment judged none of these words' owner policy: the words are judged here, and an
				// older submission than one already judged is judged for its owner policy alone (`classifyOwnerRequest`).
				const carried = words.judgment;
				const judgment =
					carried !== undefined && !("superseded" in carried && carried.superseded) ? carried : undefined;
				const note = await this.deps.withTaskDirectoryContext(
					() =>
						judgment !== undefined
							? this.applyOwnerRequestOutcome(words.text, judgment, words.acceptedOrder)
							: this.enableCapabilitiesAuthorizedByUser(words.text, words.signal, true, words.acceptedOrder),
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
	 * A settle of the owner's words failed. The words are kept by the queue and settled with the owner's next message, so
	 * nothing blocks on them; until then their outcome is unknown, which is treated like an evaluator outage: no handoff,
	 * and the model is told once per outage that a delivery limit the owner stated was not registered.
	 */
	private noteOwnerPolicyFailure(error: unknown): void {
		const reason = error instanceof Error ? error.message : String(error);
		this.handoffValue = false;
		if (reason !== this.lastOwnerPolicyFailure) {
			this.lastOwnerPolicyFailure = reason;
			this.deps.emitWarning(
				`The owner's words were not classified: ${reason}. They are kept and classified again with the owner's next message.`,
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
	 * The one way owner words join the owner-policy queue. Words judged when they were submitted (a queued steer, follow-up
	 * or prompt) carry that judgment and are applied as judged, in owner order, where the queue settles; they are never
	 * screened or judged again. A superseded judgment is carried too, so its words are not screened: the newer request took
	 * only the optional-tool chain from it, and the queue judges these words' owner policy alone, once, where it settles them.
	 * Words with no judgment, or one the evaluator could not give (an outage), are screened and classified at the queue.
	 */
	enqueueOwnerWords(
		text: string,
		acceptedOrder: number | undefined,
		judgment: OwnerRequestClassificationOutcome | undefined,
		signal?: AbortSignal,
	): void {
		if (!this.deps.getSystemOneController()) return;
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
	 * The full classification of the owner's words (written rules and still-pending capabilities included), not yet
	 * applied. A queued owner input is judged this way once, before it is admitted; the judgment it carries into the
	 * owner-policy queue is applied there in owner order (`applyOwnerRequestOutcome`), never asked again. Words older than a
	 * submission already judged are judged for their owner policy alone (see `classifyOwnerRequest`).
	 */
	judgeOwnerRequest(request: string, signal?: AbortSignal, acceptedOrder?: number) {
		return this.classifyOwnerRequest(
			request,
			this.writtenRuleText(),
			this.capabilitiesPending(),
			signal,
			acceptedOrder,
		);
	}

	async enableCapabilitiesAuthorizedByUser(
		request: string,
		signal?: AbortSignal,
		trustedOwner = true,
		acceptedOrder?: number,
	): Promise<string | undefined> {
		const controller = this.deps.getSystemOneController();
		if (!controller) return undefined;
		const outcome = trustedOwner
			? await this.judgeOwnerRequest(request, signal, acceptedOrder)
			: await controller.classifyUserRequest(request, this.writtenRuleText(), {
					capabilitiesPending: this.capabilitiesPending(),
					...(signal ? { signal } : {}),
				});
		return this.applyOwnerRequestOutcome(request, outcome, acceptedOrder);
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

	async classifyOwnerRequest(
		request: string,
		rules = "",
		capabilitiesPending = false,
		signal?: AbortSignal,
		acceptedOrder?: number,
	) {
		if (signal?.aborted || this.deps.isDisposed())
			return {
				status: "unavailable" as const,
				cancelled: true,
				contextChanged: false,
				reason: "Owner intent classification was cancelled",
			};
		// An optional-tool judgment is as fresh as the submission it judges. One whose submission is older
		// than a submission already being judged would overwrite the newer optional-tool intent if it applied,
		// so the optional-tool chain is not asked for it: it neither runs nor cancels the newer judgment. The
		// words are still the owner's, so their owner policy is judged alone.
		if (acceptedOrder !== undefined) {
			if (acceptedOrder < this.newestJudgedOwnerOrder)
				return this.judgeOwnerPolicy(request, rules, capabilitiesPending, signal);
			this.newestJudgedOwnerOrder = acceptedOrder;
		}
		// Normal-off: no evaluator means no semantic intent is recorded, aborted, scanned or warned about.
		const controller = this.deps.getSystemOneController();
		if (!controller) return { status: "skipped" as const };
		// A blank message carries no request to classify, so no intent state is written for it.
		if (normalizeUserRequest(request) === undefined) return { status: "skipped" as const };
		this.optionalIntentAbort?.abort(OWNER_INTENT_SUPERSEDED);
		const intentAbort = new AbortController();
		this.optionalIntentAbort = intentAbort;
		const callerSignal = signal;
		signal = AbortSignal.any([this.deps.getReflectionAbortSignal(), intentAbort.signal, ...(signal ? [signal] : [])]);
		const manager = this.deps.getSessionManager();
		const sessionId = manager.getSessionId();
		const snapshot = readOptionalToolIntent(
			manager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
		);
		const unsettled = snapshot !== undefined && snapshot.status !== "classified";
		const pendingRequests = unsettled ? (snapshot.pendingRequests ?? []) : [];
		const previous = unsettled ? snapshot.resumeIntent : snapshot;
		const candidates: OptionalToolCandidate[] = this.deps.getAllTools().flatMap((tool) => {
			const source = this.deps.getToolSourceInfo(tool.name);
			const aliases = optionalToolRequestAliases(tool.name, source);
			return aliases ? [{ toolName: tool.name, sourcePath: source?.path ?? "", aliases }] : [];
		});
		const recoverable = request.length <= MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS && pendingRequests.length < 8;
		const pendingIntent = {
			version: 1 as const,
			status: "paused" as const,
			taskRequest: request.slice(0, MAX_OPTIONAL_TOOL_REQUEST_CHARACTERS),
			allowedTools: [],
			...(recoverable
				? { ...(previous ? { resumeIntent: previous } : {}), pendingRequests: [...pendingRequests, request] }
				: {}),
		};
		const pendingId = manager.appendCustomEntry(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE, pendingIntent);
		const classification = controller.classifyUserRequest(request, rules, {
			capabilitiesPending,
			optionalTools: {
				candidates,
				previous: recoverable ? previous : undefined,
				pendingRequests: recoverable ? pendingRequests : [],
			},
			signal,
		});
		// An aborted judgment decides nothing, so its request does not wait for the evaluator to notice.
		classification.catch(() => undefined);
		const aborted = signal;
		let stopWatchingAbort = (): void => {};
		let outcome: Awaited<typeof classification>;
		try {
			outcome = await Promise.race([
				classification,
				new Promise<{ status: "unavailable"; reason: string }>((resolve) => {
					const settle = () =>
						resolve({ status: "unavailable", reason: "Owner intent classification was aborted" });
					if (aborted.aborted) return settle();
					aborted.addEventListener("abort", settle, { once: true });
					stopWatchingAbort = () => aborted.removeEventListener("abort", settle);
				}),
			]);
		} finally {
			stopWatchingAbort();
		}
		if (
			signal.aborted &&
			manager.getSessionId() === sessionId &&
			manager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.id === pendingId
		)
			// A cancelled classification is no longer in flight and decided nothing: it must not keep
			// blocking the integrations as if it were.
			manager.appendCustomEntry(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE, {
				version: 1,
				status: "unresolved",
				taskRequest: "",
				allowedTools: [],
			});
		if (
			callerSignal?.aborted ||
			this.deps.getReflectionAbortSignal().aborted ||
			(intentAbort.signal.aborted && intentAbort.signal.reason !== OWNER_INTENT_SUPERSEDED) ||
			this.deps.isDisposed()
		)
			return {
				status: "unavailable" as const,
				cancelled: true,
				contextChanged: false,
				reason: "Owner intent classification was cancelled",
			};
		// A newer owner request owns the optional-tool chain now: this stale judgment applies nothing, but its
		// request remains owner input for the caller to admit, and its owner policy is judged at the queue.
		if (intentAbort.signal.aborted)
			return {
				status: "unavailable" as const,
				superseded: true,
				reason: "Owner intent classification was superseded by a newer owner request",
			};
		// No newer request replaced this one, yet its checkpoint is no longer the branch's latest: the
		// session or branch moved under it. Its request belongs to the old context, not the new one.
		if (
			manager.getSessionId() !== sessionId ||
			manager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.id !== pendingId
		)
			return {
				status: "unavailable" as const,
				cancelled: true,
				contextChanged: true,
				reason: "The session context changed while the owner request was classified",
			};
		const classifiedIntent =
			outcome.status === "classified" && outcome.classification.optionalToolIntent?.status === "classified"
				? outcome.classification.optionalToolIntent
				: undefined;
		if (classifiedIntent) {
			manager.appendCustomEntry(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE, classifiedIntent);
			this.lastOptionalIntentWarning = undefined;
		} else {
			// No usable judgment is not an owner decision: keep the unclassified words for the next
			// classification, and leave the integrations available.
			manager.appendCustomEntry(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE, { ...pendingIntent, status: "unresolved" });
			const warning = `Optional integrations stay available; owner intent for them was not classified: ${outcome.status === "unavailable" ? outcome.reason : "the judgment was uncertain"}.`;
			if (candidates.length && warning !== this.lastOptionalIntentWarning) {
				this.lastOptionalIntentWarning = warning;
				this.deps.emitWarning(warning);
			}
		}
		return outcome;
	}

	/**
	 * The owner-policy judgment of owner words, without the optional-tool chain: no optional tool is asked, and nothing
	 * of the optional-tool intent (its checkpoint, the in-flight judgment, the newest judged order) is read or written,
	 * so a newer submission keeps that chain. A cancellation or a session switch while it runs is reported as
	 * `classifyOwnerRequest` reports it.
	 */
	private async judgeOwnerPolicy(request: string, rules: string, capabilitiesPending: boolean, signal?: AbortSignal) {
		const controller = this.deps.getSystemOneController();
		if (!controller) return { status: "skipped" as const };
		const sessionId = this.deps.getSessionManager().getSessionId();
		const outcome = await controller.classifyUserRequest(request, rules, {
			capabilitiesPending,
			signal: AbortSignal.any([this.deps.getReflectionAbortSignal(), ...(signal ? [signal] : [])]),
		});
		if (signal?.aborted || this.deps.getReflectionAbortSignal().aborted || this.deps.isDisposed())
			return {
				status: "unavailable" as const,
				cancelled: true,
				contextChanged: false,
				reason: "Owner intent classification was cancelled",
			};
		if (this.deps.getSessionManager().getSessionId() !== sessionId)
			return {
				status: "unavailable" as const,
				cancelled: true,
				contextChanged: true,
				reason: "The session context changed while the owner request was classified",
			};
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

	abortOptionalIntent(): void {
		this.optionalIntentAbort?.abort();
	}
}
