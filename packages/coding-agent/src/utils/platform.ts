import { release } from "node:os";

/** Detect WSL without reading project files or creating machine state. */
export function isWslEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	kernelRelease: string | undefined = undefined,
): boolean {
	const resolvedRelease = kernelRelease ?? release();
	return (
		platform === "linux" &&
		Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || env.WSLENV || /microsoft|wsl/i.test(resolvedRelease))
	);
}
