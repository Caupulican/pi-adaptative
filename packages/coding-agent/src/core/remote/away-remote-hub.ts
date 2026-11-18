/** The daemon carries the saved listener between desktop sessions. Jobs and asks settle through the shared transport stores. */
import { RemoteHubController, type RemoteHubControllerDeps } from "./hub-controller.ts";
import { readHubConfig } from "./registry.ts";

type AwayHubPorts = Omit<RemoteHubControllerDeps, "jobs" | "onConfigChanged"> & {
	rootPresent(): boolean;
	report(message: string): void;
};

export class AwayRemoteHub {
	private readonly deps: AwayHubPorts;
	private hub?: RemoteHubController;
	private lastProblem?: string;

	constructor(deps: AwayHubPorts) {
		this.deps = deps;
	}

	/** Serialized by the daemon renewal. A root opening while a bind is in flight gets the listener on the following renewal. */
	async sync(awayEnabled: boolean): Promise<void> {
		try {
			const config = awayEnabled ? readHubConfig(this.deps.agentDir) : undefined;
			if (config?.enabled && !this.deps.rootPresent()) {
				this.hub ??= new RemoteHubController(this.deps);
				await this.hub.resumeSaved(false, config);
			} else {
				await this.close();
			}
			this.lastProblem = undefined;
		} catch (error) {
			const problem = `The away hub could not serve its saved listener: ${error instanceof Error ? error.message : String(error)}`;
			if (problem !== this.lastProblem) this.deps.report(problem);
			this.lastProblem = problem;
		}
	}

	async close(): Promise<void> {
		await this.hub?.stop();
		this.hub = undefined;
	}
}
