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
 * Abort reason of an owner intent classification replaced by a newer owner request. It makes that
 * JUDGMENT stale; the request it was judging is still the owner's input and is still admitted. Any
 * other abort (the owner's interrupt, disposal, the caller's signal) cancels the submission itself.
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
	readonly ownerPolicy: OwnerPolicyQueue;
	readonly modelPolicy: OwnerModelPolicy;
	private poolPolicyRead?: { branchKey: string; policy: ModelPoolPolicy | undefined };
	private operationGateInstance?: OperationGate;
	private edgeConfirmation?: EdgeConfirmationHandler;
	private optionalIntentAbort?: AbortController;
	private newestJudgedOwnerOrder = 0;
	private lastOptionalIntentWarning?: string;
	private localCommitBranchValue?: string;
	private ruleAuthorityValue: "unset" | "ask" | "user" | "written" = "unset";
	private deliveryClassificationUnavailable = false;
	private handoffValue = false;

	constructor(deps: SessionEdgeIntentControllerDeps) {
		this.deps = deps;
		this.ownerPolicy = new OwnerPolicyQueue({
			classify: async (words) => {
				const note = await this.deps.withTaskDirectoryContext(
					() => this.enableCapabilitiesAuthorizedByUser(words.text, words.signal, true, words.acceptedOrder),
					words.signal,
					(error) => {
						this.deps.noteSystemOneTaskDirectoryUnavailable(error);
						return undefined;
					},
				);
				if (note) {
					this.deps.pushPendingNextTurnMessage(
						createCustomMessage("request_authority", note, false, undefined, new Date().toISOString()),
					);
				}
			},
			screen: async (texts, signal) => {
				const outcome = await this.deps.getSystemOneController()?.screenOwnerWords(texts, signal ? { signal } : {});
				return outcome?.status === "screened" ? outcome.carriesInstruction : undefined;
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

	async enableCapabilitiesAuthorizedByUser(
		request: string,
		signal?: AbortSignal,
		trustedOwner = true,
		acceptedOrder?: number,
	): Promise<string | undefined> {
		const controller = this.deps.getSystemOneController();
		if (!controller) return undefined;
		const granted = new Set(this.getEdgeGrants().map((grant) => grant.class));
		const capabilitiesPending = EDGE_CLASSES.some((edgeClass) => !granted.has(edgeClass));
		const outcome = trustedOwner
			? await this.classifyOwnerRequest(request, this.writtenRuleText(), capabilitiesPending, signal, acceptedOrder)
			: await controller.classifyUserRequest(request, this.writtenRuleText(), {
					capabilitiesPending,
					...(signal ? { signal } : {}),
				});
		if (outcome.status === "skipped") return undefined;
		// A newer owner request owns the policy: this judgment is stale, not an evaluator outage. The
		// request itself still runs; only its judgment is set aside.
		if ("superseded" in outcome && outcome.superseded) return undefined;
		if (outcome.status === "unavailable") {
			// Unknown is not a handoff: an owner question goes to the owner.
			this.handoffValue = false;
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
		this.handoffValue = classified.fullHandoff;
		if (classified.mayChangeModelPools) await this.applyModelPoolChange(controller, request);
		this.localCommitBranchValue = resolveDeliveryBinding(
			this.localCommitBranchValue,
			{ blocksPush: classified.localCommitsOnly, liftsPushBlock: classified.liftsDeliveryBlock },
			readHeadBranch(this.deps.getCwd()),
		);
		this.ruleAuthorityValue = resolveRuleAuthority(classified);
		if (classified.capabilitiesAuthorized) {
			for (const edgeClass of EDGE_CLASSES) {
				if (edgeClass === "git.publish" && this.localCommitBranchValue !== undefined) continue;
				if (granted.has(edgeClass)) continue;
				this.grantEdge(edgeClass, "operator", { note: "explicit user request" });
			}
		}
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
		// A judgment is as fresh as the submission it judges. One whose submission is older than a
		// submission already being judged would overwrite newer owner policy if it applied, so it is
		// stale before it starts: it neither runs nor cancels the newer judgment.
		if (acceptedOrder !== undefined) {
			if (acceptedOrder < this.newestJudgedOwnerOrder)
				return {
					status: "unavailable" as const,
					superseded: true,
					reason: "Owner intent classification was superseded by a newer owner request",
				};
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
		// A newer owner request owns the policy now: this stale judgment applies nothing, but its request
		// remains owner input for the caller to admit.
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

	async applyModelPoolChange(controller: SystemOneController, request: string): Promise<void> {
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
		const outcome = this.modelPolicy.apply(evaluated.change, runnable);
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
