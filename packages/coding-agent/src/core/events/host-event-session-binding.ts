/**
 * Opens the host-event binding of a session (`HostEventSessionController`) over its coordinator's ports: the binding is the
 * session's, fenced to the session manager, id and file it was opened for, and every accepted event lands in the shared
 * task ledger. The coordinator (`BackgroundLaneController`) keeps the open bindings and the last root delivery.
 */
import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import type { WorkerDelegationController } from "../delegation/worker-delegation-controller.ts";
import { captureWorkerReceiptOrigin } from "../delegation/worker-receipt-origin.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import {
	MAX_TURN_WAKES_HOLD,
	type ParentWakeDelivery,
	parentTurnWakes,
	rollingDayWindow,
} from "../proactivity/proactivity-controller.ts";
import type { CiAttemptTerminalEvent } from "./host-event-contract.ts";
import { HostEventSessionController, type HostEventSessionControllerDeps } from "./host-event-session-controller.ts";

export interface HostEventSessionBindingPorts {
	readonly deps: BackgroundLaneControllerDeps;
	/** The shared task ledger's runtime; read once the binding is known current. */
	runtime(): DurableTaskRuntime;
	workerController(): Pick<WorkerDelegationController, "getAgentControl">;
	rootDelivered(delivery: ParentWakeDelivery): void;
	/** The parent-input port a root delivery is appended through (the coordinator's outward call site). */
	deliverParent: HostEventSessionControllerDeps["deliverParent"];
	/**
	 * Whether a CI result reaches the session through one of its own watches, which makes its root delivery a copy. A
	 * delivery whose input the transcript already holds is the delivery's to reconcile, never settled as a copy.
	 */
	reportedByWatch(event: CiAttemptTerminalEvent): boolean;
	warn(message: string): void;
	retired(controller: HostEventSessionController): void;
}

export function openHostEventSessionBinding(
	ports: HostEventSessionBindingPorts,
	signal: AbortSignal,
): HostEventSessionController {
	const { deps } = ports;
	const manager = deps.getSessionManager();
	const sessionId = manager.getSessionId();
	const sessionFile = manager.getSessionFile();
	const assertCurrent = () => {
		signal.throwIfAborted();
		if (
			deps.isDisposed() ||
			deps.getSessionManager() !== manager ||
			manager.getSessionId() !== sessionId ||
			manager.getSessionFile() !== sessionFile
		)
			throw new Error("Host events belong to a retired session.");
	};
	assertCurrent();
	return new HostEventSessionController({
		runtime: ports.runtime(),
		agentDir: deps.getAgentDir(),
		sessionId,
		signal,
		assertCurrent,
		captureOrigin: () => captureWorkerReceiptOrigin(manager, assertCurrent),
		canDeliver: () => !deps.isDisposed() && deps.getSettingsManager().getProactivitySettings().enabled,
		subscribeContext: (listener) => deps.subscribeForegroundActivity(listener),
		subscribeSettings: (listener) => deps.getSettingsManager().subscribeChanges(listener),
		admitRootDelivery: async (deliveryId) => {
			// A replay must repeat the saved metadata, so a saved delivery is never measured again.
			const saved = manager.getParentInput(deliveryId);
			if (saved) return { mode: saved.metadata.mode };
			const nowMs = deps.getTimers().port("proactivity").now();
			const day = await deps.aggregateUsageWindow(rollingDayWindow(nowMs));
			return parentTurnWakes(day) >= deps.getSettingsManager().getProactivitySettings().maxTurnWakesPerDay
				? { mode: "next-owner-turn", hold: MAX_TURN_WAKES_HOLD }
				: { mode: "turn" };
		},
		rootDelivered: (delivery) => ports.rootDelivered(delivery),
		reportedByWatch: (event, deliveryId) =>
			manager.getParentInput(deliveryId) === undefined && ports.reportedByWatch(event),
		deliverParent: (input, options) => ports.deliverParent(input, options),
		heldParentInputs: () =>
			manager.getPendingParentInputs("next-owner-turn").map((input) => input.metadata.deliveryId),
		skipParentInput: (deliveryId, reason) => manager.skipPendingParentInput(deliveryId, reason),
		deliverTask: async (delivery, active) => {
			const control = ports.workerController().getAgentControl();
			return control.deliverHostEvent ? control.deliverHostEvent(delivery, active) : "unavailable";
		},
		reconcileTask: (delivery) => {
			const control = ports.workerController().getAgentControl();
			if (!control.reconcileHostEventDelivery) throw new Error("Host event reconciliation is unavailable.");
			control.reconcileHostEventDelivery(delivery);
		},
		observeNotice: (kind, read) => deps.observeHarnessNotice?.(kind, read),
		warn: (message) => ports.warn(message),
		retired: (retired) => ports.retired(retired),
	});
}
