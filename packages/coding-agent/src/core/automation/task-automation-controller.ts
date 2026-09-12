import { randomUUID } from "node:crypto";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { Value } from "typebox/value";
import type { ToolkitScript } from "../toolkit/script-registry.ts";
import { executeToolkitScript, type ScriptExecution, type ScriptExecutor } from "../toolkit/script-runner.ts";
import type { ToolkitScriptAuthorizer } from "../tools/run-toolkit-script.ts";
import {
	boundedUtf8Excerpt,
	cloneTaskAutomationContract,
	evaluateOutputContract,
	MAX_AUTOMATION_DESCRIPTION_LENGTH,
	MAX_AUTOMATION_NAME_LENGTH,
	MAX_AUTOMATION_PATH_LENGTH,
	MAX_TASK_AUTOMATIONS,
	TaskAutomationBindingError,
	TaskAutomationBindingSchema,
	type TaskAutomationContextPort,
	type TaskAutomationDefinition,
	type TaskAutomationEvidence,
	type TaskAutomationExecutionResult,
	type TaskAutomationHashPort,
	type TaskAutomationNegativeControlResult,
	type TaskAutomationOperationContract,
	type TaskAutomationState,
	type TaskAutomationStepBinding,
	type TaskAutomationStoragePort,
	type TaskStepLike,
	taskAutomationToToolkitScript,
	validateTaskAutomationContract,
} from "./contracts.ts";
import {
	appendTaskAutomationStateSnapshot,
	cloneTaskAutomationDefinition,
	cloneTaskAutomationState,
	getLatestTaskAutomationStateSnapshot,
	isTaskAutomationState,
	recoverAutomationInFlight,
	TASK_AUTOMATION_STATE_CUSTOM_TYPE,
} from "./session-task-automation.ts";
import { defaultTaskAutomationHashPort } from "./task-automation-hash.ts";

export interface AuthorTaskAutomationInput {
	readonly name: string;
	readonly description: string;
	readonly runner: "bash" | "powershell" | "uv";
	readonly path: string;
	readonly contract: TaskAutomationOperationContract;
	readonly binding?: TaskAutomationStepBinding;
	readonly danger?: boolean;
}

export interface ValidateTaskAutomationResult {
	readonly success: boolean;
	readonly state: TaskAutomationDefinition["state"];
	readonly reason?: string;
	readonly evidence?: TaskAutomationEvidence;
}

export interface RunTaskAutomationResult {
	readonly outcome: "succeeded" | "failed";
	readonly execution?: ScriptExecution;
	readonly error?: string;
}

export interface TaskAutomationControllerDeps {
	readonly context?: TaskAutomationContextPort;
	readonly getCwd?: () => string;
	readonly storage?: TaskAutomationStoragePort;
	readonly getSessionManager?: () => Pick<SessionManager, "appendCustomEntry" | "getLatestCustomEntryOnBranch"> & {
		readonly getSessionId?: () => string;
	};
	readonly hash?: TaskAutomationHashPort;
	readonly executor?: ScriptExecutor;
	readonly authorize?: ToolkitScriptAuthorizer;
}

interface AutomationOperationContext {
	readonly name: string;
	readonly operationToken: string;
	readonly generation: number;
	readonly cwd: string;
	readonly sessionId?: string;
	readonly branchId?: string;
}

export class TaskAutomationController {
	private readonly contextPort: TaskAutomationContextPort;
	private readonly storagePort: TaskAutomationStoragePort;
	private readonly hashPort: TaskAutomationHashPort;
	private readonly executor?: ScriptExecutor;
	private readonly authorize?: ToolkitScriptAuthorizer;
	private readonly getSessionManager?: () => Pick<
		SessionManager,
		"appendCustomEntry" | "getLatestCustomEntryOnBranch"
	> & { readonly getSessionId?: () => string };
	private state: TaskAutomationState;
	private lastSeenCwd: string;
	private lastSeenBranchId?: string;
	private lastSeenSessionId?: string;
	private lastAppendedEntryId?: string;

	constructor(deps: TaskAutomationControllerDeps) {
		this.getSessionManager = deps.getSessionManager;
		if (deps.context) {
			this.contextPort = deps.context;
		} else if (deps.getCwd) {
			const getCwd = deps.getCwd;
			const getSm = deps.getSessionManager;
			this.contextPort = {
				getCwd,
				getSessionId: getSm
					? () => {
							try {
								const sm = getSm();
								return sm?.getSessionId?.();
							} catch {
								return undefined;
							}
						}
					: undefined,
				getBranchId: undefined,
			};
		} else {
			throw new Error("TaskAutomationController requires either context port or getCwd dependency.");
		}

		if (deps.storage) {
			this.storagePort = deps.storage;
		} else if (deps.getSessionManager) {
			const getSm = deps.getSessionManager;
			this.storagePort = {
				appendSnapshot: (state: TaskAutomationState): string => {
					const sm = getSm();
					if (!sm || typeof sm.appendCustomEntry !== "function") {
						throw new Error(
							"SessionManager appendCustomEntry is unavailable; cannot persist task automation state.",
						);
					}
					return appendTaskAutomationStateSnapshot(sm, state);
				},
				getLatestSnapshot: (): TaskAutomationState | undefined => {
					try {
						const sm = getSm();
						if (!sm || typeof sm.getLatestCustomEntryOnBranch !== "function") {
							return undefined;
						}
						return getLatestTaskAutomationStateSnapshot(sm);
					} catch {
						return undefined;
					}
				},
			};
		} else {
			throw new Error("TaskAutomationController requires either storage port or getSessionManager dependency.");
		}

		this.hashPort = deps.hash ?? defaultTaskAutomationHashPort;
		this.executor = deps.executor;
		this.authorize = deps.authorize;

		this.lastSeenCwd = this.contextPort.getCwd();
		this.lastSeenBranchId = this.contextPort.getBranchId?.();
		this.lastSeenSessionId = this.contextPort.getSessionId?.();

		this.lastAppendedEntryId = this.getLatestCustomEntryId();
		this.state = this.loadStateFromStorage();
	}

	private getLatestCustomEntryId(): string | undefined {
		if (!this.getSessionManager) return undefined;
		try {
			const sm = this.getSessionManager();
			if (typeof sm?.getLatestCustomEntryOnBranch === "function") {
				return sm.getLatestCustomEntryOnBranch(TASK_AUTOMATION_STATE_CUSTOM_TYPE)?.id;
			}
		} catch {
			// ignore
		}
		return undefined;
	}

	private loadStateFromStorage(): TaskAutomationState {
		const latest = this.storagePort.getLatestSnapshot();
		if (latest) {
			return {
				version: 1,
				revision: latest.revision,
				automations: latest.automations.map((a) => recoverAutomationInFlight(a)),
				createdAt: latest.createdAt,
				updatedAt: latest.updatedAt,
			};
		}
		const now = new Date().toISOString();
		return {
			version: 1,
			revision: 0,
			automations: [],
			createdAt: now,
			updatedAt: now,
		};
	}

	private hasInFlightOperation(): boolean {
		return this.state.automations.some((a) => a.state === "validating" || a.state === "executing");
	}

	private ensureRefreshedScope(): void {
		const currentCwd = this.contextPort.getCwd();
		const currentBranch = this.contextPort.getBranchId?.();
		const currentSession = this.contextPort.getSessionId?.();

		let needsRefresh = false;
		if (currentCwd !== this.lastSeenCwd) {
			this.lastSeenCwd = currentCwd;
			needsRefresh = true;
		}
		if (currentBranch !== undefined && currentBranch !== this.lastSeenBranchId) {
			this.lastSeenBranchId = currentBranch;
			needsRefresh = true;
		}
		if (currentSession !== undefined && currentSession !== this.lastSeenSessionId) {
			this.lastSeenSessionId = currentSession;
			needsRefresh = true;
		}

		if (this.getSessionManager) {
			const latestEntryId = this.getLatestCustomEntryId();
			if (latestEntryId !== this.lastAppendedEntryId) {
				this.lastAppendedEntryId = latestEntryId;
				needsRefresh = true;
			}
		} else if (!this.hasInFlightOperation()) {
			try {
				const latest = this.storagePort.getLatestSnapshot();
				if (latest && latest.revision !== this.state.revision) {
					needsRefresh = true;
				}
			} catch {
				// ignore
			}
		}

		if (needsRefresh) {
			this.refresh();
		}
	}

	private isOperationCurrent(opCtx: AutomationOperationContext): boolean {
		const current = this.getInternalAutomation(opCtx.name);
		if (!current) return false;
		if ((current.generation ?? 1) !== opCtx.generation) return false;
		if (current.activeToken !== opCtx.operationToken) return false;
		if (this.contextPort.getCwd() !== opCtx.cwd) return false;
		if (this.contextPort.getSessionId?.() !== opCtx.sessionId) return false;
		if (opCtx.branchId !== undefined && this.contextPort.getBranchId?.() !== opCtx.branchId) return false;
		return true;
	}

	/**
	 * Single mutation owner: computes candidate state, validates bounds,
	 * appends to storage port first, and mutates in-memory state only after durable append succeeds.
	 */
	private commitMutation(mutator: (current: TaskAutomationState) => TaskAutomationState): TaskAutomationState {
		const now = new Date().toISOString();
		const candidate = mutator(this.state);
		if (candidate.automations.length > MAX_TASK_AUTOMATIONS) {
			throw new Error(`Task automations exceeds maximum limit of ${MAX_TASK_AUTOMATIONS}.`);
		}
		const updatedState: TaskAutomationState = {
			...candidate,
			revision: this.state.revision + 1,
			updatedAt: now,
		};
		if (!isTaskAutomationState(updatedState)) {
			throw new Error("Invalid task automation state mutation violates canonical schema or invariants.");
		}
		// Mutate in-memory state ONLY AFTER durable append succeeds
		const entryId = this.storagePort.appendSnapshot(updatedState);
		this.lastAppendedEntryId = entryId;
		this.state = updatedState;
		return updatedState;
	}

	/**
	 * Single consolidated helper for updating an existing automation in the state.
	 * Consolidates transition mutation blocks and eliminates clone duplicates.
	 */
	private updateAutomation(
		name: string,
		updater: (existing: TaskAutomationDefinition) => TaskAutomationDefinition,
	): TaskAutomationDefinition | undefined {
		let updated: TaskAutomationDefinition | undefined;
		const normalized = name.trim().toLowerCase();
		this.commitMutation((current) => {
			const index = current.automations.findIndex((a) => a.name.toLowerCase() === normalized);
			if (index < 0) return current;
			const next = [...current.automations];
			updated = updater(next[index]);
			next[index] = updated;
			return { ...current, automations: next };
		});
		return updated;
	}

	private failValidation(opCtx: AutomationOperationContext, reason: string): ValidateTaskAutomationResult {
		if (this.isOperationCurrent(opCtx)) {
			this.updateAutomation(opCtx.name, (existing) => ({
				...existing,
				state: "failed",
				activeToken: undefined,
				updatedAt: new Date().toISOString(),
			}));
			return { success: false, state: "failed", reason: boundedUtf8Excerpt(reason) };
		}
		const current = this.getInternalAutomation(opCtx.name);
		return {
			success: false,
			state: current?.state ?? "building",
			reason: "Intervening mutation occurred during validation. Obsolete validation discarded.",
		};
	}

	getState(): TaskAutomationState {
		this.ensureRefreshedScope();
		return cloneTaskAutomationState(this.state);
	}

	refresh(): TaskAutomationState {
		this.lastAppendedEntryId = this.getLatestCustomEntryId();
		this.state = this.loadStateFromStorage();
		return cloneTaskAutomationState(this.state);
	}

	formatContext(maxChars = 2_000): string | undefined {
		this.ensureRefreshedScope();
		if (this.state.automations.length === 0) {
			return undefined;
		}
		const lines: string[] = ["# Task Automations"];
		for (const a of this.state.automations) {
			const boundInfo = a.binding ? ` (bound step: ${a.binding.stepId} [${a.binding.expectedArgs.join(", ")}])` : "";
			const outcome = a.lastExecution ? `last run: ${a.lastExecution.outcome}` : "not run";
			const evidence = a.evidence ? `verified (hash: ${a.evidence.scriptHash.slice(0, 8)})` : "unverified";
			lines.push(
				`- ${a.name} [${a.state}]: path=${a.path}, runner=${a.runner}, ${evidence}, ${outcome}${boundInfo}`,
			);
		}
		const text = lines.join("\n");
		return boundedUtf8Excerpt(text, maxChars);
	}

	getAutomations(): readonly TaskAutomationDefinition[] {
		this.ensureRefreshedScope();
		return this.state.automations.map((a) => cloneTaskAutomationDefinition(a));
	}

	getAutomation(name: string): TaskAutomationDefinition | undefined {
		this.ensureRefreshedScope();
		const normalized = name.trim().toLowerCase();
		const found = this.state.automations.find((a) => a.name.toLowerCase() === normalized);
		return found ? cloneTaskAutomationDefinition(found) : undefined;
	}

	private getInternalAutomation(name: string): TaskAutomationDefinition | undefined {
		this.ensureRefreshedScope();
		const normalized = name.trim().toLowerCase();
		return this.state.automations.find((a) => a.name.toLowerCase() === normalized);
	}

	/**
	 * Explicit task-step binding using ONE mandatory binding contract.
	 * Rebinding clears prior execution evidence.
	 */
	bindStep(name: string, binding: TaskAutomationStepBinding): void {
		this.ensureRefreshedScope();
		const normalized = name.trim().toLowerCase();
		const stepId = binding.stepId.trim();
		if (!stepId) {
			throw new Error("Task step id must not be empty.");
		}
		const normalizedBinding: TaskAutomationStepBinding = {
			stepId,
			expectedArgs: [...binding.expectedArgs],
			...(binding.operationIdentity ? { operationIdentity: binding.operationIdentity.trim() } : {}),
		};

		const updated = this.updateAutomation(normalized, (existing) => ({
			...existing,
			binding: normalizedBinding,
			generation: (existing.generation ?? 0) + 1,
			lastExecution: undefined, // Rebinding clears prior execution evidence
			updatedAt: new Date().toISOString(),
		}));

		if (!updated) {
			throw new Error(`Automation "${name}" not found to bind.`);
		}
	}

	/**
	 * Step transition completion invariant check:
	 * 1. Bound step preservation check: cannot drop active unresolved bound steps unless cancelled/completed.
	 * 2. Completed steps check: automation must be in ready state, succeeded, exact argv match, intact hash.
	 */
	assertTaskStepsTransition(previous: readonly TaskStepLike[] | undefined, next: readonly TaskStepLike[]): void {
		this.ensureRefreshedScope();
		const cwd = this.contextPort.getCwd();

		// 1. Bound step preservation check: cannot drop active unresolved bound steps unless cancelled/completed
		if (previous) {
			for (const prevStep of previous) {
				if (prevStep.status === "cancelled" || prevStep.status === "completed") {
					continue; // Explicitly cancelled or completed steps are permitted to disappear
				}
				const isBound = this.state.automations.some((a) => a.binding?.stepId === prevStep.id);
				if (isBound) {
					const nextStep = next.find((s) => s.id === prevStep.id);
					if (!nextStep) {
						throw new TaskAutomationBindingError(
							`Cannot drop active bound task step "${prevStep.id}". Cancel or complete the step explicitly before removing it.`,
						);
					}
				}
			}
		}

		// 2. Completed steps invariant check
		for (const step of next) {
			if (step.status !== "completed") continue;
			const stepId = step.id.trim();

			// Historical check: if the step was already completed in previous, do not block unrelated mutations
			if (previous) {
				const prevStep = previous.find((p) => p.id === stepId);
				if (prevStep && prevStep.status === "completed") {
					continue;
				}
			}

			for (const automation of this.state.automations) {
				if (!automation.binding || automation.binding.stepId !== stepId) continue;

				if (automation.state !== "ready" || automation.lastExecution?.outcome !== "succeeded") {
					throw new TaskAutomationBindingError(
						`Task step "${stepId}" is bound to automation "${automation.name}" which has not executed successfully. Script readiness is not task success; verified execution is required before completion.`,
					);
				}

				// Exact argv check ALWAYS performed, including empty []
				const actualArgs = automation.lastExecution.args ?? [];
				const expectedArgs = automation.binding.expectedArgs;
				const matches =
					expectedArgs.length === actualArgs.length && expectedArgs.every((arg, i) => arg === actualArgs[i]);
				if (!matches) {
					throw new TaskAutomationBindingError(
						`Task step "${stepId}" is bound to automation "${automation.name}" expecting args ${JSON.stringify(expectedArgs)}, but last execution ran with ${JSON.stringify(actualArgs)}.`,
					);
				}

				// Check disk hash integrity
				const diskHash = this.hashPort.computeFileHash(automation.path, cwd);
				if (!diskHash || diskHash !== automation.evidence?.scriptHash) {
					throw new TaskAutomationBindingError(
						`Task step "${stepId}" is bound to automation "${automation.name}" which has not executed successfully. Script readiness is not task success; verified execution is required before completion.`,
					);
				}
			}
		}
	}

	/**
	 * Single-step completion invariant check.
	 */
	verifyStepCompletionAllowed(stepId: string): { allowed: boolean; reason?: string } {
		try {
			this.assertTaskStepsTransition([], [{ id: stepId.trim(), status: "completed" }]);
			return { allowed: true };
		} catch (err) {
			return {
				allowed: false,
				reason: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Author or update a task-local automation specification.
	 * Rejects malformed contracts before persisting.
	 */
	author(input: AuthorTaskAutomationInput): TaskAutomationDefinition {
		this.ensureRefreshedScope();
		const name = input.name.trim().toLowerCase();
		if (!name || name.length > MAX_AUTOMATION_NAME_LENGTH) {
			throw new Error(`Automation name must be non-empty and at most ${MAX_AUTOMATION_NAME_LENGTH} characters.`);
		}
		const description = input.description.trim();
		if (!description || description.length > MAX_AUTOMATION_DESCRIPTION_LENGTH) {
			throw new Error(
				`Automation description must be non-empty and at most ${MAX_AUTOMATION_DESCRIPTION_LENGTH} characters.`,
			);
		}
		const path = input.path.trim();
		if (!path || path.length > MAX_AUTOMATION_PATH_LENGTH) {
			throw new Error(`Automation path must be non-empty and at most ${MAX_AUTOMATION_PATH_LENGTH} characters.`);
		}

		// Deep clone contract to protect against external mutation
		const clonedContract = cloneTaskAutomationContract(input.contract);

		// Reject malformed contract BEFORE persisting
		const contractValidation = validateTaskAutomationContract(clonedContract);
		if (!contractValidation.valid) {
			throw new Error(`Invalid automation contract: ${contractValidation.errors.join("; ")}`);
		}

		const now = new Date().toISOString();
		const cwd = this.contextPort.getCwd();
		const currentHash = this.hashPort.computeFileHash(path, cwd);
		const initialLifecycle = currentHash ? "building" : "specification";

		let resultDefinition: TaskAutomationDefinition | undefined;

		this.commitMutation((current) => {
			const existingIndex = current.automations.findIndex((a) => a.name.toLowerCase() === name);
			const existing = existingIndex >= 0 ? current.automations[existingIndex] : undefined;

			const binding: TaskAutomationStepBinding | undefined = input.binding
				? {
						stepId: input.binding.stepId.trim(),
						expectedArgs: [...input.binding.expectedArgs],
						...(input.binding.operationIdentity
							? { operationIdentity: input.binding.operationIdentity.trim() }
							: {}),
					}
				: existing?.binding;

			const generation = (existing?.generation ?? 0) + 1;

			const definition: TaskAutomationDefinition = {
				name,
				description,
				runner: input.runner,
				path,
				state: initialLifecycle,
				contract: clonedContract,
				binding,
				danger: input.danger ?? false,
				workspaceCwd: cwd,
				generation,
				activeToken: undefined,
				createdAt: existing ? existing.createdAt : now,
				updatedAt: now,
			};

			const nextAutomations = [...current.automations];
			if (existingIndex >= 0) {
				nextAutomations[existingIndex] = definition;
			} else {
				nextAutomations.push(definition);
			}
			resultDefinition = definition;
			return { ...current, automations: nextAutomations };
		});

		return cloneTaskAutomationDefinition(resultDefinition!);
	}

	/**
	 * Validate a task-local automation script against its contract.
	 *
	 * Host authorizer is checked for dangerous scripts and ordinary scripts if authorizer is configured.
	 * Positive fixture requires actual bounded output match (exit 0 alone rejected).
	 * Negative controls: exit null/timeout/abort is NEVER passing; expectedCode 0 is forbidden.
	 * Negative controls are authorized independently through authorizer.
	 * Hashes before and after; commits fenced by per-automation generation/token.
	 */
	private isPreClaimScopeAndIdentityCurrent(
		name: string,
		expectedGeneration: number,
		expectedActiveToken: string | undefined,
		expectedCwd: string,
		expectedSessionId?: string,
		expectedBranchId?: string,
		expectedState?: TaskAutomationDefinition["state"],
	): boolean {
		const current = this.getInternalAutomation(name);
		if (!current) return false;
		if ((current.generation ?? 1) !== expectedGeneration) return false;
		if (current.activeToken !== expectedActiveToken) return false;
		if (expectedState !== undefined && current.state !== expectedState) return false;
		if (this.contextPort.getCwd() !== expectedCwd) return false;
		if (this.contextPort.getSessionId?.() !== expectedSessionId) return false;
		if (expectedBranchId !== undefined && this.contextPort.getBranchId?.() !== expectedBranchId) return false;
		return true;
	}

	private async prepareAuthorizedExecution(
		automation: TaskAutomationDefinition,
		args: readonly string[],
		actionLabel: "Validation" | "Execution",
		signal?: AbortSignal,
	): Promise<
		| {
				readonly authorized: true;
				readonly opCtx: AutomationOperationContext;
				readonly detachedScript: ToolkitScript;
				readonly detachedArgs: readonly string[];
				readonly initialGeneration: number;
				readonly initialToken: string | undefined;
				readonly initialState: TaskAutomationDefinition["state"];
		  }
		| {
				readonly authorized: false;
				readonly reason: string;
		  }
	> {
		const cwd = this.contextPort.getCwd();
		const initialGeneration = automation.generation ?? 1;
		const initialToken = automation.activeToken;
		const initialState = automation.state;
		const sessionId = this.contextPort.getSessionId?.();
		const branchId = this.contextPort.getBranchId?.();

		const detachedScript = Object.freeze(taskAutomationToToolkitScript(automation));

		// Canonical host authorization check: if dangerous, authorizer is mandatory
		if (automation.danger && !this.authorize) {
			return {
				authorized: false,
				reason: `${actionLabel} of dangerous script "${automation.name}" requires host authorization, but no authorizer is configured.`,
			};
		}

		const detachedArgs = Object.freeze([...args]);
		if (this.authorize) {
			const authDecision = await this.authorize({ script: detachedScript, args: detachedArgs }, signal);
			signal?.throwIfAborted();
			if (!authDecision.authorized) {
				return {
					authorized: false,
					reason:
						authDecision.reason ?? `${actionLabel} of script "${automation.name}" denied by host authorizer.`,
				};
			}
		}

		if (
			!this.isPreClaimScopeAndIdentityCurrent(
				automation.name,
				initialGeneration,
				initialToken,
				cwd,
				sessionId,
				branchId,
				actionLabel === "Execution" ? "ready" : undefined,
			)
		) {
			return {
				authorized: false,
				reason: `Automation was modified during authorization. ${actionLabel} aborted.`,
			};
		}
		if (actionLabel === "Execution") {
			const currentAfterAuth = this.getInternalAutomation(automation.name);
			if (!currentAfterAuth?.evidence) {
				return {
					authorized: false,
					reason: `Automation was modified during authorization. ${actionLabel} aborted.`,
				};
			}
		}

		const operationToken = randomUUID();
		const opCtx: AutomationOperationContext = {
			name: automation.name,
			operationToken,
			generation: initialGeneration,
			cwd,
			sessionId,
			branchId,
		};

		return {
			authorized: true,
			opCtx,
			detachedScript,
			detachedArgs,
			initialGeneration,
			initialToken,
			initialState,
		};
	}

	async validate(name: string, signal?: AbortSignal): Promise<ValidateTaskAutomationResult> {
		this.ensureRefreshedScope();
		const automation = this.getInternalAutomation(name);
		if (!automation) {
			return { success: false, state: "failed", reason: `Automation "${name}" not found.` };
		}
		if (automation.state === "executing") {
			return {
				success: false,
				state: automation.state,
				reason: `Automation "${automation.name}" is currently executing; concurrent validation rejected.`,
			};
		}
		if (automation.state === "validating") {
			return {
				success: false,
				state: automation.state,
				reason: `Automation "${automation.name}" is currently validating; concurrent validation rejected.`,
			};
		}

		const cwd = this.contextPort.getCwd();
		const initialHash = this.hashPort.computeFileHash(automation.path, cwd);
		if (!initialHash) {
			return {
				success: false,
				state: "building",
				reason: `Script file "${automation.path}" not found in workspace cwd.`,
			};
		}

		// Reject malformed contract BEFORE spawning any fixture
		const contractValidation = validateTaskAutomationContract(automation.contract);
		if (!contractValidation.valid) {
			return {
				success: false,
				state: "failed",
				reason: `Contract validation failed: ${contractValidation.errors.join("; ")}`,
			};
		}

		const prepared = await this.prepareAuthorizedExecution(
			automation,
			automation.contract.verifier.args ?? [],
			"Validation",
			signal,
		);
		if (!prepared.authorized) {
			return {
				success: false,
				state: "failed",
				reason: prepared.reason,
			};
		}

		if (
			!this.isPreClaimScopeAndIdentityCurrent(
				automation.name,
				prepared.initialGeneration,
				prepared.initialToken,
				prepared.opCtx.cwd,
				prepared.opCtx.sessionId,
				prepared.opCtx.branchId,
				prepared.initialState,
			)
		) {
			return {
				success: false,
				state: "failed",
				reason: "Automation was modified during authorization. Validation aborted.",
			};
		}

		const { opCtx, detachedScript } = prepared;

		// Transition to validating
		this.updateAutomation(automation.name, (existing) => ({
			...existing,
			state: "validating",
			evidence: undefined,
			lastExecution: undefined,
			activeToken: opCtx.operationToken,
			updatedAt: new Date().toISOString(),
		}));

		let validationSucceeded = false;
		try {
			const verifier = automation.contract.verifier;
			const positiveArgs = Object.freeze([...(verifier.args ?? [])]);

			// 1. Positive verification run
			const positiveExecution = await executeToolkitScript({
				script: detachedScript,
				scriptArgs: positiveArgs,
				cwd,
				timeoutMs: verifier.timeoutMs ?? 30_000,
				signal,
				executor: this.executor,
			});

			signal?.throwIfAborted();
			if (!this.isOperationCurrent(opCtx)) {
				return {
					success: false,
					state: "building",
					reason: "Intervening mutation occurred during validation. Obsolete validation discarded.",
				};
			}

			if (positiveExecution.timedOut) {
				return this.failValidation(opCtx, "Verifier execution timed out.");
			}

			if (positiveExecution.exitCode !== 0) {
				const reason = `Verifier exited with code ${positiveExecution.exitCode}, expected 0. stderr: ${positiveExecution.stderr.slice(0, 500)}`;
				return this.failValidation(opCtx, reason);
			}

			// 1. Positive fixture must satisfy declared outputs contract (format & contains)
			const contractOutputCheck = evaluateOutputContract(automation.contract.outputs, positiveExecution.stdout);
			if (!contractOutputCheck.valid) {
				const reason = `Positive fixture stdout did not satisfy contract output requirements: ${contractOutputCheck.error}`;
				return this.failValidation(opCtx, reason);
			}

			// 2. Positive fixture must also satisfy mandatory verifier expectedOutput
			const verifierOutputContract = {
				format: "text" as const,
				description: "verifier output",
				contains: verifier.expectedOutput,
			};
			const verifierOutputCheck = evaluateOutputContract(verifierOutputContract, positiveExecution.stdout);
			if (!verifierOutputCheck.valid) {
				return this.failValidation(
					opCtx,
					`Verifier stdout did not match mandatory expected output "${verifier.expectedOutput}": ${verifierOutputCheck.error}`,
				);
			}

			// 2. Negative controls run (mandatory proof that corrupt/invalid input is rejected)
			const negativeResults: TaskAutomationNegativeControlResult[] = [];
			for (const control of verifier.negativeControls) {
				signal?.throwIfAborted();
				if (!this.isOperationCurrent(opCtx)) {
					return {
						success: false,
						state: "building",
						reason: "Intervening mutation occurred during validation. Obsolete validation discarded.",
					};
				}

				const controlArgs = Object.freeze([...control.args]);
				// Negative controls independently authorized through host authorizer
				if (this.authorize) {
					const authDecision = await this.authorize(
						{
							script: detachedScript,
							args: controlArgs,
						},
						signal,
					);
					signal?.throwIfAborted();
					if (!this.isOperationCurrent(opCtx)) {
						return {
							success: false,
							state: "building",
							reason: "Intervening mutation occurred during authorization. Obsolete validation discarded.",
						};
					}
					if (!authDecision.authorized) {
						const reason =
							authDecision.reason ??
							`Host policy refused negative control fixture for "${control.description}".`;
						return this.failValidation(opCtx, reason);
					}
				}

				const controlExecution = await executeToolkitScript({
					script: detachedScript,
					scriptArgs: controlArgs,
					cwd,
					timeoutMs: 15_000,
					signal,
					executor: this.executor,
				});

				signal?.throwIfAborted();
				if (!this.isOperationCurrent(opCtx)) {
					return {
						success: false,
						state: "building",
						reason: "Intervening mutation occurred during validation. Obsolete validation discarded.",
					};
				}

				// Negative control: exit null, timeout, or abort is NEVER passing
				if (controlExecution.timedOut || controlExecution.exitCode === null) {
					const reason = `Negative control "${control.description}" timed out or crashed without an exit code; clean failure required.`;
					return this.failValidation(opCtx, reason);
				}

				// Expected code cannot be 0
				if (controlExecution.exitCode === 0) {
					const reason = `Negative control "${control.description}" failed: script unexpectedly succeeded or did not produce expected error on invalid input. Exit: 0`;
					return this.failValidation(opCtx, reason);
				}

				const passedCode =
					control.expectedExitCode !== undefined
						? controlExecution.exitCode === control.expectedExitCode
						: controlExecution.exitCode !== 0;

				let passedPattern = true;
				if (control.expectedError) {
					passedPattern =
						controlExecution.stderr.includes(control.expectedError) ||
						controlExecution.stdout.includes(control.expectedError);
				}

				const controlPassed = passedCode && passedPattern;
				negativeResults.push({
					description: control.description,
					args: control.args,
					exitCode: controlExecution.exitCode,
					passed: controlPassed,
					...(controlPassed
						? {}
						: {
								error: boundedUtf8Excerpt(
									`Expected non-zero exit/error pattern not met. Exit: ${controlExecution.exitCode}`,
								),
							}),
				});

				if (!controlPassed) {
					const reason = `Negative control "${control.description}" failed: script unexpectedly succeeded or did not produce expected error on invalid input. Exit: ${controlExecution.exitCode}`;
					return this.failValidation(opCtx, reason);
				}
			}

			// Re-hash script after validation to verify no concurrent disk modifications occurred
			const endHash = this.hashPort.computeFileHash(automation.path, cwd);
			if (!endHash || endHash !== initialHash) {
				const reason = "Script was modified on disk during validation. Validation aborted.";
				return this.failValidation(opCtx, reason);
			}

			// Per-operation fencing
			if (!this.isOperationCurrent(opCtx)) {
				const reason = "Intervening mutation occurred during validation. Obsolete validation discarded.";
				return { success: false, state: "building", reason };
			}

			const evidence: TaskAutomationEvidence = {
				scriptHash: endHash,
				verifiedAt: new Date().toISOString(),
				verifierExitCode: positiveExecution.exitCode,
				verifierStdout: boundedUtf8Excerpt(positiveExecution.stdout),
				verifierStderr: boundedUtf8Excerpt(positiveExecution.stderr),
				negativeControls: negativeResults,
				workspaceCwd: cwd,
			};

			this.updateAutomation(automation.name, (existing) => ({
				...existing,
				state: "ready",
				evidence,
				workspaceCwd: cwd,
				activeToken: undefined,
				updatedAt: new Date().toISOString(),
			}));

			validationSucceeded = true;
			return { success: true, state: "ready", evidence };
		} finally {
			if (!validationSucceeded) {
				if (this.isOperationCurrent(opCtx)) {
					this.updateAutomation(automation.name, (existing) => ({
						...existing,
						state: "failed",
						activeToken: undefined,
						updatedAt: new Date().toISOString(),
					}));
				}
			}
		}
	}

	/**
	 * Run an admitted task automation using the existing toolkit script runner.
	 * Hash check on disk before and after execution; output contract validated;
	 * fenced by per-operation token and generation.
	 */
	async run(name: string, args: readonly string[], signal?: AbortSignal): Promise<RunTaskAutomationResult> {
		this.ensureRefreshedScope();
		if (signal?.aborted) {
			return {
				outcome: "failed",
				error: "Execution was aborted prior to start.",
			};
		}

		if (!Value.Check(TaskAutomationBindingSchema.properties.expectedArgs, args)) {
			return {
				outcome: "failed",
				error: "Run arguments violate schema bounds (must be array of strings, max length 500 each, max count 64).",
			};
		}

		const automation = this.getInternalAutomation(name);
		if (!automation) {
			return { outcome: "failed", error: `Automation "${name}" not found.` };
		}

		if (automation.state === "validating") {
			return {
				outcome: "failed",
				error: `Automation "${name}" is currently validating; concurrent run rejected.`,
			};
		}
		if (automation.state === "executing") {
			return {
				outcome: "failed",
				error: `Automation "${name}" is currently executing; concurrent run rejected.`,
			};
		}

		if (automation.state !== "ready" || !automation.evidence) {
			return {
				outcome: "failed",
				error: `Automation "${name}" is in state "${automation.state}". It must be successfully validated before execution.`,
			};
		}

		// Reject mismatched cwd even if file bytes are identical
		const cwd = this.contextPort.getCwd();
		if (automation.workspaceCwd && automation.workspaceCwd !== cwd) {
			return {
				outcome: "failed",
				error: `Automation "${name}" is scoped to directory "${automation.workspaceCwd}", but current working directory is "${cwd}". Execution rejected.`,
			};
		}
		if (automation.evidence.workspaceCwd && automation.evidence.workspaceCwd !== cwd) {
			return {
				outcome: "failed",
				error: `Automation "${name}" was validated in directory "${automation.evidence.workspaceCwd}", but current working directory is "${cwd}". Execution rejected.`,
			};
		}

		const prepared = await this.prepareAuthorizedExecution(automation, args, "Execution", signal);
		if (!prepared.authorized) {
			return {
				outcome: "failed",
				error: prepared.reason,
			};
		}

		if (
			!this.isPreClaimScopeAndIdentityCurrent(
				automation.name,
				prepared.initialGeneration,
				prepared.initialToken,
				prepared.opCtx.cwd,
				prepared.opCtx.sessionId,
				prepared.opCtx.branchId,
				"ready",
			)
		) {
			return {
				outcome: "failed",
				error: "Automation was modified during authorization. Execution aborted.",
			};
		}

		const { opCtx, detachedScript, detachedArgs } = prepared;

		const current = this.getInternalAutomation(automation.name);
		const initialHash = this.hashPort.computeFileHash(automation.path, cwd);
		if (!initialHash || initialHash !== current?.evidence?.scriptHash) {
			// Hash drift invalidates evidence immediately!
			this.updateAutomation(automation.name, (existing) => ({
				...existing,
				state: "building",
				evidence: undefined,
				activeToken: undefined,
				updatedAt: new Date().toISOString(),
			}));
			return {
				outcome: "failed",
				error: `Script "${automation.path}" has been modified on disk since validation. Verification evidence invalidated; re-validation required.`,
			};
		}

		const runId = randomUUID();
		const startedAt = new Date().toISOString();

		// Fenced commit to executing
		this.updateAutomation(automation.name, (existing) => ({
			...existing,
			state: "executing",
			activeToken: opCtx.operationToken,
			lastExecution: {
				runId,
				exitCode: null,
				stdout: "",
				stderr: "",
				durationMs: 0,
				startedAt,
				completedAt: "",
				outcome: "failed",
				args: [...detachedArgs],
			},
			updatedAt: startedAt,
		}));

		let execution: ScriptExecution | undefined;
		let executionError: Error | undefined;

		try {
			execution = await executeToolkitScript({
				script: detachedScript,
				scriptArgs: detachedArgs,
				cwd,
				signal,
				executor: this.executor,
			});
		} catch (err) {
			executionError = err instanceof Error ? err : new Error(String(err));
		}

		const completedAt = new Date().toISOString();

		// Check per-operation fencing on failure branch
		if (executionError) {
			const boundedError = boundedUtf8Excerpt(executionError.message);
			if (this.isOperationCurrent(opCtx)) {
				this.updateAutomation(automation.name, (existing) => ({
					...existing,
					state: "failed",
					evidence: undefined,
					activeToken: undefined,
					lastExecution: {
						runId,
						exitCode: null,
						stdout: "",
						stderr: boundedError,
						durationMs: 0,
						startedAt,
						completedAt,
						outcome: "failed",
						args: [...detachedArgs],
						error: boundedError,
					},
					updatedAt: completedAt,
				}));
			}
			return { outcome: "failed", error: boundedError };
		}

		// Check per-operation fencing on normal completion
		if (!this.isOperationCurrent(opCtx)) {
			return {
				outcome: "failed",
				execution,
				error: "Intervening mutation occurred during execution. Obsolete execution discarded.",
			};
		}

		// Check post-execution hash
		const endHash = this.hashPort.computeFileHash(automation.path, cwd);
		const hashIntact = endHash === automation.evidence.scriptHash;

		let isSuccess = !execution!.timedOut && execution!.exitCode === 0 && hashIntact && !signal?.aborted;
		let errorMessage: string | undefined;

		if (signal?.aborted) {
			isSuccess = false;
			errorMessage = "Execution aborted.";
		} else if (execution!.timedOut) {
			isSuccess = false;
			errorMessage = "Script execution timed out.";
		} else if (execution!.exitCode !== 0) {
			isSuccess = false;
			errorMessage = execution!.stderr || `Exited with code ${execution!.exitCode}`;
		} else if (!hashIntact) {
			isSuccess = false;
			errorMessage = "Script was modified on disk during execution.";
		}

		// Output contract check using evaluateOutputContract (finite literal check)
		if (isSuccess) {
			const outputCheck = evaluateOutputContract(automation.contract.outputs, execution!.stdout);
			if (!outputCheck.valid) {
				isSuccess = false;
				errorMessage = outputCheck.error;
			}
		}

		const boundedErrorMessage = errorMessage ? boundedUtf8Excerpt(errorMessage) : undefined;

		const executionResult: TaskAutomationExecutionResult = {
			runId,
			exitCode: execution!.exitCode,
			stdout: boundedUtf8Excerpt(execution!.stdout),
			stderr: boundedUtf8Excerpt(execution!.stderr),
			durationMs: execution!.durationMs,
			startedAt,
			completedAt,
			outcome: isSuccess ? "succeeded" : "failed",
			args: [...detachedArgs],
			...(boundedErrorMessage ? { error: boundedErrorMessage } : {}),
		};

		// Fenced commit completion
		this.updateAutomation(automation.name, (existing) => ({
			...existing,
			state: hashIntact ? (isSuccess ? "ready" : "failed") : "building",
			evidence: hashIntact && isSuccess ? existing.evidence : undefined,
			activeToken: undefined,
			lastExecution: executionResult,
			updatedAt: completedAt,
		}));

		return {
			outcome: isSuccess ? "succeeded" : "failed",
			execution,
			...(boundedErrorMessage ? { error: boundedErrorMessage } : {}),
		};
	}

	/**
	 * Return admitted ToolkitScript definitions for all ready automations whose hash is intact
	 * and scoped to the current working directory.
	 */
	getAdmittedScripts(): readonly ToolkitScript[] {
		this.ensureRefreshedScope();
		const cwd = this.contextPort.getCwd();
		const scripts: ToolkitScript[] = [];
		for (const automation of this.state.automations) {
			if (automation.state !== "ready" || !automation.evidence) continue;
			if (automation.evidence.workspaceCwd && automation.evidence.workspaceCwd !== cwd) continue;
			if (automation.workspaceCwd && automation.workspaceCwd !== cwd) continue;
			const diskHash = this.hashPort.computeFileHash(automation.path, cwd);
			if (diskHash === automation.evidence.scriptHash) {
				scripts.push(taskAutomationToToolkitScript(automation));
			}
		}
		return scripts;
	}

	/**
	 * Execute an admitted script by name, routing execution strictly through `run()`.
	 * Propagates failure: non-zero exit and error details returned when contract fails.
	 */
	async executeAdmittedScript(name: string, args: readonly string[], signal?: AbortSignal): Promise<ScriptExecution> {
		const result = await this.run(name, args, signal);
		if (result.outcome === "succeeded" && result.execution) {
			return result.execution;
		}
		const fallbackStderr = result.error ?? `Task automation "${name}" failed contract validation or execution.`;
		return {
			exitCode: result.execution?.exitCode && result.execution.exitCode !== 0 ? result.execution.exitCode : 1,
			stdout: result.execution?.stdout ?? "",
			stderr: result.execution?.stderr ? `${result.execution.stderr}\n${fallbackStderr}` : fallbackStderr,
			durationMs: result.execution?.durationMs ?? 0,
			timedOut: result.execution?.timedOut ?? false,
		};
	}
}
