import type { RuntimeRestartRequest } from "./runtime-update-controller.ts";

export type RuntimeSupervisorMessage =
	| { type: "ready" }
	| { type: "prepare"; request: RuntimeRestartRequest }
	| { type: "handoff" | "commit" | "discard"; id: string };

export interface RuntimeGenerationHandoff extends RuntimeRestartRequest {
	disposition: "candidate" | "rollback";
	error?: string;
}

export type RuntimeSupervisorReply =
	| { type: "prepared" | "committed"; id: string }
	| { type: "rejected"; id?: string; error: string };

export interface RuntimeChild {
	/** Exactly one process terminal event, never inferred from output. */
	terminal: Promise<number>;
	onMessage(listener: (message: RuntimeSupervisorMessage) => void): () => void;
	send(message: RuntimeSupervisorReply): void;
	stop(): void;
}

export interface RuntimeSupervisorRecord {
	phase: "starting" | "ready" | "prepared" | "handoff" | "committed" | "rollback" | "terminal";
	artifact: string;
	request?: RuntimeRestartRequest;
	error?: string;
}

interface RuntimeSupervisorPorts {
	capture(): Promise<string>;
	retire(artifact: string): Promise<void>;
	launch(artifact: string, handoff?: RuntimeGenerationHandoff): RuntimeChild;
	/** Atomic, bounded handoff persistence. Failure prevents an acknowledged transition. */
	record(record: RuntimeSupervisorRecord): void;
	watch(milliseconds: number, expired: () => void): () => void;
}

interface Generation {
	child: RuntimeChild;
	artifact: string;
	handoff?: RuntimeGenerationHandoff;
	ready: boolean;
	detach(): void;
	unwatch(): void;
	error?: string;
	committedId?: string;
}

/** One process writer at a time; candidate exit restores the retained code artifact automatically. */
export class RuntimeSupervisor {
	private readonly ports: RuntimeSupervisorPorts;
	private active: Generation | undefined;
	private knownGood = "";
	private prepared: { artifact: string; request: RuntimeRestartRequest; armed: boolean } | undefined;
	private retired: string | undefined;
	private queue: Promise<void> = Promise.resolve();
	private closing = false;
	private finish: ((code: number) => void) | undefined;

	constructor(ports: RuntimeSupervisorPorts) {
		this.ports = {
			...ports,
			record: (record) =>
				ports.record({
					...record,
					error: record.error?.slice(0, 2000),
					request: record.request
						? {
								id: record.request.id,
								sessionId: record.request.sessionId,
								sessionFile: record.request.sessionFile,
							}
						: undefined,
				}),
		};
	}

	run(initialArtifact: string): Promise<number> {
		if (this.finish) throw new Error("Runtime supervisor already started.");
		this.knownGood = initialArtifact;
		const completion = new Promise<number>((resolve) => {
			this.finish = resolve;
		});
		this.launch(initialArtifact);
		return completion;
	}

	/** Drain accepted lifecycle events; not used to discover process completion. */
	async idle(): Promise<void> {
		await Promise.resolve();
		let observed: Promise<void>;
		do {
			observed = this.queue;
			await observed;
		} while (observed !== this.queue);
	}

	stop(): void {
		this.closing = true;
		this.active?.child.stop();
	}

	private enqueue(operation: () => Promise<void>): void {
		this.queue = this.queue.then(operation).catch((error: unknown) => {
			const detail = String(error instanceof Error ? error.message : error).slice(0, 2000);
			this.closing = true;
			if (this.active) {
				this.active.error = detail;
				this.active.child.stop();
			} else this.finish?.(1);
		});
	}

	private launch(artifact: string, handoff?: RuntimeGenerationHandoff): void {
		this.ports.record({ phase: "starting", artifact, request: handoff });
		const child = this.ports.launch(artifact, handoff);
		const generation: Generation = {
			child,
			artifact,
			handoff,
			ready: false,
			detach: () => {},
			unwatch: () => {},
		};
		this.active = generation;
		generation.detach = child.onMessage((message) => this.enqueue(() => this.receive(generation, message)));
		generation.unwatch = this.ports.watch(60_000, () => {
			generation.error = "Runtime generation did not become ready before its startup deadline.";
			child.stop();
		});
		void child.terminal.then((code) => this.enqueue(() => this.terminal(generation, code)));
	}

	private async receive(generation: Generation, message: RuntimeSupervisorMessage): Promise<void> {
		if (this.active !== generation || this.closing) return;
		const reject = (error: string): void =>
			generation.child.send({
				type: "rejected",
				id: "id" in message ? message.id : message.type === "prepare" ? message.request.id : undefined,
				error,
			});
		if (message.type === "ready") {
			if (generation.ready) return;
			generation.ready = true;
			generation.unwatch();
			this.ports.record({ phase: "ready", artifact: generation.artifact, request: generation.handoff });
			if (generation.handoff?.disposition === "candidate") {
				generation.unwatch = this.ports.watch(30 * 60_000, () => {
					generation.error = "Candidate verification deadline exceeded.";
					generation.child.stop();
				});
			}
			return;
		}
		if (!generation.ready) return reject("Runtime generation is not ready.");
		if (message.type === "prepare") {
			if (this.prepared) return reject("A core handoff is already prepared.");
			let artifact: string | undefined;
			try {
				if (this.retired) {
					await this.ports.retire(this.retired);
					this.retired = undefined;
				}
				artifact = await this.ports.capture();
				if (this.closing) {
					await this.ports.retire(artifact);
					return;
				}
				this.ports.record({ phase: "prepared", artifact, request: message.request });
				this.prepared = { artifact, request: message.request, armed: false };
				generation.child.send({ type: "prepared", id: message.request.id });
			} catch (error) {
				if (artifact && !this.prepared) await this.ports.retire(artifact);
				reject(String(error).slice(0, 2000));
			}
			return;
		}
		if (message.type === "commit") {
			if (generation.committedId === message.id) {
				generation.child.send({ type: "committed", id: message.id });
				return;
			}
			if (this.prepared || generation.handoff?.disposition !== "candidate" || message.id !== generation.handoff.id)
				return reject("No matching candidate verification handoff.");
			this.ports.record({ phase: "committed", artifact: generation.artifact, request: generation.handoff });
			this.retired = this.knownGood;
			this.knownGood = generation.artifact;
			generation.committedId = message.id;
			generation.handoff = undefined;
			generation.unwatch();
			generation.child.send({ type: "committed", id: message.id });
			return;
		}
		if (this.prepared?.request.id !== message.id) return reject("No matching prepared core handoff.");
		if (message.type === "discard") {
			await this.ports.retire(this.prepared.artifact);
			this.prepared = undefined;
			return;
		}
		this.ports.record({ phase: "handoff", artifact: this.prepared.artifact, request: this.prepared.request });
		this.prepared.armed = true;
	}

	private async terminal(generation: Generation, code: number): Promise<void> {
		if (this.active !== generation) return;
		generation.detach();
		generation.unwatch();
		this.active = undefined;
		const prepared = this.prepared;
		this.prepared = undefined;
		let cleanupFailure = "";
		const retire = async (artifact: string): Promise<void> => {
			try {
				await this.ports.retire(artifact);
			} catch (error) {
				// Artifact storage retains ownership on failure, so its fixed admission cap still
				// applies. Cleanup cannot strand a session that already has a safe fallback.
				cleanupFailure = ` Artifact cleanup failed: ${String(error).slice(0, 500)}`;
			}
		};
		this.ports.record({
			phase: "terminal",
			artifact: generation.artifact,
			request: generation.handoff ?? prepared?.request,
			error: generation.error ?? (code === 0 ? undefined : `Runtime exited with code ${code}.`),
		});
		if (this.closing) {
			this.finish?.(code || 1);
			return;
		}
		if (prepared?.armed && code === 0) {
			if (generation.artifact !== this.knownGood) await retire(generation.artifact);
			this.launch(prepared.artifact, { ...prepared.request, disposition: "candidate" });
			return;
		}
		const request =
			prepared?.request ?? (generation.handoff?.disposition === "candidate" ? generation.handoff : undefined);
		if (!request) {
			this.finish?.(code);
			return;
		}
		if (prepared) await retire(prepared.artifact);
		if (generation.artifact !== this.knownGood) await retire(generation.artifact);
		const error =
			`${generation.error ?? `Candidate exited before verified commit (code ${code}).`}${cleanupFailure}`.slice(
				0,
				2000,
			);
		this.ports.record({ phase: "rollback", artifact: this.knownGood, request, error });
		this.launch(this.knownGood, { ...request, disposition: "rollback", error });
	}
}
