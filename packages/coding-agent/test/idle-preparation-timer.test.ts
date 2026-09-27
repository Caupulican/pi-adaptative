import { describe, expect, it } from "vitest";
import { IdlePreparationTimer } from "../src/core/context/idle-preparation-timer.ts";

describe("IdlePreparationTimer", () => {
	it("fences callbacks captured before replacement or disarm", () => {
		const callbacks: Array<() => void> = [];
		const handles: Array<ReturnType<typeof setTimeout>> = [];
		const timer = new IdlePreparationTimer((fire) => {
			callbacks.push(fire);
			const handle = setTimeout(() => undefined, 60_000);
			handles.push(handle);
			return handle;
		});
		const fired: string[] = [];
		try {
			timer.arm(10, () => fired.push("replaced"));
			timer.arm(20, () => fired.push("current"));
			callbacks[0]?.();
			expect(fired).toEqual([]);
			expect(timer.armed).toBe(true);

			callbacks[1]?.();
			expect(fired).toEqual(["current"]);
			expect(timer.armed).toBe(false);

			timer.arm(30, () => fired.push("disarmed"));
			timer.disarm();
			callbacks[2]?.();
			expect(fired).toEqual(["current"]);
			expect(timer.armed).toBe(false);
		} finally {
			for (const handle of handles) clearTimeout(handle);
		}
	});
});
