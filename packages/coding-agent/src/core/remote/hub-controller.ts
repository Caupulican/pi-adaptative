/**
 * A session's hub: the machines the owner let join, shown as bots with a remote mark. It owns what survives a restart (where it
 * listens, who may join, each machine's chat log) and nothing about how a message is answered: the machine does that.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, UserMessage } from "@caupulican/pi-ai";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { AgentMessage } from "../../kernel/index.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { RemoteHub } from "./hub.ts";
import { provideLinkContext } from "./link-context.ts";
import {
	addHubMachine,
	formatJoinToken,
	type HubMachineRecord,
	listHubMachines,
	loadIdentity,
	type MachineIdentity,
	updateHubMachine,
} from "./registry.ts";

const MAX_LOGGED = 200;
const DEFAULT_PORT = 7788;
const DEFAULT_HOST = "127.0.0.1";

interface HubConfig {
	readonly host: string;
	readonly port: number;
	readonly enabled: boolean;
}

interface LoggedMessage {
	readonly at: number;
	readonly from: "hub" | "machine";
	readonly text: string;
}

export interface RemoteHubControllerDeps {
	readonly agentDir: string;
	readonly getStore: () => PersistentBotTeamStore;
	/** A machine arrived or left: its bot is touched so the roster follows. */
	readonly changed: (machine: string) => void;
}

export class RemoteHubController {
	private readonly deps: RemoteHubControllerDeps;
	private hub: RemoteHub | undefined;
	private listeningOn: { host: string; port: number } | undefined;
	private readonly identity: MachineIdentity;
	private upSubtree: () => readonly string[] = () => [];

	constructor(deps: RemoteHubControllerDeps) {
		this.deps = deps;
		this.identity = loadIdentity(deps.agentDir);
		provideLinkContext(deps.agentDir, {
			subtree: () => this.reachableIds(),
			depth: () => this.hub?.chainDepth() ?? 0,
		});
	}

	get machineName(): string {
		return this.identity.name;
	}

	get agentDir(): string {
		return this.deps.agentDir;
	}

	/** Starts listening when the owner turned the hub on earlier; a port that cannot be had is reported, not thrown. */
	async start(): Promise<string | undefined> {
		const config = this.readConfig();
		if (!config?.enabled) return undefined;
		try {
			await this.listen(config.host, config.port);
			return undefined;
		} catch (error) {
			return `The hub could not listen on ${config.host}:${config.port} (${error instanceof Error ? error.message : "unknown error"}).`;
		}
	}

	async stop(): Promise<void> {
		await this.hub?.close();
		this.hub = undefined;
		this.listeningOn = undefined;
	}

	/** Reports the ids of this machine's own joiners to a hub it joined, so that hub can refuse a loop. */
	setUpSubtree(read: () => readonly string[]): void {
		this.upSubtree = read;
	}

	/** The ids of the machines joined here and theirs. */
	reachableIds(): string[] {
		return this.hub?.reachableIds() ?? [];
	}

	async listen(host = DEFAULT_HOST, port = DEFAULT_PORT): Promise<number> {
		await this.stop();
		const hub = new RemoteHub({
			agentDir: this.deps.agentDir,
			identity: this.identity,
			upSubtree: () => this.upSubtree(),
			events: {
				reply: (machine, _id, text) => this.received(machine, text),
				presence: (machine) => this.deps.changed(machine),
			},
		});
		const bound = await hub.listen(host, port);
		harnessLog.info("link", "the hub is listening", { host, port: bound });
		this.hub = hub;
		this.listeningOn = { host, port: bound };
		this.writeConfig({ host, port: bound, enabled: true });
		return bound;
	}

	async stopListening(): Promise<void> {
		await this.stop();
		const config = this.readConfig();
		if (config) this.writeConfig({ ...config, enabled: false });
	}

	status(): {
		name: string;
		listening?: { host: string; port: number };
		machines: ReturnType<RemoteHubController["list"]>;
	} {
		return {
			name: this.identity.name,
			...(this.listeningOn ? { listening: this.listeningOn } : {}),
			machines: this.list(),
		};
	}

	list(): { name: string; connected: boolean; revoked: boolean; createdAt: string }[] {
		return listHubMachines(this.deps.agentDir).map((machine) => ({
			name: machine.name,
			connected: this.hub?.isConnected(machine.name) === true,
			revoked: machine.revoked === true,
			createdAt: machine.createdAt,
		}));
	}

	isRemote(agentId: string): boolean {
		return this.deps.getStore().getBot(agentId)?.remote === true;
	}

	isOnline(agentId: string): boolean {
		return this.hub?.isConnected(agentId) === true;
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
		return true;
	}

	/** Sends the owner's (or the orchestrator's) words to a joined machine; its answer arrives into the machine's chat. */
	send(name: string, text: string): string {
		if (!this.hub) throw new Error("This session is not a hub: turn it on with /remote listen.");
		const id = this.hub.send(name, text);
		harnessLog.debug("link", "a message was sent to a machine", { machine: name, chars: text.length });
		this.log(name, { at: Date.now(), from: "hub", text });
		return id;
	}

	/** The machine's chat, as the bot chat shows any bot's: the owner's words as user messages, the machine's as replies. */
	chat(name: string): AgentMessage[] {
		return this.readLog(name).map((entry): AgentMessage => {
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

	private received(machine: string, text: string): void {
		harnessLog.debug("link", "a machine answered", { machine, chars: text.length });
		this.log(machine, { at: Date.now(), from: "machine", text });
		this.deps.getStore().upsertBot({ agentId: machine, lastSummary: text, lastMessageAt: Date.now() });
	}

	private logPath(name: string): string {
		return join(this.deps.agentDir, "remote", "chats", `${name}.jsonl`);
	}

	private log(name: string, entry: LoggedMessage): void {
		const path = this.logPath(name);
		mkdirSync(join(this.deps.agentDir, "remote", "chats"), { recursive: true });
		appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	}

	private readLog(name: string): LoggedMessage[] {
		const path = this.logPath(name);
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8")
			.split("\n")
			.flatMap((line): LoggedMessage[] => {
				try {
					const value: unknown = JSON.parse(line);
					return isPlainRecord(value) &&
						typeof value.at === "number" &&
						(value.from === "hub" || value.from === "machine") &&
						typeof value.text === "string"
						? [{ at: value.at, from: value.from, text: value.text }]
						: [];
				} catch {
					return [];
				}
			})
			.slice(-MAX_LOGGED);
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

export type { HubMachineRecord };
