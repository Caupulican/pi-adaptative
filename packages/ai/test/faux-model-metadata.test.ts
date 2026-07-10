import { describe, expect, it } from "vitest";
import { registerFauxProvider } from "../src/providers/faux.ts";

describe("faux provider model metadata", () => {
	it("preserves default and extended thinking metadata", () => {
		const faux = registerFauxProvider({
			models: [
				{
					id: "sol",
					reasoning: true,
					defaultThinkingLevel: "low",
					thinkingLevelMap: { max: "max", ultra: "max" },
				},
			],
		});

		try {
			expect(faux.getModel()).toMatchObject({
				defaultThinkingLevel: "low",
				thinkingLevelMap: { max: "max", ultra: "max" },
			});
		} finally {
			faux.unregister();
		}
	});
});
