import { readProcessTerminationProtection } from "../../kernel/reliability/process-termination-protection.ts";
import type { HerdrEventChannel } from "./herdr-channel.ts";
import { herdrRecord } from "./herdr-codec.ts";

export type HerdrPaneOwnership =
	| { status: "owned" }
	| { status: "foreign" }
	| { status: "unverifiable"; reason: string };

function pidOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Herdr's environment pane ids are a claim. A process started outside its pane's tree (a Codex app-server's tool
 * shell, for one) inherits the ids of whatever started that tree. Herdr's pane.process_info names the pane's shell,
 * which is the session leader on the pane's tty, and the pane's foreground processes; every process on the tty
 * descends from that shell. The pane is this process's when one of those pids is this process or an ancestor, which
 * the kernel ancestry observer reports (its set also carries process groups of the chain, so a match on a group is
 * still the same terminal session). A chain that names none of them is foreign: the claimed pane is not ours. A failed
 * query or unobservable ancestry is unverifiable, never foreign.
 */
export async function herdrPaneOwnership(channel: HerdrEventChannel, paneId: string): Promise<HerdrPaneOwnership> {
	let candidates: number[];
	try {
		const info = herdrRecord(
			herdrRecord(await channel.request("pane.process_info", { pane_id: paneId })).process_info,
		);
		const foreground = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
		candidates = [pidOf(info.shell_pid), ...foreground.map((entry) => pidOf(herdrRecord(entry).pid))].filter(
			(pid): pid is number => pid !== undefined,
		);
	} catch (error) {
		return { status: "unverifiable", reason: `pane process query failed (${describe(error)})` };
	}
	if (candidates.length === 0) return { status: "unverifiable", reason: "the pane names no process" };
	const chain = readProcessTerminationProtection();
	if (chain === undefined) return { status: "unverifiable", reason: "process ancestry could not be observed" };
	return candidates.some((pid) => chain.has(pid)) ? { status: "owned" } : { status: "foreign" };
}
