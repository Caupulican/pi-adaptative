/**
 * SSH Remote Execution Example
 *
 * Demonstrates delegating tool operations to a remote machine via SSH.
 * When --ssh is provided, read/write/edit/bash run on the remote.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash and GNU coreutils (sha256sum, stat) on remote
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import type { ExtensionAPI } from "@caupulican/pi-adaptative";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	FileMutationIntentController,
	type FileMutationIntentOperations,
	type FilePathInspection,
	type ReadOperations,
	type WriteOperations,
} from "@caupulican/pi-adaptative";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sshExec(remote: string, command: string, stdin?: string | Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [remote, command], { stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
		child.stdin.end(stdin);
	});
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		readFile: (p) => sshExec(remote, `cat -- ${shellQuote(toRemote(p))}`),
		access: (p) => sshExec(remote, `test -r ${shellQuote(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const r = await sshExec(remote, `file --mime-type -b -- ${shellQuote(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

async function writeRemoteContent(remote: string, path: string, content: string, exclusive: boolean): Promise<void> {
	const noClobber = exclusive ? "set -o noclobber; " : "";
	await sshExec(remote, `${noClobber}cat > ${shellQuote(path)}`, content);
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		createFile: (p, content) => writeRemoteContent(remote, toRemote(p), content, true),
		mkdir: (dir) => sshExec(remote, `mkdir -p -- ${shellQuote(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		readFile: r.readFile,
		writeFile: (p, content) => writeRemoteContent(remote, toRemote(p), content, false),
	};
}

function createRemoteIntentOps(remote: string, remoteCwd: string, localCwd: string): FileMutationIntentOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		async inspect(p, followSymlinks): Promise<FilePathInspection | undefined> {
			const path = shellQuote(toRemote(p));
			const kind = followSymlinks
				? `if [ -f ${path} ]; then printf 'file\\t'; elif [ -d ${path} ]; then printf 'directory\\t'; elif [ -e ${path} ]; then printf 'other\\t'; else exit 44; fi`
				: `if [ -L ${path} ]; then printf 'other\\t'; elif [ -f ${path} ]; then printf 'file\\t'; elif [ -d ${path} ]; then printf 'directory\\t'; elif [ -e ${path} ]; then printf 'other\\t'; else exit 44; fi`;
			const follow = followSymlinks ? "-L " : "";
			try {
				const output = (
					await sshExec(
						remote,
						`${kind}; stat ${follow}--printf ${shellQuote("%d\\t%i\\t%f\\t%s\\t%y\\t%z")} -- ${path}`,
					)
				)
					.toString("utf8")
					.trimEnd();
				const [entryKind, dev, ino, mode, size, mtimeMs, ctimeMs] = output.split("\t");
				if (
					(entryKind !== "file" && entryKind !== "directory" && entryKind !== "other") ||
					!dev ||
					!ino ||
					!mode ||
					!size ||
					!mtimeMs ||
					!ctimeMs
				) {
					throw new Error(`Unexpected remote stat response for ${p}`);
				}
				return { kind: entryKind, identity: { dev, ino, mode, size, mtimeMs, ctimeMs } };
			} catch (error) {
				if (String(error).includes("SSH failed (44)")) return undefined;
				throw error;
			}
		},
		access(p, mode) {
			const path = shellQuote(toRemote(p));
			const checks = [
				mode & constants.R_OK ? `test -r ${path}` : undefined,
				mode & constants.W_OK ? `test -w ${path}` : undefined,
			].filter((check): check is string => check !== undefined);
			return sshExec(remote, checks.length > 0 ? checks.join(" && ") : `test -e ${path}`).then(() => {});
		},
		copyFileExclusive(sourcePath, targetPath) {
			return sshExec(
				remote,
				`set -o noclobber; cat -- ${shellQuote(toRemote(sourcePath))} > ${shellQuote(toRemote(targetPath))}`,
			).then(() => {});
		},
		async hashFile(p) {
			const output = await sshExec(remote, `sha256sum -- ${shellQuote(toRemote(p))}`);
			const digest = output.toString("utf8").trim().split(/\s+/, 1)[0];
			if (!digest || !/^[0-9a-f]{64}$/i.test(digest)) throw new Error(`Invalid remote sha256 for ${p}`);
			return digest.toLowerCase();
		},
		removeFile: (p) => sshExec(remote, `rm -- ${shellQuote(toRemote(p))}`).then(() => {}),
	};
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const cmd = `cd ${shellQuote(toRemote(cwd))} && ${command}`;
				const child = spawn("ssh", [remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	const localCwd = process.cwd();
	const localFileMutationIntents = new FileMutationIntentController();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd, { intentController: localFileMutationIntents });
	const localEdit = createEditTool(localCwd, { intentController: localFileMutationIntents });
	const localBash = createBashTool(localCwd);

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;
	let remoteFileTools: { write: ReturnType<typeof createWriteTool>; edit: ReturnType<typeof createEditTool> } | null =
		null;

	const getSsh = () => resolvedSsh;
	const getRemoteFileTools = (ssh: { remote: string; remoteCwd: string }) => {
		if (remoteFileTools) return remoteFileTools;
		const intentController = new FileMutationIntentController({
			operations: createRemoteIntentOps(ssh.remote, ssh.remoteCwd, localCwd),
		});
		remoteFileTools = {
			write: createWriteTool(localCwd, {
				operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
				intentController,
			}),
			edit: createEditTool(localCwd, {
				operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
				intentController,
			}),
		};
		return remoteFileTools;
	};

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createReadTool(localCwd, {
					operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				return getRemoteFileTools(ssh).write.execute(id, params, signal, onUpdate);
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				return getRemoteFileTools(ssh).edit.execute(id, params, signal, onUpdate);
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createBashTool(localCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		const arg = pi.getFlag("ssh") as string | undefined;
		if (arg) {
			remoteFileTools = null;
			if (arg.includes(":")) {
				const [remote, path] = arg.split(":");
				resolvedSsh = { remote, remoteCwd: path };
			} else {
				// No path given, evaluate pwd on remote
				const remote = arg;
				const pwd = (await sshExec(remote, "pwd")).toString().trim();
				resolvedSsh = { remote, remoteCwd: pwd };
			}
			ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
			ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
		}
	});

	// Handle user ! commands via SSH
	pi.on("user_bash", (_event) => {
		const ssh = getSsh();
		if (!ssh) return; // No SSH, use local execution
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
	});

	// Replace local cwd with remote cwd in system prompt
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		if (ssh) {
			const modified = event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
			return { systemPrompt: modified };
		}
	});
}
