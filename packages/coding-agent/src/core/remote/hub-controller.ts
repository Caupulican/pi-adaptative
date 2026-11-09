/**
 * A session's hub: the machines the owner let join, shown as bots with a remote mark. It owns what survives a restart (where it
 * listens, who may join, each machine's chat log) and nothing about how a message is answered: the machine does that.
 * One root session per agent directory hosts it (`host-lock.ts`); the others do not bind the port, read the hosting
 * session's records for status, and take the hub over when that session lets it go. It also owns the session's remote
 * work placement (`remote-jobs.ts`): the hosting session's hub carries the job frames of its joined machines.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, UserMessage } from "@caupulican/pi-ai";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { AgentMessage } from "../../kernel/index.ts";
import { warmHostIdentity } from "../../kernel/reliability/host-identity.ts";
import type { ManagedLaneView } from "../delegation/managed-lane-views.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { type HostLock, type LinkHostOwner, linkHostOwner, takeHostLock, watchHostLockRelease } from "./host-lock.ts";
import { RemoteHub } from "./hub.ts";
import { JobTransport } from "./job-transport.ts";
import { type HubMachineLinkState, hubMachinesFor, provideLinkContext } from "./link-context.ts";
import { MachineChatLog } from "./machine-chat-log.ts";
import {
	addHubMachine,
	formatJoinToken,
	type HubMachineRecord,
	listHubMachines,
	loadIdentity,
	type MachineIdentity,
	rotateHubMachine,
	updateHubMachine,
} from "./registry.ts";
import { type RemoteJobPorts, RemoteJobs, type RemoteRosterWords } from "./remote-jobs.ts";
import { SEALED_FEATURE } from "./session-keys.ts";

const DEFAULT_PORT = 7788;
const DEFAULT_HOST = "127.0.0.1";

interface HubConfig {
	readonly host: string;
	readonly port: number;
	readonly enabled: boolean;
}

export interface RemoteHubControllerDeps {
	readonly agentDir: string;
	readonly getStore: () => PersistentBotTeamStore;
	/** A machine arrived or left: its bot is touched so the roster follows. */
	readonly changed: (machine: string) => void;
	/** The session's worker ports for remote work placement; absent, this session neither places nor runs jobs. */
	readonly jobs?: RemoteJobPorts;
}

export class RemoteHubController {
	private readonly deps: RemoteHubControllerDeps;
	private hub: RemoteHub | undefined;
	private listeningOn: { host: string; port: number } | undefined;
	private readonly identity: MachineIdentity;
	private readonly chats: MachineChatLog;
	private upSubtree: () => readonly string[] = () => [];
	private hostLock: HostLock | undefined;
	private stopWatchingHost: (() => void) | undefined;
	private transport: JobTransport | undefined;
	/** The session's remote work placement, when it has worker ports. */
	readonly jobs: RemoteJobs | undefined;

	constructor(deps: RemoteHubControllerDeps) {
		this.deps = deps;
		this.identity = loadIdentity(deps.agentDir);
		this.chats = new MachineChatLog(deps.agentDir);
		this.jobs = deps.jobs
			? new RemoteJobs(
					deps.agentDir,
					() => this.identity,
					deps.jobs,
					() => {
						for (const machine of listHubMachines(deps.agentDir))
							if (!machine.revoked) deps.changed(machine.name);
					},
				)
			: undefined;
		provideLinkContext(deps.agentDir, {
			subtree: () => this.reachableIds(),
			depth: () => this.chainDepth(),
		});
	}

	get machineName(): string {
		return this.identity.name;
	}

	get agentDir(): string {
		return this.deps.agentDir;
	}

	/**
	 * Starts listening when the owner turned the hub on earlier; a port that cannot be had is reported, not thrown. When
	 * another session on this agent directory hosts the hub, this one does not bind and says nothing: `/remote status`
	 * names the hosting session, and this session takes the hub over when that one lets it go.
	 */
	async start(): Promise<string | undefined> {
		const config = this.readConfig();
		// Placement and the job runner start only on a machine the owner linked (a hub on, a hub joined).
		if (config?.enabled || RemoteJobs.linked(this.deps.agentDir)) this.jobs?.start();
		// A hub the owner never turned on has nothing to host and nothing to wait for: no lock, no watch, no OS lookup.
		if (!config?.enabled) return undefined;
		try {
			// Off Linux the OS machine id is read asynchronously; until it is, a recorded host lock cannot be judged.
			await warmHostIdentity();
			if (!this.takeHost()) {
				// Not hosting: wait for the hosting session (or one started later) to let the hub go.
				this.watchHost();
				return undefined;
			}
			await this.listen(config.host, config.port);
			return undefined;
		} catch (error) {
			const where = config ? ` on ${config.host}:${config.port}` : "";
			return `The hub could not listen${where} (${error instanceof Error ? error.message : "unknown error"}).`;
		}
	}

	async stop(): Promise<void> {
		this.stopWatchingHost?.();
		this.stopWatchingHost = undefined;
		// The hub stops accepting as soon as its close starts, so the host is let go then: a session closing fast
		// still removes the lock and wakes the session waiting to take over.
		const closing = this.closeHub();
		this.hostLock?.release();
		this.hostLock = undefined;
		this.jobs?.dispose();
		await closing;
	}

	private async closeHub(): Promise<void> {
		await this.hub?.close();
		this.hub = undefined;
		this.listeningOn = undefined;
		this.transport?.dispose();
		this.transport = undefined;
	}

	/** Holds the link host for this agent directory (keeping a hold this session already has); false when another does. */
	private takeHost(): boolean {
		if (this.hostLock?.stillHeld()) return true;
		this.hostLock = undefined;
		const taken = takeHostLock(this.deps.agentDir);
		if (!taken.held) return false;
		this.hostLock = taken.lock;
		this.stopWatchingHost?.();
		this.stopWatchingHost = undefined;
		return true;
	}

	/** Waits, by watching the lock file, for the hosting session to let the hub go, then starts it here. */
	private watchHost(): void {
		if (this.stopWatchingHost) return;
		this.stopWatchingHost = watchHostLockRelease(this.deps.agentDir, () => {
			if (this.hub) return;
			void this.start().then((problem) => {
				if (problem)
					harnessLog.warn("link", "taking over the hub from a session that let it go failed", { problem });
			});
		});
	}

	/** The other session hosting the hub here, when this one does not. */
	private hostedElsewhere(): LinkHostOwner | undefined {
		return this.hub ? undefined : linkHostOwner(this.deps.agentDir);
	}

	/** The machines the hosting session has joined right now, by name, when that session is another one. */
	private hostedMachines(): Map<string, HubMachineLinkState> {
		if (!this.hostedElsewhere()) return new Map();
		return new Map(
			Object.values(hubMachinesFor(this.deps.agentDir))
				.filter((machine) => machine.connected)
				.map((machine) => [machine.name, machine]),
		);
	}

	private chainDepth(): number {
		if (this.hub) return this.hub.chainDepth();
		const depths = [...this.hostedMachines().values()].map((machine) => machine.depth);
		return depths.length === 0 ? 0 : 1 + Math.max(...depths);
	}

	/** Reports the ids of this machine's own joiners to a hub it joined, so that hub can refuse a loop. */
	setUpSubtree(read: () => readonly string[]): void {
		this.upSubtree = read;
	}

	/** The ids of the machines joined here and theirs (the hosting session's, when it is another one). */
	reachableIds(): string[] {
		if (this.hub) return this.hub.reachableIds();
		if (!this.hostedElsewhere()) return [];
		return Object.entries(hubMachinesFor(this.deps.agentDir)).flatMap(([machineId, machine]) =>
			machine.connected ? [machineId, ...machine.subtree] : [],
		);
	}

	async listen(host = DEFAULT_HOST, port = DEFAULT_PORT): Promise<number> {
		await this.closeHub();
		await warmHostIdentity();
		if (!this.takeHost()) throw new Error(hostedElsewhereText(linkHostOwner(this.deps.agentDir), "listen there"));
		this.jobs?.start();
		const transport = new JobTransport({
			agentDir: this.deps.agentDir,
			selfId: this.identity.machineId,
			onFleetChange: () => this.jobs?.machines.notify(),
		});
		this.transport = transport;
		const hub = new RemoteHub({
			agentDir: this.deps.agentDir,
			identity: this.identity,
			upSubtree: () => this.upSubtree(),
			peers: transport,
			events: {
				reply: (machine, id, text) => this.received(machine, id, text),
				presence: (machine) => this.deps.changed(machine),
			},
		});
		let bound: number;
		try {
			bound = await hub.listen(host, port);
		} catch (error) {
			// A hub that cannot bind hosts nothing: the next session to start may host it.
			this.hostLock?.release();
			this.hostLock = undefined;
			transport.dispose();
			this.transport = undefined;
			throw error;
		}
		harnessLog.info("link", "the hub is listening", { host, port: bound });
		this.hub = hub;
		this.listeningOn = { host, port: bound };
		this.writeConfig({ host, port: bound, enabled: true });
		return bound;
	}

	async stopListening(): Promise<void> {
		const elsewhere = this.hostedElsewhere();
		if (elsewhere) throw new Error(hostedElsewhereText(elsewhere, "stop it there"));
		// Turned off before the host is let go, so a session watching for the hub does not take it back up.
		const config = this.readConfig();
		if (config) this.writeConfig({ ...config, enabled: false });
		await this.stop();
	}

	status(): {
		name: string;
		listening?: { host: string; port: number };
		/** The other session on this agent directory that hosts the hub. */
		hostedBy?: LinkHostOwner;
		machines: ReturnType<RemoteHubController["list"]>;
	} {
		const hostedBy = this.listeningOn ? undefined : this.hostedElsewhere();
		return {
			name: this.identity.name,
			...(this.listeningOn ? { listening: this.listeningOn } : {}),
			...(hostedBy ? { hostedBy } : {}),
			machines: this.list(),
		};
	}

	list(): { name: string; connected: boolean; sealed: boolean; revoked: boolean; createdAt: string }[] {
		const hosted = this.hub ? undefined : this.hostedMachines();
		return listHubMachines(this.deps.agentDir).map((machine) => {
			const elsewhere = hosted?.get(machine.name);
			return {
				name: machine.name,
				connected: this.hub ? this.hub.isConnected(machine.name) : elsewhere !== undefined,
				sealed: this.hub ? this.hub.isSealed(machine.name) : elsewhere?.features.includes(SEALED_FEATURE) === true,
				revoked: machine.revoked === true,
				createdAt: machine.createdAt,
			};
		});
	}

	isRemote(agentId: string): boolean {
		return this.deps.getStore().getBot(agentId)?.remote === true;
	}

	isOnline(agentId: string): boolean {
		return this.hub ? this.hub.isConnected(agentId) : this.hostedMachines().has(agentId);
	}

	/** A joined machine's roster row from facts: connected or not, the jobs placed there, its room. */
	rosterWords(agentId: string): RemoteRosterWords {
		const online = this.isOnline(agentId);
		return this.jobs?.rosterWords(agentId, online) ?? { state: online ? "idle" : "offline" };
	}

	/** A worker row of a job placed on another machine, in plain words; any other row as it is. */
	describeLane(view: ManagedLaneView): ManagedLaneView {
		return this.jobs?.describeLane(view) ?? view;
	}

	/** Lets a machine join as a bot named `name`; the token goes to the owner once, to carry to that machine. */
	add(name: string): { token: string; address: string } {
		const { record } = addHubMachine(this.deps.agentDir, name);
		this.deps.getStore().upsertBot({
			agentId: name,
			displayName: name,
			provider: "link",
			modelId: "remote",
			description: `Machine ${name}, joined to ${this.identity.name}`,
			remote: true,
			createdBy: "owner",
		});
		const host =
			this.listeningOn?.host === DEFAULT_HOST || !this.listeningOn
				? "<this-machine-address>"
				: this.listeningOn.host;
		return {
			token: formatJoinToken(this.identity.name, name, record.secret),
			address: `${host}:${this.listeningOn?.port ?? readPort(this.readConfig())}`,
		};
	}

	/** Cuts a machine off and retires its bot; its chat log stays. */
	revoke(name: string): boolean {
		const record = updateHubMachine(this.deps.agentDir, name, { revoked: true });
		if (!record) return false;
		this.hub?.disconnect(name);
		this.deps.getStore().retireBot(name);
		// A revoke is not a lost link: the machine's jobs end now instead of waiting out the offline hold.
		if (record.machineId) this.jobs?.client.revokeMachine(record.machineId);
		return true;
	}

	/**
	 * Gives a joined machine a new secret and cuts its connection; it joins again with the new token. Its install id is
	 * kept, so its jobs survive. The token goes to the owner once.
	 */
	rotate(name: string): { token: string } | undefined {
		const record = rotateHubMachine(this.deps.agentDir, name);
		if (!record) return undefined;
		this.hub?.disconnect(name);
		harnessLog.info("link", "a joined machine's secret was rotated", { machine: name });
		return { token: formatJoinToken(this.identity.name, name, record.secret) };
	}

	private requireHub(name: string): RemoteHub {
		if (this.hub) return this.hub;
		const elsewhere = this.hostedElsewhere();
		throw new Error(
			elsewhere
				? hostedElsewhereText(elsewhere, `message ${name} from there`)
				: "This session is not a hub: turn it on with /remote listen.",
		);
	}

	/** Sends the owner's own words to a joined machine; its answer arrives into the machine's chat, live where it is open. */
	send(name: string, text: string): string {
		const id = this.requireHub(name).send(name, text);
		harnessLog.debug("link", "a message was sent to a machine", { machine: name, chars: text.length });
		this.chats.append(name, { at: Date.now(), from: "hub", text, id });
		return id;
	}

	/**
	 * Asks a joined machine on behalf of the orchestrator: a conversation turn that is a lane (`RemoteJobClient.ask`), so
	 * the answer, or the machine going silent, offline or revoked, ends the lane and reaches the asking session through
	 * the one terminal notification every worker uses. Returns the turn's id; throws with the reason when it is refused.
	 */
	async ask(name: string, text: string): Promise<string> {
		const hub = this.requireHub(name);
		const machine = this.jobs?.machines.byName(name);
		// A session without worker ports places no lanes: the words still go, and the answer is chat only.
		if (!this.jobs || !machine) return this.send(name, text);
		const placed = await this.jobs.client.ask(machine, text, {}, (id) => {
			hub.send(name, text, id);
		});
		if (placed.kind === "refused") throw new Error(placed.reason);
		harnessLog.debug("link", "a conversation turn was placed on a machine", { machine: name, chars: text.length });
		this.chats.append(name, { at: Date.now(), from: "hub", text, id: placed.handle.jobId });
		return placed.handle.jobId;
	}

	/** The machine's chat, as the bot chat shows any bot's: the owner's words as user messages, the machine's as replies. */
	chat(name: string): AgentMessage[] {
		return this.chats.read(name).map((entry): AgentMessage => {
			if (entry.from === "hub") {
				const message: UserMessage = {
					role: "user",
					content: [{ type: "text", text: entry.text }],
					timestamp: entry.at,
				};
				return message;
			}
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: entry.text }],
				api: "link" as AssistantMessage["api"],
				provider: "link",
				model: name,
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: entry.at,
			};
			return message;
		});
	}

	private received(machine: string, id: string, text: string): void {
		harnessLog.debug("link", "a machine answered", { machine, chars: text.length });
		this.chats.append(machine, { at: Date.now(), from: "machine", text, id });
		this.deps.getStore().upsertBot({ agentId: machine, lastSummary: text, lastMessageAt: Date.now() });
		// A reply to a conversation turn the orchestrator placed is that lane's end.
		const machineId = this.jobs?.machines.byName(machine)?.machineId;
		if (machineId) this.jobs?.client.completeAsk(machineId, id, text);
	}

	private readConfig(): HubConfig | undefined {
		const path = join(this.deps.agentDir, "remote", "hub.json");
		if (!existsSync(path)) return undefined;
		try {
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			return isPlainRecord(value) && typeof value.host === "string" && typeof value.port === "number"
				? { host: value.host, port: value.port, enabled: value.enabled === true }
				: undefined;
		} catch {
			return undefined;
		}
	}

	private writeConfig(config: HubConfig): void {
		mkdirSync(join(this.deps.agentDir, "remote"), { recursive: true });
		writeFileSync(join(this.deps.agentDir, "remote", "hub.json"), `${JSON.stringify(config, null, 1)}\n`);
	}
}

function readPort(config: HubConfig | undefined): number {
	return config?.port ?? DEFAULT_PORT;
}

/** The plain words for a hub another session on this agent directory hosts. */
export function hostedElsewhereText(owner: LinkHostOwner | undefined, then: string): string {
	if (!owner) return "Another session on this machine is taking the hub; try again in a moment.";
	return `The hub for this agent directory runs in ${hostDescription(owner)}; ${then}.`;
}

/** The hosting session in the owner's words; one whose process cannot be checked is said to be so. */
export function hostDescription(owner: LinkHostOwner): string {
	if (owner.standing === "foreign") return "a session on another host";
	if (owner.standing === "unknown") return `a session whose process (${owner.pid}) could not be checked`;
	return `another session on this machine (process ${owner.pid})`;
}

export type { HubMachineRecord };
