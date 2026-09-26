import { expect, it } from "vitest";
import {
	admitProviderRequest,
	EmergencyStopError,
	type ProviderAdmissionPolicy,
	type ProviderAdmissionWaitEvent,
} from "../src/core/provider-admission/gate.ts";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";
import { tempDir } from "./temp-dir.ts";

const policy: ProviderAdmissionPolicy = {
	enabled: true,
	limits: {},
	maxWaitMs: 10_000,
	foregroundLimitWaitMs: 10_000,
};

it("ends an emergency-stop wait when cancellation rejects its active sleep", async () => {
	const ledger = new ProviderAdmissionLedger(tempDir("pi-admission-wait-abort-"), { heartbeatMs: 60_000 });
	const controller = new AbortController();
	const reason = new Error("cancelled while stopped");
	const events: ProviderAdmissionWaitEvent[] = [];

	await expect(
		admitProviderRequest(
			"xai",
			{
				ledger,
				getPolicy: () => policy,
				getLane: () => "worker",
				isEmergencyStopEngaged: () => true,
				onWait: (event) => events.push(event),
				sleep: async (_ms, signal) => {
					controller.abort(reason);
					signal?.throwIfAborted();
				},
			},
			controller.signal,
		),
	).rejects.toBe(reason);

	expect(events.map((event) => `${event.phase}:${event.reason}`)).toEqual([
		"start:emergency_stop",
		"end:emergency_stop",
	]);
});

it("continues to pair the wait event before an emergency-stop timeout rejects", async () => {
	const ledger = new ProviderAdmissionLedger(tempDir("pi-admission-wait-timeout-"), { heartbeatMs: 60_000 });
	const events: ProviderAdmissionWaitEvent[] = [];
	let now = 0;

	await expect(
		admitProviderRequest("xai", {
			ledger,
			getPolicy: () => policy,
			getLane: () => "worker",
			isEmergencyStopEngaged: () => true,
			now: () => now,
			onWait: (event) => events.push(event),
			sleep: async (ms) => {
				now += ms;
			},
		}),
	).rejects.toBeInstanceOf(EmergencyStopError);

	expect(events.map((event) => `${event.phase}:${event.reason}`)).toEqual([
		"start:emergency_stop",
		"end:emergency_stop",
	]);
});

it("continues to bracket an emergency-stop wait that is lifted normally", async () => {
	const ledger = new ProviderAdmissionLedger(tempDir("pi-admission-wait-success-"), { heartbeatMs: 60_000 });
	const events: ProviderAdmissionWaitEvent[] = [];
	let engaged = true;
	const release = await admitProviderRequest("xai", {
		ledger,
		getPolicy: () => policy,
		getLane: () => "background",
		isEmergencyStopEngaged: () => engaged,
		onWait: (event) => events.push(event),
		sleep: async () => {
			engaged = false;
		},
	});
	release();

	expect(events.map((event) => `${event.phase}:${event.reason}`)).toEqual([
		"start:emergency_stop",
		"end:emergency_stop",
	]);
});
