/** Chooses an eligible executor for an objective route and owns the worker admission and release. */
import { harnessLog } from "../../kernel/harness-log.ts";
import type { ResponsibilityStatement } from "../dedup/index.ts";
import { type ExpertBinding, NoEligibleExpertError } from "../expert-routing/contracts.ts";
import { buildWorkerCapabilityRequest } from "../expert-routing/request-builder.ts";
import type { ExpertSelectionResult } from "../expert-routing/service.ts";
import type { WorkerResultContract } from "../orchestration/contracts.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { ObjectiveExecutionControllerDeps } from "./objective-execution-controller.ts";
import { completionFailuresToRepairWork } from "./objective-repair-work.ts";
import {
	type ObjectiveRoute,
	type ObjectiveRouteExecutor,
	type ObjectiveTerminalResult,
	PENDING_WORKER_EXECUTOR,
	SCOPE_REPLAN_EXECUTOR,
	type WorkerRouteAdmission,
} from "./objective-route.ts";
import {
	INDEPENDENT_VERIFICATION_REASON_CODE,
	SAME_LANE_VERIFICATION_RECOVERY_REASON_CODE,
} from "./objective-route-policy.ts";

interface RouteExecutionPorts {
	deps: Pick<
		ObjectiveExecutionControllerDeps,
		"rootExecutor" | "workerDispatcher" | "chooseExecutor" | "expertSelector" | "responsibilityController" | "runtime"
	>;
	cycle: number;
	assertCurrent(): void;
	noteExecutor(executor: string): Promise<void>;
	noteBinding(taskId: string, binding: ExpertBinding): void;
	refuse(reasonCodes: readonly string[]): Promise<ObjectiveTerminalResult>;
}

/** Preserve an admitted execution even if the executor later rejects or the caller loses custody. */
export async function observeRouteSubmission<T>(
	run: (admit: () => void) => Promise<T>,
	note: () => Promise<void>,
): Promise<T> {
	let receipt: Promise<void> | undefined;
	let returned = false;
	const admit = () => {
		if (receipt) return;
		receipt = note();
		// Queued work can start after its caller returns; that checkpoint has no waiting caller.
		const late = returned;
		void receipt.catch((error: unknown) => {
			if (late)
				harnessLog.warn("delegation", "a delayed worker start could not be checkpointed", () => ({
					error: error instanceof Error ? error.message : String(error),
				}));
		});
	};
	try {
		return await run(admit);
	} finally {
		returned = true;
		await receipt;
	}
}

export function executeObjectiveWorker(
	run: (admit: () => void) => Promise<WorkerRouteAdmission> | Promise<void>,
	note: () => Promise<void>,
): Promise<WorkerRouteAdmission | undefined> {
	return observeRouteSubmission(async (admit) => {
		const result = await run(admit);
		if (result?.started !== false) admit();
		return result || undefined;
	}, note);
}

/** A dedicated, single-stage executor accepts the route when its execution method is invoked. */
export function runAdmittedRoute<T>(run: () => Promise<T>, note: () => Promise<void>): Promise<T> {
	return observeRouteSubmission((admit) => {
		admit();
		return run();
	}, note);
}

export async function executeObjectiveSpecialist(
	run: (submitted: () => void) => Promise<WorkerResultContract | WorkerRouteAdmission>,
	note: (executor: string) => Promise<void>,
): Promise<WorkerResultContract | undefined> {
	const result = await observeRouteSubmission(run, () => note("worker:escalated"));
	if (!("started" in result)) {
		await note("worker:escalated");
		return result;
	}
	if (result.started) await note("worker:escalated");
	else if (result.pending) await note(PENDING_WORKER_EXECUTOR);
	else throw new Error(`Specialist did not start: ${result.reason}`);
	return undefined;
}

export async function executeObjectiveRetrieval(
	retrieval: NonNullable<ObjectiveExecutionControllerDeps["retrieval"]>,
	route: ObjectiveRoute,
	signal: AbortSignal | undefined,
	note: (executor: string) => Promise<void>,
): Promise<void> {
	let executor: string = route.route;
	const result = await observeRouteSubmission(
		(admit) => {
			if (!retrieval.reportsAdmission) admit();
			return retrieval.execute(route, signal, (actual) => {
				executor = actual;
				admit();
			});
		},
		() => note(executor),
	);
	if (result) await note(result);
}

export function executeWithRouteAdmission(
	executor: ObjectiveRouteExecutor,
	route: ObjectiveRoute,
	signal: AbortSignal | undefined,
	note: () => Promise<void>,
): Promise<void> {
	signal?.throwIfAborted();
	return observeRouteSubmission((admit) => {
		if (!executor.reportsAdmission) admit();
		return executor.execute(route, signal, admit);
	}, note);
}

export async function dispatchObjectiveRoute(
	ports: RouteExecutionPorts,
	objectiveId: string,
	route: ObjectiveRoute,
	runtime: TaskRuntimeProjection,
	escalated: boolean,
	signal?: AbortSignal,
): Promise<ObjectiveTerminalResult | undefined> {
	ports.assertCurrent();
	const independent =
		escalated || route.route === "review" || route.reason_codes.includes(INDEPENDENT_VERIFICATION_REASON_CODE);
	const root = independent ? undefined : ports.deps.rootExecutor;
	const runRoot = async (executor: NonNullable<typeof root>): Promise<undefined> => {
		signal?.throwIfAborted();
		ports.assertCurrent();
		await executeWithRouteAdmission(executor, route, signal, () => ports.noteExecutor("root"));
		return undefined;
	};
	const dispatcher = escalated
		? ports.deps.workerDispatcher?.dispatchEscalated
		: ports.deps.workerDispatcher?.dispatch;
	if (
		root &&
		(!dispatcher ||
			route.reason_codes.includes(SAME_LANE_VERIFICATION_RECOVERY_REASON_CODE) ||
			route.reason_codes.includes("requirement_prerequisites_unmet") ||
			(ports.deps.chooseExecutor?.(route) ?? "root") === "root")
	)
		return runRoot(root);

	const unavailable = async (reasonCodes: readonly string[]): Promise<ObjectiveTerminalResult | undefined> => {
		ports.assertCurrent();
		if (root) return runRoot(root);
		const refused =
			ports.deps.runtime.recordExecutorRefusal?.(objectiveId, route, reasonCodes) ??
			(await ports.refuse(reasonCodes));
		if (refused.reasonCodes.includes("executor_scope_replan_required") && ports.deps.rootExecutor) {
			signal?.throwIfAborted();
			ports.assertCurrent();
			await executeWithRouteAdmission(
				ports.deps.rootExecutor,
				{
					...route,
					route: "replan",
					target_requirement_ids: [],
					reason_codes: ["executor_scope_replan_required", ...reasonCodes],
				},
				signal,
				() => ports.noteExecutor(SCOPE_REPLAN_EXECUTOR),
			);
		}
		return refused;
	};
	if (!dispatcher)
		return unavailable([
			`missing_required_executor:workerDispatcher.${escalated ? "dispatchEscalated" : "dispatch"}`,
		]);

	let binding: ExpertBinding | undefined;
	let selectionResult: ExpertSelectionResult | undefined;
	const taskId = `${objectiveId}-${escalated ? "escalate" : route.route}-${ports.cycle}`;
	if (ports.deps.expertSelector) {
		const priorAttempts = Object.values(runtime.attempts).filter(
			(attempt) => runtime.tasks[attempt.taskId]?.task.objectiveId === objectiveId,
		);
		const consequence = escalated
			? "critical"
			: route.route === "verify" || route.route === "review"
				? "high"
				: "medium";
		const request = buildWorkerCapabilityRequest({
			objectiveId,
			taskId,
			route,
			consequence,
			decisionSignals: {
				capabilityEscalationRequired: escalated,
				independentWorkerRequired:
					route.route === "review" || route.reason_codes.includes(INDEPENDENT_VERIFICATION_REASON_CODE),
			},
			priorAttempts,
		});
		try {
			// System One judges the category from the objective's own words; the ranking only falls back.
			const objectiveRecord = runtime.objectives[objectiveId]?.objective;
			selectionResult = await ports.deps.expertSelector.select(request, {
				signal,
				requestText: [objectiveRecord?.title, objectiveRecord?.description, route.route].filter(Boolean).join("\n"),
			});
			binding = selectionResult.primary;
		} catch (error) {
			if (error instanceof NoEligibleExpertError) {
				const rejected = new Set(error.rejectedCandidates.flatMap((candidate) => candidate.reasonCodes));
				return unavailable(["no_eligible_expert", ...rejected]);
			}
			throw error;
		}
	}

	try {
		// FC-040: Pre-implementation responsibility guard before material write
		let responsibilityStatement: ResponsibilityStatement | undefined;
		if (route.route === "implement" && ports.deps.responsibilityController) {
			responsibilityStatement = {
				statement: `Implementation for ${objectiveId} (${route.route})`,
				targetLocation: `packages/coding-agent/src/core/${objectiveId}`,
			};
			await ports.deps.responsibilityController.preImplementation({
				objectiveId,
				taskId,
				proposed: responsibilityStatement,
				signal,
			});
		}

		ports.assertCurrent();
		signal?.throwIfAborted();
		const workerExecutor = escalated ? "worker:escalated" : "worker";
		const admission = await executeObjectiveWorker(
			(admit) => dispatcher(route, signal, binding, admit),
			() => ports.noteExecutor(workerExecutor),
		);
		ports.assertCurrent();
		if (admission?.started === false) {
			if (admission.pending) {
				await ports.noteExecutor(PENDING_WORKER_EXECUTOR);
				return;
			}
			if (selectionResult) ports.deps.expertSelector?.release(selectionResult);
			selectionResult = undefined;
			return unavailable(["worker_admission_refused", admission.reason]);
		}
		if (binding) ports.noteBinding(taskId, binding);

		// FC-041: Post-mutation responsibility guard before task acceptance
		if (route.route === "implement" && ports.deps.responsibilityController && responsibilityStatement) {
			const artifacts = (await ports.deps.runtime.getArtifacts?.(objectiveId)) ?? [];
			const changedFiles =
				artifacts.length > 0 ? artifacts.map((a) => a.path) : [responsibilityStatement.targetLocation];
			for (const mutatedFile of changedFiles) {
				const postVerdict = await ports.deps.responsibilityController.postMutation({
					objectiveId,
					taskId,
					responsibility: responsibilityStatement,
					mutatedFile,
					signal,
				});
				if (postVerdict.unintentionalDuplicate) {
					if (ports.deps.runtime.ensureRepairTasks) {
						const repairs = completionFailuresToRepairWork(
							[{ gate_id: "duplicate_responsibility_detected" }],
							objectiveId,
						);
						await ports.deps.runtime.ensureRepairTasks(objectiveId, repairs);
					}
					throw new Error(`Semantic duplicate responsibility detected in ${mutatedFile} (FC-041)`);
				}
			}
		}
	} finally {
		if (selectionResult && ports.deps.expertSelector) {
			ports.deps.expertSelector.release(selectionResult);
		}
	}
	return undefined;
}
