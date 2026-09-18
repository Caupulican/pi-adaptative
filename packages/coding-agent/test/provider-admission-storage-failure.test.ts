import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, getModel } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withProviderAdmission } from "../src/core/provider-admission/gate.ts";
import { ProviderAdmissionLedger, providerAdmissionDir } from "../src/core/provider-admission/ledger.ts";
import { ProviderLimitedError, ProviderLimitStore } from "../src/core/provider-admission/limit-state.ts";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const directory = fs.mkdtempSync(join(tmpdir(), "pi-limit-read-"));
	directories.push(directory);
	let now = 1_000;
	const store = new ProviderLimitStore(directory, { now: () => now });
	const record = store.record("anthropic", { limitedUntil: 9_000, reason: "usage_window" });
	return {
		directory,
		store,
		record,
		path: join(providerAdmissionDir(directory), "limits", "anthropic.json"),
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function failRead(path: string, code: string) {
	const failure = Object.assign(new Error("fixture cooldown read failure"), { code });
	const original = fs.readFileSync;
	const read = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
		if (file === path) throw failure;
		return original(file, options);
	});
	syncBuiltinESMExports();
	return {
		failure,
		restore: () => {
			read.mockRestore();
			syncBuiltinESMExports();
		},
	};
}

describe("provider cooldown read failures", () => {
	for (const operation of ["read", "record", "clear", "list"] as const) {
		it.each(["EIO", "EACCES", "EBUSY"])(`${operation} preserves an unreadable live cooldown: %s`, (code) => {
			const h = fixture();
			const before = fs.readFileSync(h.path, "utf8");
			const fault = failRead(h.path, code);
			try {
				expect(() => {
					if (operation === "record") {
						h.store.record("anthropic", { limitedUntil: 4_000, reason: "rate_limit" });
					} else if (operation === "clear") {
						h.store.clear("anthropic", ["rate_limit"]);
					} else if (operation === "list") h.store.list();
					else h.store.read("anthropic");
				}).toThrow(fault.failure);
			} finally {
				fault.restore();
			}
			expect(fs.readFileSync(h.path, "utf8")).toBe(before);
			expect(fs.existsSync(`${h.path}.lock`)).toBe(false);
			expect(h.store.read("anthropic")).toEqual(h.record);
			// The failed read releases ownership; a later valid observation can still extend the limit.
			expect(h.store.record("anthropic", { limitedUntil: 12_000, reason: "usage_window" }).limitedUntil).toBe(
				12_000,
			);
		});
	}

	it.each(["foreground", "worker", "background"] as const)(
		"does not send from the %s lane while the cooldown cannot be read",
		async (lane) => {
			const h = fixture();
			const ledger = new ProviderAdmissionLedger(h.directory, { now: h.now, heartbeatMs: 60_000 });
			const acquire = vi.spyOn(ledger, "acquire");
			const inner = createAssistantMessageEventStream();
			inner.end({ ...fauxAssistantMessage("ok"), provider: "anthropic" });
			const transport = vi.fn(() => inner);
			const wrapped = withProviderAdmission(transport, {
				ledger,
				limits: h.store,
				now: h.now,
				getLane: () => lane,
				getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 0, foregroundLimitWaitMs: 0 }),
			});
			const model = getModel("anthropic", "claude-sonnet-4-5");
			const fault = failRead(h.path, "EIO");
			try {
				await expect(wrapped(model, { messages: [] }, {})).rejects.toBe(fault.failure);
				expect(transport).not.toHaveBeenCalled();
				expect(acquire).not.toHaveBeenCalled();
			} finally {
				fault.restore();
				ledger.releaseAll();
			}
			try {
				// Once storage recovers the original live cooldown still blocks, without transport.
				await expect(wrapped(model, { messages: [] }, {})).rejects.toBeInstanceOf(ProviderLimitedError);
				expect(transport).not.toHaveBeenCalled();
				expect(acquire).not.toHaveBeenCalled();
				h.advance(8_001);
				expect(await wrapped(model, { messages: [] }, {})).toBe(inner);
				await inner.result();
				expect(transport).toHaveBeenCalledOnce();
				expect(h.store.read("anthropic")).toBeUndefined();
			} finally {
				ledger.releaseAll();
			}
		},
	);

	it.each(["absent", "invalid-json", "invalid-shape", "expired", "live"] as const)(
		"preserves the existing cleanup policy for %s data after a successful read",
		(state) => {
			const h = fixture();
			if (state === "absent") fs.unlinkSync(h.path);
			if (state === "invalid-json") fs.writeFileSync(h.path, "{");
			if (state === "invalid-shape") fs.writeFileSync(h.path, "{}");
			if (state === "expired") h.advance(8_000);
			expect(h.store.read("anthropic")).toEqual(state === "live" ? h.record : undefined);
			expect(fs.existsSync(h.path)).toBe(state === "live");
		},
	);
});

describe("provider in-flight record read failures", () => {
	for (const operation of ["count", "list", "acquire"] as const) {
		it.each(["EIO", "EACCES"])(`${operation} preserves an unreadable live lease: %s`, (code) => {
			const h = fixture();
			const ledger = new ProviderAdmissionLedger(h.directory, { now: h.now, heartbeatMs: 60_000 });
			const hold = ledger.acquire("anthropic", "worker");
			const path = join(providerAdmissionDir(h.directory), `${hold.id}.json`);
			const before = fs.readFileSync(path, "utf8");
			const fault = failRead(path, code);
			try {
				try {
					expect(() => {
						if (operation === "count") ledger.countInflight("anthropic");
						else if (operation === "list") ledger.listInflight();
						else ledger.tryAcquire("anthropic", "worker", 1);
					}).toThrow(fault.failure);
				} finally {
					fault.restore();
				}
				expect(fs.readFileSync(path, "utf8")).toBe(before);
				expect(ledger.countInflight("anthropic").total).toBe(1);
				expect(ledger.tryAcquire("anthropic", "worker", 1)).toEqual({ inflight: 1 });
				hold.release();
				expect(ledger.tryAcquire("anthropic", "worker", 1).hold).toBeDefined();
			} finally {
				ledger.releaseAll();
			}
		});
	}

	it.each(["absent", "invalid-json", "invalid-shape", "stale", "live"] as const)(
		"preserves pruning and capacity accounting for %s lease data",
		(state) => {
			const h = fixture();
			const ledger = new ProviderAdmissionLedger(h.directory, {
				now: h.now,
				heartbeatMs: 60_000,
				staleMs: 1_000,
			});
			try {
				const hold = ledger.acquire("anthropic", "worker");
				const path = join(providerAdmissionDir(h.directory), `${hold.id}.json`);
				if (state === "absent") fs.unlinkSync(path);
				if (state === "invalid-json") fs.writeFileSync(path, "{");
				if (state === "invalid-shape") fs.writeFileSync(path, "{}");
				if (state === "stale") h.advance(1_001);
				expect(ledger.countInflight("anthropic").total).toBe(state === "live" ? 1 : 0);
				expect(fs.existsSync(path)).toBe(state === "live");
			} finally {
				ledger.releaseAll();
			}
		},
	);
});
