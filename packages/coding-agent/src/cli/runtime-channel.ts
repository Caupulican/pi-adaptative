import { isAbsolute } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	bindSupervisedSelfLaunchTarget,
	normalizeSelfLaunchTarget,
} from "../core/process-matrix/self-launch-target.ts";
import type {
	RuntimeGenerationHandoff,
	RuntimeSupervisorMessage,
	RuntimeSupervisorReply,
} from "../core/runtime-supervisor.ts";

export const RUNTIME_SUPERVISOR_ENV = "PI_RUNTIME_SUPERVISOR";
const identity = Type.String({ minLength: 1, maxLength: 256 });
const restart = Type.Object({
	id: identity,
	sessionId: identity,
	sessionFile: Type.String({ minLength: 1, maxLength: 4096 }),
});
const messageSchema = Type.Union([
	Type.Object({ type: Type.Literal("ready") }),
	Type.Object({ type: Type.Literal("prepare"), request: restart }),
	Type.Object({
		type: Type.Union([Type.Literal("handoff"), Type.Literal("commit"), Type.Literal("discard")]),
		id: identity,
	}),
]);
const envelopeSchema = Type.Object({
	parentPid: Type.Integer({ minimum: 1 }),
	origin: Type.String({ minLength: 1, maxLength: 4096 }),
	stableTarget: Type.Union([
		Type.Null(),
		Type.Object(
			{
				executable: Type.String({ minLength: 1, maxLength: 4096 }),
				argsPrefix: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 32 }),
				environment: Type.Object(
					{
						PI_PACKAGE_DIR: Type.String({ maxLength: 4096 }),
						TSX_TSCONFIG_PATH: Type.String({ maxLength: 4096 }),
					},
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
	]),
	handoff: Type.Optional(
		Type.Intersect([
			restart,
			Type.Object({
				disposition: Type.Union([Type.Literal("candidate"), Type.Literal("rollback")]),
				error: Type.Optional(Type.String({ maxLength: 2000 })),
			}),
		]),
	),
});
export type RuntimeChildEnvelope = Static<typeof envelopeSchema>;

export function parseRuntimeSupervisorMessage(value: unknown): RuntimeSupervisorMessage | undefined {
	if (!Value.Check(messageSchema, value)) return undefined;
	if (value.type === "prepare" && (!isAbsolute(value.request.sessionFile) || value.request.sessionFile.includes("\0")))
		return undefined;
	return value;
}

/** Consume before any tools/children inherit environment; an inherited marker is not a channel. */
export function consumeRuntimeEnvelope(
	env: NodeJS.ProcessEnv,
	parentPid: number,
	connected: boolean,
): RuntimeChildEnvelope | undefined {
	const encoded = env[RUNTIME_SUPERVISOR_ENV];
	delete env[RUNTIME_SUPERVISOR_ENV];
	if (encoded === undefined) return undefined;
	// Covers the maximum JSON-escaped representation of all individually bounded fields.
	if (encoded.length > 1024 * 1024) throw new Error("Oversized runtime handoff.");
	const value: unknown = JSON.parse(encoded);
	if (
		!connected ||
		!Value.Check(envelopeSchema, value) ||
		value.parentPid !== parentPid ||
		!isAbsolute(value.origin) ||
		value.origin.includes("\0") ||
		(value.handoff && (!isAbsolute(value.handoff.sessionFile) || value.handoff.sessionFile.includes("\0")))
	)
		throw new Error("Invalid or inherited runtime handoff.");
	const target = value.stableTarget;
	if (target) {
		if (
			!isAbsolute(target.executable) ||
			[target.executable, ...target.argsPrefix, ...Object.values(target.environment)].some((part) =>
				part.includes("\0"),
			) ||
			Object.values(target.environment).some((part) => part !== "" && !isAbsolute(part))
		)
			throw new Error("Invalid stable runtime launcher.");
		const normalized = normalizeSelfLaunchTarget(target);
		if (normalized.argsPrefix.some((argument, index) => argument !== target.argsPrefix[index]))
			throw new Error("Stable runtime launcher must use canonical absolute paths.");
	}
	return value;
}

export class RuntimeChildChannel {
	readonly handoff: RuntimeGenerationHandoff | undefined;
	readonly origin: string;
	private pending = false;
	private committed = false;

	constructor(envelope: RuntimeChildEnvelope) {
		this.handoff = envelope.handoff;
		this.origin = envelope.origin;
	}

	needsRollback(): boolean {
		return this.handoff?.disposition === "candidate" && !this.committed;
	}

	async send(message: RuntimeSupervisorMessage): Promise<void> {
		if (!process.send || !process.connected) throw new Error("Runtime supervisor disconnected.");
		await new Promise<void>((resolve, reject) =>
			process.send?.(message, (error: Error | null) => (error ? reject(error) : resolve())),
		);
	}

	async request(
		message: Extract<RuntimeSupervisorMessage, { type: "prepare" }> | { type: "commit"; id: string },
		signal?: AbortSignal,
	): Promise<void> {
		if (this.pending) throw new Error("A runtime supervisor request is already pending.");
		signal?.throwIfAborted();
		this.pending = true;
		const id = message.type === "prepare" ? message.request.id : message.id;
		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				let attempts = 0;
				let timer: ReturnType<typeof setTimeout>;
				const cleanup = () => {
					settled = true;
					clearTimeout(timer);
					process.off("message", receive);
					process.off("disconnect", disconnected);
					signal?.removeEventListener("abort", aborted);
				};
				const failed = (error: Error) => {
					if (settled) return;
					cleanup();
					reject(error);
				};
				const disconnected = () => failed(new Error("Runtime supervisor disconnected."));
				const aborted = () => failed(new Error("Runtime supervisor request cancelled."));
				const receive = (value: unknown) => {
					if (!value || typeof value !== "object") return;
					const reply = value as Partial<RuntimeSupervisorReply>;
					if (reply.id !== id) return;
					if (reply.type === "rejected") return failed(new Error(String(reply.error).slice(0, 2000)));
					if (reply.type !== (message.type === "prepare" ? "prepared" : "committed")) return;
					if (reply.type === "committed") this.committed = true;
					cleanup();
					resolve();
				};
				const transmit = () => {
					if (settled) return;
					attempts++;
					timer = setTimeout(
						() => {
							// Only commit has an idempotent replay contract. Capture must never run twice
							// after ambiguous delivery; its caller discards the prepared handoff instead.
							if (message.type === "commit" && attempts < 3) transmit();
							else failed(new Error("Runtime supervisor acknowledgement timed out."));
						},
						message.type === "commit" ? 5000 : 120_000,
					);
					void this.send(message).catch(failed);
				};
				process.on("message", receive);
				process.once("disconnect", disconnected);
				signal?.addEventListener("abort", aborted, { once: true });
				transmit();
			});
		} finally {
			this.pending = false;
		}
	}
}

let channel: RuntimeChildChannel | undefined;
export function initializeRuntimeChildChannel(): RuntimeChildChannel | undefined {
	if (channel) return channel;
	const envelope = consumeRuntimeEnvelope(process.env, process.ppid, process.connected && !!process.send);
	if (envelope) {
		bindSupervisedSelfLaunchTarget(envelope.stableTarget);
		channel = new RuntimeChildChannel(envelope);
	}
	return channel;
}
export function getRuntimeChildChannel(): RuntimeChildChannel | undefined {
	return channel;
}
