import { realpath } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import type { PiSelfLaunchTarget } from "../core/process-matrix/resume-launcher.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFile } from "../core/util/bounded-file.ts";
import { MAX_RUNTIME_ARTIFACT_ENTRIES, type RuntimeOrigin } from "./runtime-artifact-store.ts";

// Native installer ownership protocol; the installer marker is not an authentication boundary.
const managedMarker = ".pi-adaptative-managed";
const managedContent = "pi-adaptative-managed-release-v1";
const releaseVersion = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Resolve the installer's activation pointer for every capture, never for a retained generation. */
export async function createStandaloneRuntimeOrigin(
	packageDir: string,
	target: PiSelfLaunchTarget,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ origin: string; stableTarget: PiSelfLaunchTarget | undefined; capture: () => Promise<RuntimeOrigin> }> {
	const originalRoot = await realpath(packageDir);
	const releaseDirectory = dirname(originalRoot);
	const managed =
		basename(releaseDirectory) === "releases" &&
		(await readBoundedTextFile(join(originalRoot, managedMarker), 128, "Runtime ownership marker").then(
			(value) => value.trim() === managedContent,
			() => false,
		));
	const installRoot = dirname(releaseDirectory);
	const executable = basename(target.executable);
	let stableTarget: PiSelfLaunchTarget | undefined = target;
	if (managed) {
		stableTarget = undefined;
		if (platform !== "win32") stableTarget = { executable: join(installRoot, "current", executable), argsPrefix: [] };
		else {
			const candidates = [
				...new Set(
					[
						env.PI_BIN_DIR,
						join(installRoot, "bin"),
						...(env.PATH ?? "").split(platform === process.platform ? delimiter : ";"),
					].filter((path): path is string => !!path && isAbsolute(path)),
				),
			].slice(0, 64);
			for (const directory of candidates) {
				const launcher = join(directory, "pi.cmd");
				const contents = await readBoundedTextFile(launcher, 8192, "Managed runtime launcher").catch(
					() => undefined,
				);
				if (
					contents?.includes("REM PI_ADAPTATIVE_MANAGED_LAUNCHER") &&
					contents.split(/\r?\n/).includes(`set "PI_ADAPTATIVE_ROOT=${installRoot.replaceAll("%", "%%")}"`)
				) {
					stableTarget = { executable: launcher, argsPrefix: [] };
					break;
				}
			}
		}
	}
	return {
		origin: managed ? installRoot : originalRoot,
		stableTarget,
		capture: async () => {
			let root = originalRoot;
			if (managed) {
				if (platform === "win32") {
					const version = (
						await readBoundedTextFile(join(installRoot, "current.version"), 256, "Runtime version pointer")
					).trim();
					if (!releaseVersion.test(version)) throw new Error("Invalid activated runtime version.");
					root = await realpath(join(releaseDirectory, version));
				} else root = await realpath(join(installRoot, "current"));
				if (
					dirname(root) !== releaseDirectory ||
					!releaseVersion.test(basename(root)) ||
					(await readBoundedTextFile(join(root, managedMarker), 128, "Runtime ownership marker")).trim() !==
						managedContent
				)
					throw new Error("Activated runtime is not an owned installed release.");
			}
			return {
				root,
				entries: readBoundedDirectoryNamesSync(root, MAX_RUNTIME_ARTIFACT_ENTRIES, "Runtime root"),
				target: managed ? { executable: join(root, executable), argsPrefix: [...target.argsPrefix] } : target,
			};
		},
	};
}
