import { describe, expect, it, vi } from "vitest";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";

describe("provider admission release", () => {
	it("attempts every owned hold before reporting release failures", () => {
		const ledger = new ProviderAdmissionLedger("/unused");
		const first = vi.fn(() => {
			throw new Error("first hold release failed");
		});
		const second = vi.fn();
		const internals = ledger as unknown as { holds: Map<string, () => void> };
		internals.holds.set("first", first);
		internals.holds.set("second", second);

		expect(() => ledger.releaseAll()).not.toThrow();
		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
	});
});
