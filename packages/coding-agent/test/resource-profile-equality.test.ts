import { describe, expect, it } from "vitest";
import {
	resourceProfileKindFilterEqual,
	resourceProfileSettingsChangedKinds,
	resourceProfileSettingsEqual,
} from "../src/core/resource-profile-equality.ts";

describe("resource profile equality", () => {
	it("compares cloned filters by value instead of by object identity", () => {
		expect(
			resourceProfileKindFilterEqual(
				{ allow: ["read", "write"], block: ["bash"] },
				{ allow: ["read", "write"], block: ["bash"] },
			),
		).toBe(true);
	});

	it("reports exactly the resource kinds whose allow/block filters changed", () => {
		const changedKinds = resourceProfileSettingsChangedKinds(
			{
				extensions: { allow: ["safe-ext"] },
				skills: { block: ["legacy"] },
			},
			{
				extensions: { allow: ["safe-ext", "new-ext"] },
				skills: { block: ["legacy"] },
			},
		);

		expect(Array.from(changedKinds)).toEqual(["extensions"]);
	});

	it("treats missing and empty filters as equivalent", () => {
		expect(resourceProfileSettingsEqual({}, { tools: { allow: [], block: [] } })).toBe(true);
	});
});
