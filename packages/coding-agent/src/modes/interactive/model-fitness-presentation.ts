import type { Container, TUI } from "@caupulican/pi-tui";
import { Spacer, Text } from "@caupulican/pi-tui";
import { formatModelFitnessReport, type ModelFitnessReport } from "../../core/research/model-fitness.ts";

export type ModelFitnessOutcome =
	| { started: true; model: string; report: ModelFitnessReport }
	| { started: false; skipReason: string };

type StartedModelFitnessOutcome = Extract<ModelFitnessOutcome, { started: true }>;

export interface ModelFitnessPresentationHost {
	readonly chatContainer: Pick<Container, "addChild">;
	readonly ui: Pick<TUI, "requestRender">;
	showStatus(message: string): void;
}

export function presentModelFitnessOutcome(
	host: ModelFitnessPresentationHost,
	outcome: ModelFitnessOutcome,
): outcome is StartedModelFitnessOutcome {
	if (!outcome.started) {
		host.showStatus(`Model fitness skipped: ${outcome.skipReason}`);
		return false;
	}
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(formatModelFitnessReport(outcome.model, outcome.report), 1, 0));
	host.ui.requestRender();
	return true;
}
