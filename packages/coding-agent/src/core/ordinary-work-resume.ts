/** One receipt-based review of interrupted ordinary work after session restoration, under foreground ownership. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import type { OrdinaryWorkController, OrdinaryWorkRecord } from "./ordinary-work-controller.ts";
import { reviewOrdinaryWork } from "./ordinary-work-settlement.ts";
import type { SettlementJudges } from "./system-one/settlement-judges.ts";

const scheduled = new WeakSet<OrdinaryWorkController>();
const ownAdmission = new AsyncLocalStorage<true>();

export function hasPendingOrdinaryWorkResume(work: OrdinaryWorkController): boolean {
	return scheduled.has(work) && ownAdmission.getStore() !== true;
}

export function scheduleOrdinaryWorkResume(
	work: OrdinaryWorkController,
	foreground: ForegroundRecoveryController,
	judges: Pick<SettlementJudges, "decideOrdinaryWorkStop">,
	options: {
		readonly expected: OrdinaryWorkRecord;
		readonly manager: SessionManager;
		mayDispatch(): boolean;
		warn(message: string): void;
	},
): void {
	if (scheduled.has(work)) return;
	const assertBranch = options.manager.captureBranchContext();
	const mayDispatch = (): boolean => {
		try {
			assertBranch();
			return options.mayDispatch();
		} catch {
			return false;
		}
	};
	scheduled.add(work);
	foreground.wakeIdleWaiters();
	void ownAdmission
		.run(true, async () => {
			let lease: ForegroundSubmissionLease | undefined;
			try {
				lease = await foreground.acquireSubmission();
				foreground.beginTurnPreparation(lease);
				if (!mayDispatch() || !work.isCurrent(options.expected)) return;
				const owned = lease;
				const message = await reviewOrdinaryWork(work, judges, {
					expected: options.expected,
					signal: lease.signal,
					mayDispatch: () => {
						if (!mayDispatch()) return false;
						foreground.assertSubmissionCurrent(owned);
						return true;
					},
					warn: options.warn,
				});
				if (message && mayDispatch()) await foreground.runAgentPrompt(message, lease, lease.signal);
			} catch (error) {
				if (mayDispatch() && !lease?.signal.aborted)
					options.warn(
						`Ordinary work recovery stopped: ${error instanceof Error ? error.message : String(error)}`,
					);
			} finally {
				try {
					if (lease && foreground.ownsSubmission(lease)) foreground.releaseSubmission(lease);
				} finally {
					scheduled.delete(work);
					foreground.wakeIdleWaiters();
				}
			}
		})
		.catch((error: unknown) => options.warn(`Ordinary work recovery cleanup failed: ${String(error)}`));
}

/**
 * Review the ordinary work a restored session recovered (an interrupted request, or one whose launched work reported
 * while it waited), once, under foreground ownership. Restored run modes call it after extensions, subscriptions and
 * any runtime-update recovery are ready.
 */
export function resumeRecoveredOrdinaryWork(
	work: OrdinaryWorkController,
	foreground: ForegroundRecoveryController,
	judges: Pick<SettlementJudges, "decideOrdinaryWorkStop">,
	options: { readonly manager: SessionManager; warn(message: string): void },
): void {
	if (!work.mayReview()) return;
	const recovered = work.recover();
	if (recovered)
		scheduleOrdinaryWorkResume(work, foreground, judges, {
			expected: recovered.record,
			manager: options.manager,
			mayDispatch: () => work.mayReview(),
			warn: options.warn,
		});
}
