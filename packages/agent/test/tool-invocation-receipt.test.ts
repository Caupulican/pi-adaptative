import { describe, expect, it } from "vitest";
import { boundedFailureCode } from "../src/tool-failure-code.ts";
import {
	decodeToolInvocationReceipt,
	isSuccessfulOperationWithHookFailure,
	retainedToolInvocation,
	stampToolInvocation,
} from "../src/tool-invocation-receipt.ts";

const receipt = {
	version: 1,
	requestId: "fixture-request",
	execution: "completed",
	operationStatus: "success",
	postprocessingFailures: ["progress", "after_hook"],
} as const;

describe("invocation receipt wire boundary", () => {
	it.each([60_000, null])("round-trips an execution timeout snapshot %s", (timeoutMs) => {
		const candidate = { ...receipt, timeoutMs };
		expect(decodeToolInvocationReceipt(JSON.parse(JSON.stringify(candidate)))).toEqual(candidate);
	});

	it.each([undefined, 0, -1, Number.NaN, Infinity, "60000"])("rejects invalid timeout snapshots %#", (timeoutMs) => {
		expect(decodeToolInvocationReceipt({ ...receipt, timeoutMs })).toBeUndefined();
	});

	it.each(["running", "not_started"])("rejects an execution snapshot on %s", (execution) => {
		expect(decodeToolInvocationReceipt({
			version: 1, requestId: "fixture", execution, timeoutMs: 60_000, postprocessingFailures: [],
		})).toBeUndefined();
	});

	it("accepts the existing failure-code truncation marker", () => {
		const failureCode = boundedFailureCode(`${"x".repeat(47)} diagnostic`);
		expect(failureCode).toBe(`${"x".repeat(47)}…`);
		expect(decodeToolInvocationReceipt({ ...receipt, operationStatus: "error", failureCode }))
			.toMatchObject({ failureCode });
	});
	it("round-trips executor failure identity for completed errors and interrupted execution", () => {
		for (const outcome of [
			{ execution: "completed", operationStatus: "error", failureCode: "timeout" },
			{ execution: "unknown", failureCode: "aborted" },
		]) {
			const candidate = { version: 1, requestId: "fixture", postprocessingFailures: [], ...outcome };
			expect(decodeToolInvocationReceipt(JSON.parse(JSON.stringify(candidate)))).toEqual(candidate);
		}
	});

	it.each([undefined, "", " TIMEOUT ", "x".repeat(49), 1, "timeout\n"])(
		"rejects a malformed explicit failure identity %#", (failureCode) => {
			expect(decodeToolInvocationReceipt({ ...receipt, operationStatus: "error", failureCode })).toBeUndefined();
		},
	);

	it("rejects failure identities on successful or nonterminal receipts", () => {
		expect(decodeToolInvocationReceipt({ ...receipt, failureCode: "timeout" })).toBeUndefined();
		for (const execution of ["running", "not_started"]) {
			expect(decodeToolInvocationReceipt({
				version: 1, requestId: "fixture", execution, postprocessingFailures: [], failureCode: "timeout",
			})).toBeUndefined();
		}
	});

	it("round-trips a bounded execution scope without retaining directory text", () => {
		const candidate = { ...receipt, requestId: "x".repeat(256), executionScope: `context:${"a".repeat(32)}` };
		expect(decodeToolInvocationReceipt(JSON.parse(JSON.stringify(candidate)))).toEqual(candidate);
		expect(JSON.stringify(candidate).length).toBeLessThan(512);
	});

	it.each([undefined, "", "context:short", `context:${"a".repeat(33)}`, "D:\\private project", 1])(
		"rejects an explicitly invalid execution scope %#",
		(executionScope) => {
			expect(decodeToolInvocationReceipt({ ...receipt, executionScope })).toBeUndefined();
		},
	);

	it.each([
		{ candidate: receipt, expected: true },
		{ candidate: { ...receipt, operationStatus: "error" }, expected: false },
		{ candidate: { ...receipt, execution: "unknown", operationStatus: undefined }, expected: false },
		{ candidate: { ...receipt, postprocessingFailures: [] }, expected: false },
		{ candidate: { ...receipt, postprocessingFailures: ["progress"] }, expected: false },
		{ candidate: undefined, expected: false },
	])("only completed success plus an after-hook failure bypasses failure recovery %#", ({ candidate, expected }) => {
		expect(isSuccessfulOperationWithHookFailure({ piToolInvocation: candidate })).toBe(expected);
	});

	it("retains independent immutable evidence without retaining the input", () => {
		const input = JSON.parse(JSON.stringify(receipt));
		const decoded = decodeToolInvocationReceipt(input);
		expect(decoded).toEqual(receipt);
		input.postprocessingFailures.length = 0;
		input.operationStatus = "error";
		expect(decoded).toEqual(receipt);
		expect(Object.isFrozen(decoded)).toBe(true);
		expect(Object.isFrozen(decoded?.postprocessingFailures)).toBe(true);
	});

	it("bounds serialized evidence including the largest accepted request identity", () => {
		const decoded = decodeToolInvocationReceipt({ ...receipt, requestId: "x".repeat(256) });
		expect(decoded).toBeDefined();
		expect(JSON.stringify(decoded).length).toBeLessThan(512);
		expect(decodeToolInvocationReceipt({ ...receipt, requestId: "\ud800".repeat(256) })).toBeUndefined();
	});

	it.each([
		undefined,
		{},
		{ ...receipt, version: 2 },
		{ ...receipt, requestId: "" },
		{ ...receipt, requestId: "x".repeat(257) },
		{ ...receipt, requestId: "private\ntext" },
		{ ...receipt, extra: "private metadata" },
		{ ...receipt, [Symbol("extra")]: true },
		{ ...receipt, execution: "unknown" },
		{ ...receipt, operationStatus: undefined },
		{ ...receipt, postprocessingFailures: ["progress", "progress"] },
		{ ...receipt, postprocessingFailures: ["progress", "after_hook", "extra"] },
		{ ...receipt, postprocessingFailures: ["private diagnostic"] },
		{ ...receipt, postprocessingFailures: new Array(1) },
		{ ...receipt, postprocessingFailures: Object.assign([], { extra: true }) },
		Object.create(receipt),
	])("rejects malformed or ambiguous evidence %#", (candidate) => {
		expect(decodeToolInvocationReceipt(candidate)).toBeUndefined();
	});

	it("does not execute receipt or array accessors", () => {
		const fail = () => {
			throw new Error("accessor executed");
		};
		expect(retainedToolInvocation(Object.defineProperty({}, "piToolInvocation", { get: fail }))).toBeUndefined();
		expect(
			decodeToolInvocationReceipt(Object.defineProperty({ ...receipt }, "requestId", { get: fail })),
		).toBeUndefined();
		const failures = Object.defineProperty(["progress"], 0, { get: fail });
		expect(decodeToolInvocationReceipt({ ...receipt, postprocessingFailures: failures })).toBeUndefined();
		const details = stampToolInvocation(
			Object.defineProperty({ ordinary: true }, "piToolInvocation", { get: fail }),
			receipt,
		);
		expect(details).toEqual({ ordinary: true, piToolInvocation: receipt });
	});

	it.each(["not_started", "running", "unknown"] as const)("retains %s without inventing an outcome", (execution) => {
		const candidate = { version: 1, requestId: "fixture-request", execution, postprocessingFailures: [] };
		expect(decodeToolInvocationReceipt(candidate)).toEqual(candidate);
		expect(decodeToolInvocationReceipt({ ...candidate, operationStatus: "success" })).toBeUndefined();
	});
});
