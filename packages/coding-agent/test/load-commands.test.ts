import { describe, expect, it } from "vitest";
import type { ProviderLoadView } from "../src/core/provider-admission/load-view.ts";
import { formatProviderLoadView } from "../src/core/provider-admission/load-view.ts";
import { handleEstopCommand, handleLoadCommand, type LoadHost } from "../src/modes/interactive/load-commands.ts";

function view(overrides: Partial<ProviderLoadView> = {}): ProviderLoadView {
	const at = 1_700_000_000_000;
	return {
		at,
		inflight: [
			{
				id: "a",
				provider: "openai-codex",
				lane: "foreground",
				pid: 11,
				startedAt: new Date(at - 9_000).toISOString(),
				heartbeatAt: "",
			},
			{
				id: "b",
				provider: "openai-codex",
				lane: "worker",
				pid: 12,
				startedAt: new Date(at - 4_000).toISOString(),
				heartbeatAt: "",
			},
			{
				id: "c",
				provider: "xai",
				lane: "worker",
				pid: 12,
				startedAt: new Date(at - 1_000).toISOString(),
				heartbeatAt: "",
			},
		],
		limits: [
			{ provider: "xai", limitedUntil: at + 30_000, reason: "rate_limit", recordedAt: at, pid: 12, detail: "429" },
		],
		usage: [
			{
				provider: "openai-codex",
				at: at - 2_000,
				pid: 11,
				rateLimits: [{ limitId: "codex", limitName: "codex", primary: { usedPercent: 42, windowMinutes: 300 } }],
			},
		],
		emergencyStop: { engaged: false, path: "/agent/ESTOP" },
		configuredLimits: { "openai-codex": 3 },
		...overrides,
	};
}

function host(initial: ProviderLoadView) {
	let current = initial;
	const status: string[] = [];
	const errors: string[] = [];
	const texts: string[] = [];
	const loadHost: LoadHost = {
		getLoadView: () => current,
		setEmergencyStop: (engaged, reason) => {
			const changed = engaged !== current.emergencyStop.engaged;
			current = {
				...current,
				emergencyStop: engaged
					? { engaged: true, path: current.emergencyStop.path, ...(reason ? { reason } : {}) }
					: { engaged: false, path: current.emergencyStop.path },
			};
			return changed;
		},
		showStatus: (message) => status.push(message),
		showError: (message) => errors.push(message),
		showText: (text) => texts.push(text),
	};
	return { loadHost, status, errors, texts, current: () => current };
}

describe("/load", () => {
	it("renders in-flight requests per provider and lane, recorded limits, provider windows and the stop", () => {
		const text = formatProviderLoadView(view());
		expect(text).toContain("3 requests in flight machine-wide");
		expect(text).toContain(
			"openai-codex: 2 in flight (1 foreground, 1 worker, 0 background) across 2 processes, limit 3, oldest 9s ago",
		);
		expect(text).toContain("xai: 1 in flight (0 foreground, 1 worker, 0 background) across 1 process");
		expect(text).toContain("xai: rate limit until");
		expect(text).toContain("30s left, recorded by pid 12: 429");
		expect(text).toContain("openai-codex codex: 300m 42% used (seen 2s ago)");
		expect(text).toContain("Emergency stop: off");
		expect(formatProviderLoadView(view({ inflight: [], limits: [], usage: [] }))).toContain("Limited: none recorded");
	});

	it("shows the view and refuses arguments", async () => {
		const h = host(view());
		await handleLoadCommand(h.loadHost, "/load");
		expect(h.texts).toHaveLength(1);
		await handleLoadCommand(h.loadHost, "/load now");
		expect(h.errors).toEqual(["/load"]);
	});
});

describe("/estop", () => {
	it("reports, engages with a reason, and lifts", async () => {
		const h = host(view());
		await handleEstopCommand(h.loadHost, "/estop");
		expect(h.status.at(-1)).toContain("Emergency stop: off");
		await handleEstopCommand(h.loadHost, "/estop on account hammered by workers");
		expect(h.current().emergencyStop).toMatchObject({ engaged: true, reason: "account hammered by workers" });
		expect(h.status.at(-1)).toContain("Emergency stop engaged — account hammered by workers");
		await handleEstopCommand(h.loadHost, "/estop status");
		expect(h.status.at(-1)).toContain("engaged — account hammered by workers");
		await handleEstopCommand(h.loadHost, "/estop off");
		expect(h.current().emergencyStop.engaged).toBe(false);
		expect(h.status.at(-1)).toContain("lifted");
		await handleEstopCommand(h.loadHost, "/estop off");
		expect(h.status.at(-1)).toBe("Emergency stop was not engaged.");
		await handleEstopCommand(h.loadHost, "/estop maybe");
		expect(h.errors).toEqual(["/estop [status] · /estop on [reason] · /estop off"]);
	});
});
