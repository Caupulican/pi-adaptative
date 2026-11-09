/**
 * `/remote`: the owner's side of the link between machines. Any machine can listen as a hub, join a hub, or both; nothing
 * here names a machine or a path.
 */

import { hostDescription, type RemoteHubController } from "../../core/remote/hub-controller.ts";
import { type JoinLinkState, joinStateFor } from "../../core/remote/link-context.ts";
import { isMachineName } from "../../core/remote/protocol.ts";
import {
	listJoins,
	parseAddress,
	parseJoinToken,
	removeJoin,
	renameIdentity,
	saveJoin,
} from "../../core/remote/registry.ts";
import { SEALED_FEATURE } from "../../core/remote/session-keys.ts";
import { isJobCommand, JOB_USAGE, runJobCommand } from "./remote-job-commands.ts";

const USAGE = `Usage: /remote [status] | /remote listen [port] [host] | /remote stop | /remote add <name> | /remote revoke <name> | /remote join <host:port> <token> | /remote leave <host:port> | /remote name <name> | ${JOB_USAGE}`;

export interface RemoteCommandPort {
	readonly hub: RemoteHubController;
	/** Reads the channel policies again (a hub was joined or left). */
	reloadChannels(): void;
}

export interface RemoteCommandHost {
	showStatus(text: string): void;
	showWarning(text: string): void;
}

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function joinStateText(link: JoinLinkState): string {
	if (link.state !== "connected") return link.state;
	return link.features?.includes(SEALED_FEATURE) ? "connected" : "connected, not sealed";
}

function statusText(port: RemoteCommandPort): string {
	const { hub } = port;
	const status = hub.status();
	const joins = listJoins(hub.agentDir);
	const lines = [
		`This machine is ${status.name}.`,
		status.listening
			? `Hub: listening on ${status.listening.host}:${status.listening.port}.`
			: status.hostedBy
				? `Hub: hosted by ${hostDescription(status.hostedBy)}; this session uses it.`
				: "Hub: not listening (/remote listen [port] [host]).",
		status.machines.length > 0
			? `Machines: ${status.machines.map((m) => `${m.name} ${m.revoked ? "revoked" : m.connected ? `connected${m.sealed ? "" : " (not sealed)"}` : "offline"}`).join(", ")}.`
			: "Machines: none yet (/remote add <name>).",
		joins.length > 0
			? `Joined to: ${joins.map((j) => `${j.hubName} at ${j.address} as ${j.name} (${joinStateText(joinStateFor(hub.agentDir, j.address))})`).join(", ")}.`
			: "Joined to: no hub (/remote join <host:port> <token>).",
	];
	return lines.join("\n");
}

export async function runRemoteCommand(
	rawText: string,
	port: RemoteCommandPort,
	host: RemoteCommandHost,
): Promise<void> {
	const [, sub = "", ...rest] = rawText.trim().split(/\s+/);
	const { hub } = port;
	try {
		switch (sub) {
			case "":
			case "status":
				host.showStatus(statusText(port));
				return;
			case "listen": {
				const bound = await hub.listen(rest[1] ?? "127.0.0.1", rest[0] === undefined ? undefined : Number(rest[0]));
				const where = hub.status().listening;
				host.showStatus(
					`Listening on ${where?.host ?? "127.0.0.1"}:${bound}. ${
						where && !isLoopback(where.host)
							? "The link proves a secret per machine and seals (encrypts and authenticates) every message with machines on a current build; a machine on an older build links unsealed. Prefer a private network (Tailscale, WireGuard) or an SSH tunnel."
							: "Bound to this machine only; use an SSH tunnel or give a host to reach it from another machine."
					}`,
				);
				return;
			}
			case "stop":
				await hub.stopListening();
				host.showStatus(
					"The hub stopped listening. Joined machines stay known and reconnect when it listens again.",
				);
				return;
			case "add": {
				const name = rest[0] ?? "";
				if (!isMachineName(name))
					return host.showWarning(`Usage: /remote add <name> (lowercase letters, digits, dashes). ${USAGE}`);
				let added: { token: string; address: string };
				try {
					added = hub.add(name);
				} catch (error) {
					return host.showWarning(error instanceof Error ? error.message : String(error));
				}
				const { token, address } = added;
				host.showStatus(
					`${name} can join now, as a bot named ${name}. On that machine run:\n/remote join ${address} ${token}\nThe token is shown once; keep it private.${
						hub.status().listening ? "" : "\nThis hub is not listening yet: run /remote listen."
					}`,
				);
				return;
			}
			case "revoke": {
				const name = rest[0] ?? "";
				host.showStatus(
					hub.revoke(name) ? `${name} was cut off and its bot retired.` : `No machine named ${name}.`,
				);
				return;
			}
			case "join": {
				const address = rest[0] ?? "";
				const token = parseJoinToken(rest[1] ?? "");
				if (!parseAddress(address) || !token) return host.showWarning("Usage: /remote join <host:port> <token>");
				saveJoin(hub.agentDir, { address, name: token.name, hubName: token.hubName, secret: token.secret });
				port.reloadChannels();
				// A joined machine runs the hub's jobs by default: placement and the runner start now, not at the next start.
				hub.jobs?.start();
				host.showStatus(
					`Joined ${token.hubName} at ${address} as ${token.name}. Its messages reach this session as a peer's words, never as yours.`,
				);
				return;
			}
			case "leave": {
				const left = removeJoin(hub.agentDir, rest[0] ?? "");
				port.reloadChannels();
				host.showStatus(left ? "Left that hub." : "No hub joined at that address.");
				return;
			}
			case "name": {
				const identity = renameIdentity(hub.agentDir, rest[0] ?? "");
				host.showStatus(`This machine is now ${identity.name}.`);
				return;
			}
			default:
				if (isJobCommand(sub)) return await runJobCommand(sub, rest, hub, host);
				host.showWarning(`Unknown /remote command. ${USAGE}`);
		}
	} catch (error) {
		host.showWarning(error instanceof Error ? error.message : "The link command failed.");
	}
}
