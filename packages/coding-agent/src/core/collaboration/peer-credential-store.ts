import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import { assertWindowsCurrentUserOnly, restrictWindowsToCurrentUser } from "../util/windows-user-acl.ts";
import { collaborationIdentitySchema, collaborationPeerInvocation } from "./peer-protocol.ts";

export interface CollaborationPeerCredential {
	agentId: string;
	token: string;
}

/**
 * The one owner of member credential files. A credential is written once per fresh member, read at each peer use,
 * and removed when that member closes or its job is dismissed or archived. It is never in the job record, the prompt,
 * the launch arguments or the environment. Access is private to the current user: POSIX mode and owner bits, or the
 * Windows access list, checked on every read.
 */
const CREDENTIAL_ROOT = "credentials";
const CREDENTIAL_SUFFIX = ".token";
const MAX_CREDENTIAL_BYTES = 128;
const POSIX = process.platform !== "win32";

function assertIdentity(id: string): void {
	if (!Value.Check(collaborationIdentitySchema, id)) throw new Error("Invalid collaboration credential identity.");
}

function jobDirectory(stateDirectory: string, jobId: string): string {
	assertIdentity(jobId);
	return join(stateDirectory, CREDENTIAL_ROOT, jobId);
}

function credentialFile(stateDirectory: string, jobId: string, agentId: string): string {
	assertIdentity(agentId);
	return join(jobDirectory(stateDirectory, jobId), `${agentId}${CREDENTIAL_SUFFIX}`);
}

/** POSIX owner and mode checks, or the Windows access list; both refuse anything another user can read. */
function assertPrivate(path: string, kind: "directory" | "file", label: string): void {
	const info = lstatSync(path);
	if (kind === "directory" ? !info.isDirectory() : !info.isFile())
		throw new Error(`${label} is not a regular ${kind}.`);
	if (POSIX) {
		if (process.getuid && info.uid !== process.getuid()) throw new Error(`${label} is not owned by this user.`);
		if ((info.mode & 0o077) !== 0) throw new Error(`${label} grants group or other access.`);
		return;
	}
	assertWindowsCurrentUserOnly(path);
}

/**
 * Writes each token atomically inside a private per-job directory: mode 0700 and 0600 on POSIX, and on Windows an
 * access list that inherits nothing and grants only the current user, applied before the first token is written.
 * The caller verifies the hashes first.
 */
export function writePeerCredentialFiles(
	stateDirectory: string,
	jobId: string,
	credentials: readonly CollaborationPeerCredential[],
): void {
	mkdirSync(join(stateDirectory, CREDENTIAL_ROOT), { recursive: true, mode: 0o700 });
	const directory = jobDirectory(stateDirectory, jobId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (lstatSync(directory).isSymbolicLink())
		throw new Error("Collaboration credential directory cannot be a symlink.");
	if (POSIX) chmodSync(directory, 0o700);
	else restrictWindowsToCurrentUser(directory, true);
	for (const { agentId, token } of credentials) {
		const file = credentialFile(stateDirectory, jobId, agentId);
		writeFileAtomicSync(file, token, { mode: 0o600 });
		if (!POSIX) assertWindowsCurrentUserOnly(file);
	}
}

/** Refuses a credential that another user can read or that is not a plain file. Never reports the value. */
export function readPeerCredentialFile(stateDirectory: string, jobId: string, agentId: string): string {
	const file = credentialFile(stateDirectory, jobId, agentId);
	try {
		assertPrivate(jobDirectory(stateDirectory, jobId), "directory", "Collaboration peer credential directory");
		assertPrivate(file, "file", "Collaboration peer credential");
	} catch (error) {
		if (isMissingFileError(error))
			throw new Error(
				`Missing collaboration peer credential file ${file}. The member's credential is removed when it stops or its job is dismissed or archived; a team admitted before the peer credential contract has none.`,
			);
		throw error;
	}
	return readBoundedTextFileSync(file, MAX_CREDENTIAL_BYTES, "Collaboration peer credential");
}

/** Existence only: a team whose members lack a credential file cannot report. Reads verify ownership and access. */
export function hasPeerCredentialFile(stateDirectory: string, jobId: string, agentId: string): boolean {
	return existsSync(credentialFile(stateDirectory, jobId, agentId));
}

/** Whether a job has ever published credentials under this root (the pre-contract gate reads this). */
export function hasPeerCredentialDirectory(stateDirectory: string, jobId: string): boolean {
	return existsSync(jobDirectory(stateDirectory, jobId));
}

export function removePeerCredentialFile(stateDirectory: string, jobId: string, agentId: string): void {
	rmSync(credentialFile(stateDirectory, jobId, agentId), { force: true });
}

export function removePeerCredentialFiles(stateDirectory: string, jobId: string): void {
	rmSync(jobDirectory(stateDirectory, jobId), { recursive: true, force: true });
}

/**
 * The command a member is given. A team admitted under the credential contract names each member by its identifier;
 * a team admitted before it has no credential directory, and its members keep the bare pre-contract command.
 */
export function memberPeerInvocation(
	stateDirectory: string,
	jobId: string,
	peerCommand: string,
	agentId: string,
): string {
	return hasPeerCredentialDirectory(stateDirectory, jobId)
		? collaborationPeerInvocation(peerCommand, agentId)
		: peerCommand;
}
