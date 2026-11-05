/**
 * The process entry of `pi --bot-daemon`: the core daemon plus the host's CI source for closed sessions' event routines.
 * gh's tokens arrive once on stdin from the starting session (see `daemon-environment.ts`) and stay in this closure,
 * reaching only the gh commands the CI source runs. The daemon starts at once: only a CI source waits for the handover.
 */
import { MAX_DAEMON_CREDENTIAL_BYTES, parseDaemonGhCredentials } from "../core/daemon-environment.ts";
import { runBotDaemonCommand } from "../core/delegation/bot-daemon.ts";
import { type AwayCiCredentials, createCiAwayEventSources } from "./ci/ci-away-event-sources.ts";

/** The starting session writes the payload and ends the pipe at once, so EOF always arrives; a terminal sends none. */
async function readCredentialHandover(): Promise<AwayCiCredentials> {
	try {
		if (process.stdin.isTTY) return { credentials: {} };
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of process.stdin) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			size += buffer.length;
			if (size > MAX_DAEMON_CREDENTIAL_BYTES)
				throw new Error(`the payload exceeds ${MAX_DAEMON_CREDENTIAL_BYTES} bytes.`);
			chunks.push(buffer);
		}
		return { credentials: parseDaemonGhCredentials(Buffer.concat(chunks).toString("utf8")) };
	} catch (error) {
		// Reported once by the CI source factory; gh then runs with its own configuration.
		return { credentials: {}, fault: error instanceof Error ? error.message : String(error) };
	}
}

export function runBotDaemonEntry(args: readonly string[]): Promise<number> {
	return runBotDaemonCommand(args, { eventSources: createCiAwayEventSources(readCredentialHandover()) });
}
