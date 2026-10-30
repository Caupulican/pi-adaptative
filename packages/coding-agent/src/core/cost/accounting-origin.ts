import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { isGoalExecutionActive } from "../goals/goal-state.ts";
import { getLatestGoalStateSnapshot } from "../goals/session-goal-state.ts";
import type { AccountingOrigin } from "./accounting-evidence.ts";

/** Capture attribution before asynchronous work. This grants no execution or replay authority. */
export function captureSessionAccountingOrigin(manager: SessionManager): AccountingOrigin {
	const goal = getLatestGoalStateSnapshot(manager);
	const entryId = manager.getLeafId();
	return Object.freeze({
		sessionId: manager.getSessionId(),
		...(entryId ? { entryId } : {}),
		...(goal && isGoalExecutionActive(goal.status) ? { goalId: goal.goalId } : {}),
	});
}
