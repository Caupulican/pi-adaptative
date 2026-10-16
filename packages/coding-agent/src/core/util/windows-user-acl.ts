import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";

/**
 * Windows access control for private files: a path is private when every ACL entry names the current user. icacls
 * prints principal names in the system language (its own output above is Portuguese), but the rights codes such as
 * (F), (OI) and (I) are language-neutral, and the path is echoed verbatim. The current user is matched by account
 * name and by DOMAIN\name, so a localized system never changes which entries count as the user's.
 */
const ICACLS = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
const ICACLS_TIMEOUT_MS = 5000;
const RIGHTS_GROUPS = /^(?:\([A-Za-z,]+\))+$/;

export interface WindowsAclEntry {
	principal: string;
	rights: string;
}

function currentAccount(): { name: string; qualified: string } {
	const name = userInfo().username;
	const domain = process.env.USERDOMAIN;
	return { name, qualified: domain ? `${domain}\\${name}` : name };
}

function runIcacls(args: readonly string[]): string {
	// Windows-1252 bytes, as icacls writes them to a pipe on this host (an account name with accents keeps its letters).
	const result = spawnSync(ICACLS, [...args], {
		encoding: "latin1",
		timeout: ICACLS_TIMEOUT_MS,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw new Error(`icacls could not run (${result.error.message}).`);
	if (result.status !== 0) throw new Error(`icacls exited with status ${result.status}.`);
	return result.stdout;
}

/** Entries of `icacls <path>` output; lines that carry no entry (the summary, blank lines) are skipped. */
export function parseWindowsAclEntries(output: string, path: string): WindowsAclEntry[] {
	const entries: WindowsAclEntry[] = [];
	for (const raw of output.split(/\r?\n/)) {
		let line = raw.trim();
		if (line.startsWith(path)) line = line.slice(path.length).trim();
		const separator = line.indexOf(":(");
		if (separator <= 0) continue;
		const principal = line.slice(0, separator);
		const rights = line.slice(separator + 1);
		if (RIGHTS_GROUPS.test(rights)) entries.push({ principal, rights });
	}
	return entries;
}

/** Refuses unless every entry of the path names the current account. An unreadable ACL is refused, never assumed. */
export function assertWindowsCurrentUserOnly(path: string): void {
	const entries = parseWindowsAclEntries(runIcacls([path]), path);
	if (entries.length === 0) throw new Error(`The access list of ${path} could not be read.`);
	const account = currentAccount();
	const foreign = entries.filter((entry) => {
		const principal = entry.principal.toLowerCase();
		const own = principal === account.name.toLowerCase() || principal === account.qualified.toLowerCase();
		return !own && !entry.rights.includes("(DENY)");
	});
	if (foreign.length > 0) throw new Error(`${path} grants access to another principal.`);
}

/** Drops inherited entries and grants only the current account; children created afterwards inherit that grant. */
export function restrictWindowsToCurrentUser(path: string, directory: boolean): void {
	const grant = `${currentAccount().qualified}:${directory ? "(OI)(CI)F" : "F"}`;
	runIcacls([path, "/inheritance:r", "/grant:r", grant]);
	assertWindowsCurrentUserOnly(path);
}
