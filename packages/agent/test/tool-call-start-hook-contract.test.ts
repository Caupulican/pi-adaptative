import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ToolCallStartHook, ToolCallStartReservation } from "../src/types.ts";

describe("tool start hook return contract", () => {
	it("still excludes asynchronous values that are not reservations", () => {
		expectTypeOf<() => Promise<string>>().not.toMatchTypeOf<ToolCallStartHook>();
	});

	it.each([false, true])("accepts a mixed async void/reservation return: reserve=%s", async (reserve) => {
		const reservation: ToolCallStartReservation = { release: vi.fn() };
		const noReservation: void = undefined;
		// This assignment must type-check as well as run: Promise<void | Reservation>
		// is a valid hook, not just Promise<void> or Promise<Reservation> separately.
		const hook: ToolCallStartHook = async () => {
			if (reserve) return reservation;
			return noReservation;
		};
		expect(await hook([])).toBe(reserve ? reservation : undefined);
		expect(reservation.release).not.toHaveBeenCalled();
	});
});
