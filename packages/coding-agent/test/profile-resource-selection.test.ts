import { describe, expect, it } from "vitest";
import { decodeResourceSelection, encodeResourceSelection } from "../src/core/profile-resource-selection.ts";

describe("profile-resource-selection", () => {
	// Test universes
	const toolIds = ["read", "bash", "edit"];
	const skillIds = ["a", "b", "c", "d"];

	describe("encodeResourceSelection", () => {
		describe("with toolIds universe", () => {
			it("all enabled -> explicit grant-all (strict UAC: omitting the kind means DENIED)", () => {
				const enabled = new Set(toolIds);
				const result = encodeResourceSelection(enabled, toolIds);
				expect(result).toEqual({ allow: ["*"] });
			});

			it("subset enabled -> { allow: [...] } in allIds order", () => {
				const enabled = new Set(["read", "edit"]);
				const result = encodeResourceSelection(enabled, toolIds);
				expect(result).toEqual({ allow: ["read", "edit"] });
			});

			it("single item enabled -> { allow: [item] }", () => {
				const enabled = new Set(["bash"]);
				const result = encodeResourceSelection(enabled, toolIds);
				expect(result).toEqual({ allow: ["bash"] });
			});

			it("none enabled -> { block: ['*'] }", () => {
				const enabled = new Set<string>();
				const result = encodeResourceSelection(enabled, toolIds);
				expect(result).toEqual({ block: ["*"] });
			});

			it("enabled set contains ids not in allIds (ignored)", () => {
				const enabled = new Set(["read", "unknown", "edit"]);
				const result = encodeResourceSelection(enabled, toolIds);
				// Only "read" and "edit" are in toolIds, so it should encode as allow for those two
				expect(result).toEqual({ allow: ["read", "edit"] });
			});
		});

		describe("with skillIds universe", () => {
			it("all enabled -> explicit grant-all (strict UAC)", () => {
				const enabled = new Set(skillIds);
				const result = encodeResourceSelection(enabled, skillIds);
				expect(result).toEqual({ allow: ["*"] });
			});

			it("subset enabled -> { allow: [...] } in allIds order", () => {
				const enabled = new Set(["b", "d"]);
				const result = encodeResourceSelection(enabled, skillIds);
				expect(result).toEqual({ allow: ["b", "d"] });
			});

			it("none enabled -> { block: ['*'] }", () => {
				const enabled = new Set<string>();
				const result = encodeResourceSelection(enabled, skillIds);
				expect(result).toEqual({ block: ["*"] });
			});
		});
	});

	describe("decodeResourceSelection", () => {
		describe("with toolIds universe", () => {
			it("undefined filter -> NOTHING enabled (strict UAC: unmentioned kind is denied)", () => {
				const result = decodeResourceSelection(undefined, toolIds);
				expect(result).toEqual(new Set());
			});

			it("empty filter -> all enabled", () => {
				const result = decodeResourceSelection({}, toolIds);
				expect(result).toEqual(new Set(toolIds));
			});

			it("{ allow: ['read'] } -> just read", () => {
				const result = decodeResourceSelection({ allow: ["read"] }, toolIds);
				expect(result).toEqual(new Set(["read"]));
			});

			it("{ allow: ['read', 'edit'] } -> read and edit", () => {
				const result = decodeResourceSelection({ allow: ["read", "edit"] }, toolIds);
				expect(result).toEqual(new Set(["read", "edit"]));
			});

			it("{ block: ['*'] } -> none enabled", () => {
				const result = decodeResourceSelection({ block: ["*"] }, toolIds);
				expect(result).toEqual(new Set());
			});

			it("{ block: ['read'] } -> all except read", () => {
				const result = decodeResourceSelection({ block: ["read"] }, toolIds);
				expect(result).toEqual(new Set(["bash", "edit"]));
			});

			it("{ block: ['read', 'bash'] } -> only edit", () => {
				const result = decodeResourceSelection({ block: ["read", "bash"] }, toolIds);
				expect(result).toEqual(new Set(["edit"]));
			});

			it("allow with non-existent id is ignored", () => {
				const result = decodeResourceSelection({ allow: ["read", "unknown"] }, toolIds);
				expect(result).toEqual(new Set(["read"]));
			});

			it("block with non-existent id is ignored", () => {
				const result = decodeResourceSelection({ block: ["unknown"] }, toolIds);
				expect(result).toEqual(new Set(toolIds));
			});

			it("both allow and block: start from allow, then remove blocked", () => {
				const result = decodeResourceSelection({ allow: ["read", "bash", "edit"], block: ["bash"] }, toolIds);
				expect(result).toEqual(new Set(["read", "edit"]));
			});

			it("both allow and block: allow subset with block applied", () => {
				const result = decodeResourceSelection({ allow: ["read", "bash"], block: ["read"] }, toolIds);
				expect(result).toEqual(new Set(["bash"]));
			});
		});

		describe("with skillIds universe", () => {
			it("undefined filter -> NOTHING enabled (strict UAC)", () => {
				const result = decodeResourceSelection(undefined, skillIds);
				expect(result).toEqual(new Set());
			});

			it("{ allow: ['a', 'c'] } -> a and c", () => {
				const result = decodeResourceSelection({ allow: ["a", "c"] }, skillIds);
				expect(result).toEqual(new Set(["a", "c"]));
			});

			it("{ block: ['*'] } -> none enabled", () => {
				const result = decodeResourceSelection({ block: ["*"] }, skillIds);
				expect(result).toEqual(new Set());
			});

			it("{ block: ['b', 'd'] } -> a and c", () => {
				const result = decodeResourceSelection({ block: ["b", "d"] }, skillIds);
				expect(result).toEqual(new Set(["a", "c"]));
			});
		});
	});

	describe("round-trip: decode(encode(x))", () => {
		describe("with toolIds universe", () => {
			it("all-on round-trip", () => {
				const original = new Set(toolIds);
				const encoded = encodeResourceSelection(original, toolIds);
				const decoded = decodeResourceSelection(encoded, toolIds);
				expect(decoded).toEqual(original);
			});

			it("subset round-trip", () => {
				const original = new Set(["read", "edit"]);
				const encoded = encodeResourceSelection(original, toolIds);
				const decoded = decodeResourceSelection(encoded, toolIds);
				expect(decoded).toEqual(original);
			});

			it("none round-trip", () => {
				const original = new Set<string>();
				const encoded = encodeResourceSelection(original, toolIds);
				const decoded = decodeResourceSelection(encoded, toolIds);
				expect(decoded).toEqual(original);
			});

			it("single item round-trip", () => {
				const original = new Set(["bash"]);
				const encoded = encodeResourceSelection(original, toolIds);
				const decoded = decodeResourceSelection(encoded, toolIds);
				expect(decoded).toEqual(original);
			});
		});

		describe("with skillIds universe", () => {
			it("all-on round-trip", () => {
				const original = new Set(skillIds);
				const encoded = encodeResourceSelection(original, skillIds);
				const decoded = decodeResourceSelection(encoded, skillIds);
				expect(decoded).toEqual(original);
			});

			it("subset round-trip", () => {
				const original = new Set(["a", "c", "d"]);
				const encoded = encodeResourceSelection(original, skillIds);
				const decoded = decodeResourceSelection(encoded, skillIds);
				expect(decoded).toEqual(original);
			});

			it("none round-trip", () => {
				const original = new Set<string>();
				const encoded = encodeResourceSelection(original, skillIds);
				const decoded = decodeResourceSelection(encoded, skillIds);
				expect(decoded).toEqual(original);
			});
		});
	});

	describe("edge cases", () => {
		it("empty allIds with empty enabled set", () => {
			const enabled = new Set<string>();
			const allIds: string[] = [];
			const encoded = encodeResourceSelection(enabled, allIds);
			// All enabled (0 == 0), so should be undefined
			expect(encoded).toBeUndefined();
		});

		it("empty allIds with undefined filter", () => {
			const decoded = decodeResourceSelection(undefined, []);
			expect(decoded).toEqual(new Set());
		});

		it("allow list order is preserved from allIds", () => {
			const allIds = ["z", "y", "x"];
			const enabled = new Set(["x", "y"]);
			const encoded = encodeResourceSelection(enabled, allIds);
			// Should maintain allIds order: z, y, x
			expect(encoded).toEqual({ allow: ["y", "x"] });
		});
	});
});
