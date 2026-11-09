/**
 * The refusal a cost bound raises before it sends a provider request: a run's bound or a budgeted delegation's. The budget
 * coordinator throws it and the worker runner reads its typed identity (the refusing aggregate's key and the refusal
 * code), so a refusal is attributed by a field, never by its message. It lives apart from the coordinator so the runner
 * classifies a refusal without loading the coordinator.
 */

import { BoundedCompletionFailureError } from "../autonomy/bounded-completion.ts";

/**
 * A cost bound (a run's or a budgeted delegation's) refused a request before it was sent (`budget_exhausted`, terminal:
 * a retry would price the same request against the same remainder). The message also names the refusing aggregate, by
 * `costRefusalTokenFor`, for a human reading the diagnostic.
 */
export class WorkerRunCostRefusal extends BoundedCompletionFailureError {
	/** The refusing aggregate's key: the identity a reader attributes the refusal to. */
	readonly treeKey: string;

	constructor(treeKey: string, reasonCode: string, message: string) {
		super("budget_exhausted", reasonCode, message);
		this.name = "WorkerRunCostRefusal";
		this.treeKey = treeKey;
	}
}
