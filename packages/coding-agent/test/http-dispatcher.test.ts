import type { StreamIdleOptions } from "@caupulican/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { constrainStreamIdleToHttpTimeout, DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../src/core/http-dispatcher.ts";

describe("HTTP-bound stream-idle policy", () => {
	it("keeps every watchdog phase and adaptive expansion below a nonzero HTTP timeout", () => {
		const onStall = vi.fn();
		const options: StreamIdleOptions = {
			connectMs: 500_000,
			activeIdleMs: 700_000,
			quietIdleMs: 900_000,
			onStall,
		};

		expect(constrainStreamIdleToHttpTimeout(options, 300_000)).toEqual({
			options: {
				connectMs: 270_000,
				activeIdleMs: 270_000,
				quietIdleMs: 270_000,
				onStall,
			},
			adaptiveCeilingMs: 270_000,
		});
	});

	it("preserves the stock 60-second margin at the default HTTP timeout", () => {
		const options: StreamIdleOptions = {
			connectMs: 120_000,
			activeIdleMs: 180_000,
			quietIdleMs: 600_000,
		};

		expect(constrainStreamIdleToHttpTimeout(options, DEFAULT_HTTP_IDLE_TIMEOUT_MS)).toEqual({
			options,
			adaptiveCeilingMs: 600_000,
		});
	});

	it("leaves watchdog bounds and adaptive expansion unconstrained when HTTP idle is disabled", () => {
		const options: StreamIdleOptions = {
			connectMs: 120_000,
			activeIdleMs: 180_000,
			quietIdleMs: 1_800_000,
		};

		expect(constrainStreamIdleToHttpTimeout(options, 0)).toEqual({ options });
	});
});
