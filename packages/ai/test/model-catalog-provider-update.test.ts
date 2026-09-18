import { describe, expect, it } from "vitest";
import { replaceModelCatalogProvider } from "../scripts/model-catalog-provider-update.ts";

const current = `export const MODELS = {
	"anthropic": {
		"retained": { id: "retained" },
	},
	"openrouter": {
		"old": { id: "old" },
	},
} as const;
`;
const generated = `export const MODELS = {
	"anthropic": {
		"unrelated-new": { id: "unrelated-new" },
	},
	"openrouter": {
		"new": { id: "new" },
	},
} as const;
`;

describe("provider-scoped catalog publication", () => {
	it("replaces only the selected complete provider section", () => {
		const result = replaceModelCatalogProvider(current, generated, "openrouter");
		expect(result).toBe(current.replace('"old": { id: "old" }', '"new": { id: "new" }'));
	});

	it("can replace the first provider while leaving the following provider untouched", () => {
		const result = replaceModelCatalogProvider(current, generated, "anthropic");
		expect(result).toBe(
			current.replace('"retained": { id: "retained" }', '"unrelated-new": { id: "unrelated-new" }'),
		);
	});

	it("rejects unknown or missing provider sections instead of publishing an empty catalog", () => {
		expect(() => replaceModelCatalogProvider(current, generated, "missing")).toThrow("Missing catalog provider");
		expect(() =>
			replaceModelCatalogProvider(current, generated.replace('"openrouter"', '"other"'), "openrouter"),
		).toThrow("Missing catalog provider");
	});

	it("rejects an unterminated provider section", () => {
		const malformed = 'export const MODELS = {\n\t"openrouter": {\n';
		expect(() => replaceModelCatalogProvider(malformed, generated, "openrouter")).toThrow(
			"Unterminated catalog provider",
		);
		const missingFirstTerminator = current.replace("\n\t},\n", "\n");
		expect(() => replaceModelCatalogProvider(missingFirstTerminator, generated, "anthropic")).toThrow(
			"Unterminated catalog provider",
		);
	});

	it("rejects duplicate provider headers", () => {
		expect(() => replaceModelCatalogProvider(current + current, generated, "openrouter")).toThrow(
			"Duplicate catalog provider",
		);
	});
});
