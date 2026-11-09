/**
 * Decodes a worker result's `budgetRefusal` (`WorkerBudgetRefusalContract`): the aggregate a cost bound refused and the
 * refusal code it reported. A durable record with an unknown key or an oversized identifier fails where it is read. It
 * takes no codec from task-runtime-codecs, which imports this module, so it reads its scalars from codec-primitives.
 */

import { dispatchIdentifier } from "./codec-primitives.ts";
import type { WorkerBudgetRefusalContract } from "./contracts.ts";
import { exactRecord } from "./task-runtime-projection.ts";

export function budgetRefusalFromValue(value: unknown, label: string): WorkerBudgetRefusalContract {
	const refusal = exactRecord(value, label, ["treeKey", "reasonCode"]);
	return {
		treeKey: dispatchIdentifier(refusal.treeKey, `${label}.treeKey`),
		reasonCode: dispatchIdentifier(refusal.reasonCode, `${label}.reasonCode`),
	};
}
