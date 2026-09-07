import { readWireRecord } from "./wire-record.ts";

/** Engine evidence, independent of hook policy, display status, and verification claims. */
export type ToolInvocationReceipt = Readonly<{
	version: 1;
	requestId: string;
	/** Opaque exact binding identity, never provider-supplied arguments or a raw local path. */
	executionScope?: string;
	postprocessingFailures: readonly ("progress" | "after_hook")[];
}> &
	(
		| Readonly<{ execution: "not_started" | "running" | "unknown"; operationStatus?: never }>
		| Readonly<{ execution: "completed"; operationStatus: "success" | "error" }>
	);

const RECEIPT_KEYS = new Set([
	"version",
	"requestId",
	"execution",
	"operationStatus",
	"postprocessingFailures",
	"executionScope",
]);

/** Strict bounded data-only wire decoder. It never upgrades missing historical evidence. */
export function decodeToolInvocationReceipt(value: unknown): ToolInvocationReceipt | undefined {
	const record = readWireRecord(value, RECEIPT_KEYS);
	if (!record) return undefined;
	const { version, requestId, execution, operationStatus, executionScope } = record;
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
		failures.length > 2 ||
		Reflect.ownKeys(failures).length !== failures.length + 1
	)
		return undefined;
	const postprocessingFailures: ("progress" | "after_hook")[] = [];
	for (let index = 0; index < failures.length; index++) {
		const item = Object.getOwnPropertyDescriptor(failures, index)?.value;
		if ((item !== "progress" && item !== "after_hook") || postprocessingFailures.includes(item)) return undefined;
		postprocessingFailures.push(item);
	}
	const base = {
		version: 1 as const,
		requestId,
		postprocessingFailures: Object.freeze(postprocessingFailures),
		...(typeof executionScope === "string" ? { executionScope } : {}),
	};
	if (execution === "completed") {
		if (operationStatus !== "success" && operationStatus !== "error") return undefined;
		return Object.freeze({ ...base, execution, operationStatus });
	}
	if (execution !== "not_started" && execution !== "running" && execution !== "unknown") return undefined;
	if (Object.hasOwn(record, "operationStatus") || (execution !== "unknown" && postprocessingFailures.length > 0))
		return undefined;
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
