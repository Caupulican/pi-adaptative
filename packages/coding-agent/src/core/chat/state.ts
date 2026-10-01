import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CHAT_CONFIG_VERSION } from "./constants.ts";

export type ChatConfig = {
	version: number;
	createdAt: string;
	updatedAt: string;
	broadcastEnabled: boolean;
	/** Fields written by other pi-chat implementations are preserved on update, never interpreted here. */
	[extra: string]: unknown;
};

export type ChatIdentity = {
	id: string;
	name: string;
	pcLabel: string;
	createdAt: string;
	storage: "filesystem-fallback";
};

export type PeerRecord = {
	id: string;
	name: string;
	address: string;
	scope: "local" | "network" | "relay";
	busy?: boolean;
	lastSeen?: string;
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ChatStatePaths = {
	root: string;
	config: string;
	identity: string;
	peers: string;
	audit: string;
	localSessions: string;
	socket: string;
};

export function getChatStatePaths(root: string): ChatStatePaths {
	const localSessions = join(root, "sessions", "local");
	return {
		root,
		config: join(root, "config.json"),
		identity: join(root, "identity.json"),
		peers: join(root, "peers.json"),
		audit: join(localSessions, "audit.jsonl"),
		localSessions,
		socket: join(localSessions, "broker.sock"),
	};
}

function chmodBestEffort(targetPath: string, mode: number): void {
	if (process.platform === "win32") return;
	try {
		chmodSync(targetPath, mode);
	} catch {
		// Permissions are best-effort on some filesystems.
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

export function ensureChatStateDirs(root: string): void {
	const paths = getChatStatePaths(root);
	mkdirSync(paths.localSessions, { recursive: true, mode: 0o700 });
	chmodBestEffort(paths.root, 0o700);
	chmodBestEffort(dirname(paths.localSessions), 0o700);
	chmodBestEffort(paths.localSessions, 0o700);
}

export function readJsonFile<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as T;
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export function atomicWriteJson(filePath: string, value: JsonValue, mode = 0o600): void {
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	chmodBestEffort(dirname(filePath), 0o700);
	const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
	const fd = openSync(tempPath, "w", mode);
	try {
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	chmodBestEffort(tempPath, mode);
	renameSync(tempPath, filePath);
	chmodBestEffort(filePath, mode);
}

export function createDefaultChatConfig(now = new Date()): ChatConfig {
	const timestamp = now.toISOString();
	return {
		version: CHAT_CONFIG_VERSION,
		createdAt: timestamp,
		updatedAt: timestamp,
		broadcastEnabled: false,
	};
}

export function readChatConfig(root: string): ChatConfig | undefined {
	return readJsonFile<ChatConfig>(getChatStatePaths(root).config);
}

export function writeChatConfig(root: string, config: ChatConfig): void {
	ensureChatStateDirs(root);
	atomicWriteJson(getChatStatePaths(root).config, config as unknown as JsonValue);
}

export function readChatIdentity(root: string): ChatIdentity | undefined {
	return readJsonFile<ChatIdentity>(getChatStatePaths(root).identity);
}

export function writeChatIdentity(root: string, identity: ChatIdentity): void {
	ensureChatStateDirs(root);
	atomicWriteJson(getChatStatePaths(root).identity, identity as unknown as JsonValue);
}

export function readChatPeers(root: string): PeerRecord[] {
	const value = readJsonFile<{ peers?: PeerRecord[] }>(getChatStatePaths(root).peers);
	return Array.isArray(value?.peers) ? value.peers : [];
}

export function writeChatPeers(root: string, peers: PeerRecord[]): void {
	ensureChatStateDirs(root);
	atomicWriteJson(getChatStatePaths(root).peers, { peers } as unknown as JsonValue);
}

/** Audit lines carry metadata only: never a message body. */
export function appendChatAudit(root: string, event: { [key: string]: JsonValue }): void {
	ensureChatStateDirs(root);
	const paths = getChatStatePaths(root);
	appendFileSync(paths.audit, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	chmodBestEffort(paths.audit, 0o600);
}

export function chatStateSummary(root: string): {
	root: string;
	configured: boolean;
	identityAvailable: boolean;
	peerCount: number;
} {
	return {
		root,
		configured: existsSync(getChatStatePaths(root).config),
		identityAvailable: readChatIdentity(root) !== undefined,
		peerCount: readChatPeers(root).length,
	};
}
