import type { Component } from "@caupulican/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ModelFitnessReport } from "../src/core/research/model-fitness.ts";
import {
	type ModelFitnessPresentationHost,
	presentModelFitnessOutcome,
} from "../src/modes/interactive/model-fitness-presentation.ts";

const mocks = vi.hoisted(() => ({
	formatModelFitnessReport: vi.fn(() => "bounded fitness report"),
}));

vi.mock("../src/core/research/model-fitness.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/research/model-fitness.ts")>();
	return { ...actual, formatModelFitnessReport: mocks.formatModelFitnessReport };
});

function createHost(): {
	host: ModelFitnessPresentationHost;
	children: Component[];
	statuses: string[];
	requestRender: ReturnType<typeof vi.fn>;
} {
	const children: Component[] = [];
	const statuses: string[] = [];
	const requestRender = vi.fn();
	return {
		host: {
			chatContainer: { addChild: (child) => children.push(child) },
			ui: { requestRender },
			showStatus: (message) => statuses.push(message),
		},
		children,
		statuses,
		requestRender,
	};
}

describe("model fitness presentation", () => {
	it("reports a skipped probe without mutating the transcript", () => {
		const { host, children, statuses, requestRender } = createHost();

		const started = presentModelFitnessOutcome(host, {
			started: false,
			skipReason: "model_unresolved_or_unauthenticated",
		});

		expect(started).toBe(false);
		expect(statuses).toEqual(["Model fitness skipped: model_unresolved_or_unauthenticated"]);
		expect(children).toEqual([]);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("renders a completed report once and returns the narrowed outcome", () => {
		const { host, children, statuses, requestRender } = createHost();
		const outcome = {
			started: true as const,
			model: "ollama/model",
			report: { trials: 3 } as ModelFitnessReport,
		};

		const started = presentModelFitnessOutcome(host, outcome);

		expect(started).toBe(true);
		expect(statuses).toEqual([]);
		expect(mocks.formatModelFitnessReport).toHaveBeenCalledWith("ollama/model", outcome.report);
		expect(children).toHaveLength(2);
		expect(children[1]?.render(80)[0]?.trim()).toBe("bounded fitness report");
		expect(requestRender).toHaveBeenCalledOnce();
	});
});
