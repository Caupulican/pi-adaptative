import { ToolArgumentValidationError } from "@caupulican/pi-ai/validation";
import { expect, it, vi } from "vitest";
import {
	materializeToolValidationFeedback,
	readToolArgumentValidationError,
} from "../src/kernel/tool-call-arguments.ts";

it("keeps the validation diagnostic when deferred guidance fails", () => {
	const enrichment = vi.fn(() => {
		throw new Error("guidance failed");
	});
	const failure = readToolArgumentValidationError(
		new ToolArgumentValidationError("invalid arguments", { toolName: "read", signature: "shape", enrichment }),
	);
	expect(failure?.message).toBe("invalid arguments");
	expect(enrichment).not.toHaveBeenCalled();
	expect(materializeToolValidationFeedback(failure!.enrichment)).toBeUndefined();
	expect(enrichment).toHaveBeenCalledTimes(1);
});

it("accepts string guidance from a compatible error created outside the harness", () => {
	const imported = {
		name: "ToolArgumentValidationError",
		message: "invalid arguments",
		toolName: "read",
		signature: "shape",
		enrichment: "external schema guidance",
	};
	const failure = readToolArgumentValidationError(imported);
	expect(materializeToolValidationFeedback(failure!.enrichment)).toBe(imported.enrichment);
	expect(readToolArgumentValidationError({ ...imported, enrichment: () => "untrusted" })).toBeUndefined();
});
