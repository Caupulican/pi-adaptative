/**
 * Exit commit is refused.
 * Shutdown has no objective-owned path list, so it must not stage the worktree.
 */

import type { ExtensionAPI } from "@caupulican/pi-adaptative";

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.notify("Exit commit refused: no objective-owned paths", "warning");
	});
}
