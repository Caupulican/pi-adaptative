import type { AgentSession } from "../agent-session.ts";
import type { AgentSessionRuntimeResource } from "../agent-session-runtime.ts";
import { attachNativePiActivity, type NativePiActivity } from "./native-pi-activity.ts";

/** Owns the native status connection across /new, /resume, /fork, and startup cancellation. */
export class SessionNativePiActivityRuntime implements AgentSessionRuntimeResource {
	private handle?: NativePiActivity;
	private operation: Promise<void> = Promise.resolve();
	private generation = 0;
	private activated: boolean;
	private readonly options: Parameters<typeof attachNativePiActivity>[1];

	constructor(
		options: NonNullable<Parameters<typeof attachNativePiActivity>[1]> & { deferInitialSettlement?: boolean } = {},
	) {
		this.options = options;
		this.activated = !options.deferInitialSettlement;
	}

	get active(): boolean {
		return this.handle !== undefined;
	}

	start(session: AgentSession): Promise<void> {
		const generation = ++this.generation;
		return this.replace(async () => {
			const port = session.nativeActivity;
			const handle = await attachNativePiActivity(
				{
					...port,
					isSettled: () => this.activated && port.isSettled(),
					sessionManager: session.sessionManager,
					subscribe: (listener) => session.subscribe(listener),
				},
				this.options,
			);
			try {
				await handle?.flush();
				if (generation === this.generation) this.handle = handle;
				else await handle?.dispose();
			} catch (error) {
				await handle?.dispose().catch(() => {});
				throw error;
			}
		});
	}

	/** Initial idle must follow UI/input binding, never just process startup. */
	async activate(): Promise<void> {
		await this.operation;
		this.activated = true;
		this.handle?.refresh();
		await this.handle?.flush();
	}

	stop(): Promise<void> {
		this.generation++;
		return this.replace(async () => {});
	}

	private replace(install: () => Promise<void>): Promise<void> {
		const pending = this.operation.then(async () => {
			const old = this.handle;
			this.handle = undefined;
			if (old) await old.dispose();
			await install();
		});
		this.operation = pending.catch(() => {});
		return pending;
	}
}
