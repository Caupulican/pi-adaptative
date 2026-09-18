import { isBoundedFailureCode } from "./tool-failure-code.ts";
import { readWireRecord } from "./wire-record.ts";

const POSTPROCESSING_FAILURE_NAMES = ["progress", "after_hook", "cleanup"] as const;
type ToolPostprocessingFailure = (typeof POSTPROCESSING_FAILURE_NAMES)[number];
const POSTPROCESSING_FAILURES = new Set<ToolPostprocessingFailure>(POSTPROCESSING_FAILURE_NAMES);

/** Engine evidence, independent of hook policy, display status, and verification claims. */
export type ToolInvocationReceipt = Readonly<{
	version: 1;
	requestId: string;
	/** Opaque exact binding identity, never provider-supplied arguments or a raw local path. */
	executionScope?: string;
	/** Effective executor timeout captured before execution. Null means declared but unavailable. */
	timeoutMs?: number | null;
	postprocessingFailures: readonly ToolPostprocessingFailure[];
}> &
	(
		| Readonly<{ execution: "not_started"; operationStatus?: never; failureCode?: "aborted" }>
		| Readonly<{ execution: "running"; operationStatus?: never; failureCode?: never }>
		| Readonly<{ execution: "unknown"; operationStatus?: never; failureCode?: string }>
		| Readonly<{ execution: "completed"; operationStatus: "success"; failureCode?: never }>
		| Readonly<{ execution: "completed"; operationStatus: "error"; failureCode?: string }>
	);

const RECEIPT_KEYS = new Set([
	"version",
	"requestId",
	"execution",
	"operationStatus",
	"postprocessingFailures",
	"executionScope",
	"failureCode",
	"timeoutMs",
]);

/** Strict bounded data-only wire decoder. It never upgrades missing historical evidence. */
export function decodeToolInvocationReceipt(value: unknown): ToolInvocationReceipt | undefined {
	const record = readWireRecord(value, RECEIPT_KEYS);
	if (!record) return undefined;
	const { version, requestId, execution, operationStatus, executionScope, failureCode, timeoutMs } = record;
	if (
		Object.hasOwn(record, "timeoutMs") &&
		((timeoutMs !== null && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) ||
			(execution !== "completed" && execution !== "unknown"))
	) return undefined;
	if (
		Object.hasOwn(record, "failureCode") &&
		(!isBoundedFailureCode(failureCode) ||
			!(execution === "unknown" || (execution === "completed" && operationStatus === "error") ||
				(execution === "not_started" && failureCode === "aborted")))
	) return undefined;
	if (
		Object.hasOwn(record, "executionScope") &&
		(typeof executionScope !== "string" || !/^context:[0-9a-f]{32}$/.test(executionScope))
	)
		return undefined;
	const failures = record.postprocessingFailures;
	if (
		version !== 1 ||
		typeof requestId !== "string" ||
		requestId.length === 0 ||
		requestId.length > 256 ||
		!/^[A-Za-z0-9._:-]+$/.test(requestId) ||
		!Array.isArray(failures) ||
		failures.length > POSTPROCESSING_FAILURES.size ||
		Reflect.ownKeys(failures).length !== failures.length + 1
	)
		return undefined;
	const postprocessingFailures: ToolPostprocessingFailure[] = [];
	for (let index = 0; index < failures.length; index++) {
		const item = Object.getOwnPropertyDescriptor(failures, index)?.value;
		if (!POSTPROCESSING_FAILURES.has(item) || postprocessingFailures.includes(item)) return undefined;
		postprocessingFailures.push(item);
	}
	const base = {
		version: 1 as const,
		requestId,
		postprocessingFailures: Object.freeze(postprocessingFailures),
		...(typeof executionScope === "string" ? { executionScope } : {}),
		...(typeof timeoutMs === "number" || timeoutMs === null ? { timeoutMs } : {}),
	};
	if (execution === "completed") {
		if (operationStatus !== "success" && operationStatus !== "error") return undefined;
		if (operationStatus === "success") return Object.freeze({ ...base, execution, operationStatus });
		return Object.freeze({ ...base, execution, operationStatus, ...(typeof failureCode === "string" ? { failureCode } : {}) });
	}
	if (execution !== "not_started" && execution !== "running" && execution !== "unknown") return undefined;
	if (Object.hasOwn(record, "operationStatus") || (execution !== "unknown" && postprocessingFailures.length > 0))
		return undefined;
	if (execution === "unknown") {
		return Object.freeze({ ...base, execution, ...(typeof failureCode === "string" ? { failureCode } : {}) });
	}
	if (execution === "not_started" && failureCode === "aborted") {
		return Object.freeze({ ...base, execution, failureCode });
	}
	return Object.freeze({ ...base, execution });
}

export function retainedToolInvocation(details: unknown): ToolInvocationReceipt | undefined {
	if (!details || typeof details !== "object") return undefined;
	return decodeToolInvocationReceipt(Object.getOwnPropertyDescriptor(details, "piToolInvocation")?.value);
}

/** A thrown after-hook may mark presentation as erroneous without undoing a successful operation. */
export function isSuccessfulOperationWithHookFailure(details: unknown): boolean {
	const receipt = retainedToolInvocation(details);
	return (
		receipt?.execution === "completed" &&
		receipt.operationStatus === "success" &&
		receipt.postprocessingFailures.includes("after_hook")
	);
}

/** Called only by the engine after all tool/hook projections. Never invokes a forged receipt getter. */
export function stampToolInvocation(details: unknown, receipt: ToolInvocationReceipt): Record<string, unknown> {
	const validated = decodeToolInvocationReceipt(receipt);
	if (!validated) throw new TypeError("Invalid engine invocation receipt");
	const descriptors: PropertyDescriptorMap =
		details && typeof details === "object" ? Object.getOwnPropertyDescriptors(details) : {};
	delete descriptors.piToolInvocation;
	return Object.defineProperties(
		{},
		{
			...descriptors,
			piToolInvocation: { value: validated, enumerable: true, writable: false, configurable: false },
		},
	);
}
