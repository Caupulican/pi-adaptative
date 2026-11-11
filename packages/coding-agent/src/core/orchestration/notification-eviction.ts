/**
 * Capacity management for orchestration notifications: identifies delivered notifications that are
 * not structurally bound to a retained approval (`approval-requested:*`) or retained attempt
 * (`worker-terminal:*`), and evicts the oldest unbound delivered entries before refusing capacity.
 */

import { MAX_ORCHESTRATION_NOTIFICATIONS } from "./contracts.ts";
import { assertRecordHasCapacity } from "./task-runtime-projection.ts";
import type { NotificationRuntimeState, TaskRuntimeProjection } from "./task-runtime-state.ts";

export const APPROVAL_NOTIFICATION_PREFIX = "approval-requested:";
export const WORKER_TERMINAL_NOTIFICATION_PREFIX = "worker-terminal:";

/**
 * True when `notification` is delivered and neither a retained approval's `approval-requested:*`
 * nor a retained attempt's `worker-terminal:*`. `released` treats records slated for deletion in
 * the same retention pass as no longer retained.
 */
export function isUnboundDeliveredNotification(
	state: Pick<TaskRuntimeProjection, "approvals" | "attempts">,
	notification: NotificationRuntimeState,
	released?: {
		readonly approvalIds: ReadonlySet<string>;
		readonly attemptIds: ReadonlySet<string>;
	},
): boolean {
	if (notification.status !== "delivered") return false;
	const id = notification.notificationId;
	if (id.startsWith(APPROVAL_NOTIFICATION_PREFIX)) {
		const approvalId = id.slice(APPROVAL_NOTIFICATION_PREFIX.length);
		return !Object.hasOwn(state.approvals, approvalId) || (released?.approvalIds.has(approvalId) ?? false);
	}
	if (id.startsWith(WORKER_TERMINAL_NOTIFICATION_PREFIX)) {
		const attemptId = id.slice(WORKER_TERMINAL_NOTIFICATION_PREFIX.length);
		return !Object.hasOwn(state.attempts, attemptId) || (released?.attemptIds.has(attemptId) ?? false);
	}
	return true;
}

function compareNotificationAge(left: NotificationRuntimeState, right: NotificationRuntimeState): number {
	const leftDelivered = Date.parse(left.deliveredAt ?? left.createdAt);
	const rightDelivered = Date.parse(right.deliveredAt ?? right.createdAt);
	if (leftDelivered !== rightDelivered) return leftDelivered - rightDelivered;
	const leftCreated = Date.parse(left.createdAt);
	const rightCreated = Date.parse(right.createdAt);
	if (leftCreated !== rightCreated) return leftCreated - rightCreated;
	return left.notificationId < right.notificationId ? -1 : left.notificationId > right.notificationId ? 1 : 0;
}

/** Pre-commit check for `DurableTaskRuntime`: allows admission when an unbound delivered notification can make room. */
export function assertNotificationCapacity(
	state: Pick<TaskRuntimeProjection, "approvals" | "attempts" | "notifications">,
): void {
	if (Object.keys(state.notifications).length < MAX_ORCHESTRATION_NOTIFICATIONS) return;
	if (Object.values(state.notifications).some((n) => isUnboundDeliveredNotification(state, n))) return;
	assertRecordHasCapacity(state.notifications, MAX_ORCHESTRATION_NOTIFICATIONS, "notification");
}

/** Reducer-side eviction before inserting a new notification into the hot projection. */
export function ensureNotificationCapacity(
	state: Pick<TaskRuntimeProjection, "approvals" | "attempts">,
	notifications: Record<string, NotificationRuntimeState>,
): void {
	const overflow = Object.keys(notifications).length - MAX_ORCHESTRATION_NOTIFICATIONS + 1;
	if (overflow > 0) {
		const evictable = Object.values(notifications)
			.filter((n) => isUnboundDeliveredNotification(state, n))
			.sort(compareNotificationAge);
		for (const victim of evictable.slice(0, overflow)) {
			delete notifications[victim.notificationId];
		}
	}
	assertRecordHasCapacity(notifications, MAX_ORCHESTRATION_NOTIFICATIONS, "notification");
}
