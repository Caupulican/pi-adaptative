import { describe, expect, it, vi } from "vitest";
import { TaskShellSessions } from "../src/core/tasks/task-shell-sessions.ts";

describe("bounded task shell ownership", () => {
	it("reuses shells and retires only idle shells at capacity", async () => {
		const retire = vi.fn(async (_key: string) => {});
		const pool = new TaskShellSessions(retire, 2);
		const first = await pool.acquire("first");
		const second = await pool.acquire("second");
		await expect(pool.acquire("third")).rejects.toThrow("active");
		expect(retire).not.toHaveBeenCalled();
		second();
		const third = await pool.acquire("third");
		expect(retire).toHaveBeenCalledExactlyOnceWith("second");
		const anotherFirst = await pool.acquire("first");
		first();
		first();
		third();
		const fourth = await pool.acquire("fourth");
		expect(retire.mock.calls.map(([key]) => key)).toEqual(["second", "third"]);
		anotherFirst();
		fourth();
		await pool.dispose();
		expect(retire.mock.calls.map(([key]) => key)).toEqual(["second", "third", "first", "fourth"]);
		await expect(pool.acquire("after-close")).rejects.toThrow("disposed");
	});

	it("serializes retirement and does not exceed capacity on concurrent admissions", async () => {
		const closed = Promise.withResolvers<void>();
		const retire = vi.fn(async () => closed.promise);
		const pool = new TaskShellSessions(retire, 1);
		(await pool.acquire("first"))();
		const second = pool.acquire("second");
		const third = pool.acquire("third");
		const thirdRejected = expect(third).rejects.toThrow("active");
		closed.resolve();
		const release = await second;
		await thirdRejected;
		expect(retire).toHaveBeenCalledOnce();
		release();
		await pool.dispose();
	});

	it("retains failed retirements for recovery and shutdown", async () => {
		const retire = vi.fn(async () => {}).mockRejectedValueOnce(new Error("terminal close unavailable"));
		const pool = new TaskShellSessions(retire, 1);
		(await pool.acquire("first"))();
		await expect(pool.acquire("second")).rejects.toThrow("terminal close unavailable");
		const release = await pool.acquire("second");
		expect(retire).toHaveBeenCalledTimes(2);
		release();
		await pool.dispose();
	});
});
