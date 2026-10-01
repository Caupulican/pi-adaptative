import { release } from "node:os";
import { getChatStatePaths } from "./state.ts";

export type ChatPlatformInfo = {
	platform: NodeJS.Platform;
	isWsl: boolean;
	localMeshSupported: boolean;
	socketPath?: string;
	note?: string;
};

export function getChatPlatformInfo(stateRoot: string): ChatPlatformInfo {
	const platform = process.platform;
	const lowered = release().toLowerCase();
	const isWsl = lowered.includes("microsoft") || lowered.includes("wsl");
	if (platform === "linux" || platform === "darwin") {
		return {
			platform,
			isWsl,
			localMeshSupported: true,
			socketPath: getChatStatePaths(stateRoot).socket,
			note: isWsl
				? "Running as Linux inside WSL; native Windows Pi instances cannot join this Unix socket."
				: undefined,
		};
	}
	return {
		platform,
		isWsl,
		localMeshSupported: false,
		note:
			platform === "win32"
				? "The local mesh needs a named-pipe transport on native Windows; it is not available yet."
				: `The local mesh is not implemented for ${platform}.`,
	};
}
