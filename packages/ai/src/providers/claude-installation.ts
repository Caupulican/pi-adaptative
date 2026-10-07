import {
	captureInstalledCliEnvironment,
	findInstalledCli,
	type InstalledCli,
	type InstalledCliEnvironment,
	readInstalledCliVersion,
} from "../utils/installed-cli.ts";
import { awaitAuthorizationInput } from "../utils/oauth/authorization-input.ts";

export type ClaudeInstallationInspection =
	| { status: "absent" }
	| { status: "unavailable" }
	| { status: "inspected"; version: string; sha256: string };

/** Node adapter: bounded --version execution, byte-only compatibility inspection, inert browser imports. */
export class ClaudeInstallationInspector {
	private previous: { fileIdentity: string; checkedAt: number; result: ClaudeInstallationInspection } | undefined;
	private readonly active = new Set<Promise<ClaudeInstallationInspection>>();

	async inspect(override?: string, environment?: InstalledCliEnvironment): Promise<ClaudeInstallationInspection> {
		if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") return { status: "absent" };
		if (this.active.size >= 4) return { status: "unavailable" };
		const signal = AbortSignal.timeout(10_000);
		const task = this.inspectInstallation(override, signal, environment);
		this.active.add(task);
		void task.then(
			() => this.active.delete(task),
			() => this.active.delete(task),
		);
		try {
			return await awaitAuthorizationInput(() => task, signal);
		} catch {
			return { status: "unavailable" };
		}
	}

	private async inspectInstallation(
		override: string | undefined,
		signal: AbortSignal,
		environment?: InstalledCliEnvironment,
	): Promise<ClaudeInstallationInspection> {
		const context = environment ?? captureInstalledCliEnvironment();
		const installation = await findInstalledCli("claude", override, signal, context);
		signal.throwIfAborted();
		if (!installation) return { status: override ? "unavailable" : "absent" };
		if (
			this.previous?.fileIdentity === installation.fileIdentity &&
			performance.now() - this.previous.checkedAt < 300_000
		)
			return this.previous.result;
		if (installation.size > 512 * 1024 * 1024) return { status: "unavailable" };
		const version = await readInstalledCliVersion(
			installation,
			/^(\d{1,6}\.\d{1,6}\.\d{1,6}) \(Claude Code\)$/,
			signal,
		);
		const sha256 = await this.fingerprint(installation, signal);
		const current = await findInstalledCli("claude", override, signal, context);
		signal.throwIfAborted();
		if (current?.fileIdentity !== installation.fileIdentity) return { status: "unavailable" };
		const result: ClaudeInstallationInspection = { status: "inspected", version, sha256 };
		this.previous = { fileIdentity: installation.fileIdentity, checkedAt: performance.now(), result };
		return result;
	}

	private async fingerprint(installation: InstalledCli, signal: AbortSignal): Promise<string> {
		const { createReadStream } = process.getBuiltinModule("node:fs");
		const { createHash } = process.getBuiltinModule("node:crypto");
		const hash = createHash("sha256");
		const stream = createReadStream(installation.path, { highWaterMark: 64 * 1024, signal });
		let bytes = 0;
		try {
			for await (const chunk of stream) {
				if (!(chunk instanceof Uint8Array)) throw new Error("Unexpected Claude installation data");
				bytes += chunk.length;
				if (bytes > 512 * 1024 * 1024) throw new Error("Claude installation exceeds inspection bounds");
				hash.update(chunk);
			}
			if (bytes !== installation.size) throw new Error("Claude installation changed during inspection");
			return hash.digest("hex");
		} finally {
			stream.destroy();
		}
	}
}
