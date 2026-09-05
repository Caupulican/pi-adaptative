import { describe, expect, it, vi } from "vitest";
import { type RuntimeChild, RuntimeSupervisor, type RuntimeSupervisorMessage } from "../src/core/runtime-supervisor.ts";

function fixture() {
	const children: Array<
		RuntimeChild & { message(message: RuntimeSupervisorMessage): void; exit(code: number): void }
	> = [];
	const launch = vi.fn(() => {
		let listener: (message: RuntimeSupervisorMessage) => void = () => {};
		let exit!: (code: number) => void;
		const child = {
			terminal: new Promise<number>((resolve) => {
				exit = resolve;
			}),
			onMessage(callback: typeof listener) {
				listener = callback;
				return () => {
					listener = () => {};
				};
			},
			send: vi.fn(),
			stop: vi.fn(),
			message(message: RuntimeSupervisorMessage) {
				listener(message);
			},
			exit(code: number) {
				exit(code);
			},
		};
		children.push(child);
		return child;
	});
	const record = vi.fn();
	let revision = 0;
	const capture = vi.fn(async () => `candidate-${++revision}`);
	const retire = vi.fn(async () => {});
	const supervisor = new RuntimeSupervisor({
		launch,
		record,
		capture,
		retire,
		watch: () => () => {},
	});
	const request = { id: "update", sessionId: "session", sessionFile: "/sessions/example.jsonl" };
	return { supervisor, children, launch, record, request, capture, retire };
}

describe("supervised runtime generation handoff", () => {
	it("does not let failed candidate cleanup prevent known-good recovery", async () => {
		const f = fixture();
		const done = f.supervisor.run("known-good");
		f.children[0].message({ type: "ready" });
		f.children[0].message({ type: "prepare", request: f.request });
		await f.supervisor.idle();
		f.children[0].message({ type: "handoff", id: f.request.id });
		f.children[0].exit(0);
		await f.supervisor.idle();
		f.retire.mockRejectedValue(new Error("cleanup denied"));
		f.children[1].exit(1);
		await f.supervisor.idle();
		expect(f.launch).toHaveBeenLastCalledWith(
			"known-good",
			expect.objectContaining({ disposition: "rollback", error: expect.stringContaining("cleanup denied") }),
		);
		f.children[2].exit(0);
		expect(await done).toBe(0);
	});

	it("does not acknowledge or retain a half-persisted preparation", async () => {
		const f = fixture();
		const done = f.supervisor.run("known-good");
		f.record.mockImplementation((record: { phase: string }) => {
			if (record.phase === "prepared") throw new Error("disk full");
		});
		f.children[0].message({ type: "ready" });
		f.children[0].message({ type: "prepare", request: f.request });
		await f.supervisor.idle();
		expect(f.children[0].send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "rejected" }));
		expect(f.retire).toHaveBeenCalledWith("candidate-1");
		f.record.mockReset();
		f.children[0].message({ type: "prepare", request: f.request });
		await f.supervisor.idle();
		expect(f.children[0].send).toHaveBeenLastCalledWith({ type: "prepared", id: f.request.id });
		f.children[0].message({ type: "discard", id: f.request.id });
		await f.supervisor.idle();
		f.children[0].exit(0);
		expect(await done).toBe(0);
	});
	it("waits for the old writer's terminal event, then rolls back a failed candidate automatically", async () => {
		const f = fixture();
		const done = f.supervisor.run("known-good");
		f.children[0].message({ type: "ready" });
		f.children[0].message({ type: "prepare", request: f.request });
		await f.supervisor.idle();
		f.children[0].message({ type: "handoff", id: f.request.id });
		await f.supervisor.idle();
		expect(f.launch).toHaveBeenCalledTimes(1);
		f.children[0].exit(0);
		await f.supervisor.idle();
		expect(f.launch).toHaveBeenLastCalledWith("candidate-1", { ...f.request, disposition: "candidate" });
		f.children[1].exit(1);
		await f.supervisor.idle();
		expect(f.launch).toHaveBeenLastCalledWith(
			"known-good",
			expect.objectContaining({
				...f.request,
				disposition: "rollback",
				error: expect.stringContaining("1"),
			}),
		);
		expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ phase: "rollback", request: f.request }));
		f.children[2].message({ type: "ready" });
		await f.supervisor.idle();
		f.children[2].exit(0);
		expect(await done).toBe(0);
	});

	it("rejects stale commit messages and retains fallback until explicit candidate verification", async () => {
		const f = fixture();
		const done = f.supervisor.run("known-good");
		f.children[0].message({ type: "ready" });
		f.children[0].message({ type: "prepare", request: f.request });
		await f.supervisor.idle();
		f.children[0].message({ type: "handoff", id: f.request.id });
		f.children[0].exit(0);
		await f.supervisor.idle();
		f.children[1].message({ type: "ready" });
		f.children[1].message({ type: "commit", id: "wrong" });
		await f.supervisor.idle();
		expect(f.children[1].send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "rejected" }));
		f.children[1].message({ type: "commit", id: f.request.id });
		await f.supervisor.idle();
		expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ phase: "committed", artifact: "candidate-1" }));
		f.children[1].message({ type: "commit", id: f.request.id });
		await f.supervisor.idle();
		expect(f.children[1].send).toHaveBeenLastCalledWith({ type: "committed", id: f.request.id });
		f.children[1].exit(0);
		expect(await done).toBe(0);
		expect(f.launch).toHaveBeenCalledTimes(2);
	});
});
