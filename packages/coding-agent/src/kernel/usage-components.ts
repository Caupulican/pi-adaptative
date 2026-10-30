import type { AssistantMessage, Usage } from "@caupulican/pi-ai/types";
import { uuidv7 } from "@caupulican/pi-ai/uuid";

/** An actual provider response, retained independently of a retry ladder's aggregate. */
export interface UsageComponent {
	readonly sourceId: string;
	readonly timestamp: string;
	readonly provider: string;
	readonly model: string;
	readonly usage: Usage;
}

/** Host accounting failure: buying another provider response cannot repair it. */
export class MaintenanceUsageRetentionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MaintenanceUsageRetentionError";
	}
}

export function captureUsageComponent(response: AssistantMessage): UsageComponent {
	return {
		sourceId: uuidv7(),
		timestamp: new Date(response.timestamp).toISOString(),
		provider: response.provider,
		model: response.model,
		usage: structuredClone(response.usage),
	};
}
