/**
 * `/remote`: the owner's side of the link between machines. Any machine can listen as a hub, join a hub, or both; nothing
 * here names a machine or a path.
 */

import { interfaceText } from "../../core/language/interface-text.ts";
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
import { isJobCommand, runJobCommand } from "./remote-job-commands.ts";

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
	const words = interfaceText().machines.remote;
	if (link.state !== "connected") return link.state;
	return link.features?.includes(SEALED_FEATURE) ? words.connected : words.connectedUnsealed;
}

function statusText(port: RemoteCommandPort): string {
	const words = interfaceText().machines.remote;
	const { hub } = port;
	const status = hub.status();
	const joins = listJoins(hub.agentDir);
	const machines =
		status.machines.length > 0
			? words.status.machinesSome(
					status.machines
						.map(
							(m) =>
								`${m.name} ${
									m.revoked
										? words.status.machineRevoked
										: m.connected
											? m.sealed
												? words.status.machineConnectedSealed
												: words.status.machineConnectedUnsealed
											: words.status.machineOffline
								}`,
						)
						.join(", "),
				)
			: words.status.machinesNone;
	const joined =
		joins.length > 0
			? words.status.joinedSome(
					joins
						.map((j) =>
							words.status.jobJoined({
								hubName: j.hubName,
								address: j.address,
								name: j.name,
								state: joinStateText(joinStateFor(hub.agentDir, j.address)),
							}),
						)
						.join(", "),
				)
			: words.status.joinedNone;
	return [
		words.status.thisMachine(status.name),
		status.listening
			? words.status.listening(status.listening.host, status.listening.port)
			: status.hostedBy
				? words.status.hostedBy(hostDescription(status.hostedBy))
				: words.status.notListening,
		machines,
		joined,
	].join("\n");
}

export async function runRemoteCommand(
	rawText: string,
	port: RemoteCommandPort,
	host: RemoteCommandHost,
): Promise<void> {
	const words = interfaceText().machines.remote;
	const usage = words.usage(interfaceText().machines.jobs.usage);
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
					`${words.listen.listening(where?.host ?? "127.0.0.1", bound)} ${
						where && !isLoopback(where.host) ? words.listen.publicNote : words.listen.loopbackNote
					}`,
				);
				return;
			}
			case "stop":
				await hub.stopListening();
				host.showStatus(words.listen.stopped);
				return;
			case "add": {
				const name = rest[0] ?? "";
				if (!isMachineName(name)) return host.showWarning(words.add.usage(usage));
				let added: { token: string; address: string };
				try {
					added = hub.add(name);
				} catch (error) {
					return host.showWarning(error instanceof Error ? error.message : String(error));
				}
				const { token, address } = added;
				host.showStatus(words.add.added({ name, address, token, listening: Boolean(hub.status().listening) }));
				return;
			}
			case "revoke": {
				const name = rest[0] ?? "";
				host.showStatus(hub.revoke(name) ? words.add.revoked(name) : words.add.unknown(name));
				return;
			}
			case "join": {
				const address = rest[0] ?? "";
				const token = parseJoinToken(rest[1] ?? "");
				if (!parseAddress(address) || !token) return host.showWarning(words.join.usage);
				saveJoin(hub.agentDir, { address, name: token.name, hubName: token.hubName, secret: token.secret });
				port.reloadChannels();
				// A joined machine runs the hub's jobs by default: placement and the runner start now, not at the next start.
				hub.jobs?.start();
				host.showStatus(words.join.joined({ hubName: token.hubName, address, name: token.name }));
				return;
			}
			case "leave": {
				const left = removeJoin(hub.agentDir, rest[0] ?? "");
				port.reloadChannels();
				host.showStatus(left ? words.join.left : words.join.notJoined);
				return;
			}
			case "name": {
				const identity = renameIdentity(hub.agentDir, rest[0] ?? "");
				host.showStatus(words.rename(identity.name));
				return;
			}
			default:
				if (isJobCommand(sub)) return await runJobCommand(sub, rest, hub, host);
				host.showWarning(words.unknownCommand(usage));
		}
	} catch (error) {
		host.showWarning(error instanceof Error ? error.message : words.failed);
	}
}
