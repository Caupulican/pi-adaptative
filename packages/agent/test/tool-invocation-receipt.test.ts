import { describe, expect, it } from "vitest";
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
