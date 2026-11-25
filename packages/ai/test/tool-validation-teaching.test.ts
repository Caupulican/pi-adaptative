import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { formatToolValidationEnrichment, ToolArgumentValidationError } from "../src/utils/validation.ts";

it("keeps validation enrichment lazy and memoizes it when read", () => {
	const enrichment = vi.fn(() => "schema guidance");
	const error = new ToolArgumentValidationError("invalid arguments", {
		toolName: "read",
		signature: "shape",
		enrichment,
	});
	expect(error.message).toBe("invalid arguments");
	expect(enrichment).not.toHaveBeenCalled();
	expect(error.enrichment).toBe("schema guidance");
	expect(error.enrichment).toBe("schema guidance");
	expect(enrichment).toHaveBeenCalledTimes(1);
});

it("prints only examples that the full tool schema accepts", () => {
	const parameters = Type.Object({ name: Type.String({ pattern: "^task-[0-9]+$" }) });
	const guidance = formatToolValidationEnrichment({ parameters });
	expect(guidance).toContain("Full tool schema");
	expect(guidance).not.toContain("Valid example:");
	expect(formatToolValidationEnrichment({ parameters: Type.Object({ id: Type.Integer({ minimum: 2 }) }) })).toContain(
		'Valid example:\n{"id":2}',
	);
});
