import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { bindChildProcessAbort } from "../src/utils/child-process.ts";

function childFixture(pid?: number): ChildProcess {
	return Object.assign(new EventEmitter(), {
		pid,
		exitCode: null,
		signalCode: null,
		kill: vi.fn(() => true),
	}) as unknown as ChildProcess;
}

describe("spawn-evidenced child cancellation", () => {
	it("remembers cancellation before spawn but signals only after a positive PID spawn event", () => {
		const child = childFixture(4242);
		const abort = new AbortController();
		bindChildProcessAbort(child, abort.signal);
		abort.abort();
		expect(child.kill).not.toHaveBeenCalled();
		child.emit("spawn");
		expect(child.kill).toHaveBeenCalledOnce();
		child.emit("exit", null, "SIGTERM");
		expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
	});
	it.each([undefined, 0, -1])("never signals failed or malformed spawn PID %s", (pid) => {
		const child = childFixture(pid);
		const abort = new AbortController();
		bindChildProcessAbort(child, abort.signal);
		abort.abort();
		child.emit("spawn");
		child.emit("error", new Error("ENOENT"));
		expect(child.kill).not.toHaveBeenCalled();
		expect(child.listenerCount("spawn")).toBe(0);
		expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
	});
	it("signals an active spawned child once and never signals after termination", () => {
		for (const terminalFirst of [false, true]) {
			const child = childFixture(4242);
			const abort = new AbortController();
			bindChildProcessAbort(child, abort.signal);
			child.emit("spawn");
			if (terminalFirst) child.emit("close", 0);
			abort.abort();
			abort.abort();
			expect(child.kill).toHaveBeenCalledTimes(terminalFirst ? 0 : 1);
			child.emit("close", 0);
			expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
		}
	});
	it("honours a signal already aborted when binding without touching an unspawned handle", () => {
		const child = childFixture(4242);
		bindChildProcessAbort(child, AbortSignal.abort());
		expect(child.kill).not.toHaveBeenCalled();
		child.emit("spawn");
		expect(child.kill).toHaveBeenCalledOnce();
		child.emit("close", null);
	});
	it("keeps cancellation armed after a live child's nonterminal error", () => {
		const child = childFixture(4242);
		const abort = new AbortController();
		bindChildProcessAbort(child, abort.signal);
		child.emit("spawn");
		child.emit("error", new Error("IPC failed, process still alive"));
		abort.abort();
		expect(child.kill).toHaveBeenCalledOnce();
		child.emit("close", null);
	});
	it.each([false, "throw"])(
		"handles a refused cancellation signal (%s) without escaping the abort listener",
		(failure) => {
			const child = childFixture(4242);
			vi.mocked(child.kill).mockImplementation(() => {
				if (failure === "throw") throw new Error("EPERM");
				return false;
			});
			const abort = new AbortController();
			const onDiagnostic = vi.fn();
			bindChildProcessAbort(child, abort.signal, { onDiagnostic });
			child.emit("spawn");
			abort.abort();
			expect(onDiagnostic).toHaveBeenCalledOnce();
			child.emit("close", null);
		},
	);
	it("negative control: cancellation terminates a successfully spawned owned child", async () => {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { detached: true, stdio: "ignore" });
		const abort = new AbortController();
		const terminal = new Promise<string | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (_code, signal) => resolve(signal));
		});
		bindChildProcessAbort(child, abort.signal);
		child.once("spawn", () => abort.abort());
		expect(await terminal).toBe("SIGTERM");
	});
});
