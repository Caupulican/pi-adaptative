import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isWorkerSession } from "../session-role.ts";
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
	/** Set only by the broker: the peer proved it holds this machine's pi session secret. Never self-declared. */
	verified?: boolean;
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
	/** Mail held for a recipient that was not running: the durable side of the mesh. */
	inbox: string;
	/** One credential per session id, so a resumed session re-claims the id it had. */
	credentials: string;
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
		inbox: join(root, "inbox"),
		credentials: join(localSessions, "credentials"),
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

/**
 * A 256-bit secret kept in a file (mode 0600), created by the first process that needs it. A file readable by group or
 * others is not trusted: no secret is returned for it. `beforeCreate` runs only when the file is about to be created.
 */
function readOrCreateSecretFile(file: string, beforeCreate?: () => void): string | undefined {
	const readSecret = (): string | undefined => {
		if ((statSync(file).mode & 0o077) !== 0) return undefined;
		const secret = readFileSync(file, "utf8").trim();
		return /^[0-9a-f]{64}$/.test(secret) ? secret : undefined;
	};
	try {
		return readSecret();
	} catch (error: unknown) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}
	beforeCreate?.();
	const created = randomBytes(32).toString("hex");
	try {
		writeFileSync(file, `${created}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		return created;
	} catch (error: unknown) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		return readSecret();
	}
}

/**
 * The machine's pi session secret (`session.key`, mode 0600, created by the first session that needs it). A
 * session proves it is a real pi session by keying its hello with it; the broker never accepts a claim of
 * that. A worker-role process never reads it, and a file readable by group or others is not trusted.
 */
export function readChatSessionSecret(root: string): string | undefined {
	if (isWorkerSession()) return undefined;
	ensureChatStateDirs(root);
	return readOrCreateSecretFile(join(root, "session.key"));
}

/** Credential files kept at most this many; past it, files unused for {@link CREDENTIAL_MAX_AGE_MS} are removed. */
const MAX_CREDENTIAL_FILES = 2048;
const CREDENTIAL_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function pruneCredentialFiles(dir: string, now: number): void {
	const names = readdirSync(dir).filter((name) => name.endsWith(".key"));
	if (names.length < MAX_CREDENTIAL_FILES) return;
	for (const name of names) {
		const file = join(dir, name);
		try {
			if (now - statSync(file).mtimeMs > CREDENTIAL_MAX_AGE_MS) unlinkSync(file);
		} catch (error: unknown) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
	}
}

/**
 * The credential this session id presents to the broker, created once and kept (`<digest of id>.key`, mode 0600, in the
 * 0700 state directory, the same boundary as `session.key`). Because it survives the process, a resumed session
 * re-claims its id after the broker restarted or forgot it. A worker-role process never reads it, and a file readable by
 * group or others is not trusted: the broker then issues a fresh credential for that connection, as before.
 */
export function loadSessionCredential(root: string, peerId: string): string | undefined {
	if (isWorkerSession()) return undefined;
	ensureChatStateDirs(root);
	const dir = getChatStatePaths(root).credentials;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodBestEffort(dir, 0o700);
	const digest = createHash("sha256").update(`pi-chat-credential-v1\0${peerId}`).digest("hex").slice(0, 40);
	const file = join(dir, `${digest}.key`);
	return readOrCreateSecretFile(file, () => pruneCredentialFiles(dir, Date.now()));
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
