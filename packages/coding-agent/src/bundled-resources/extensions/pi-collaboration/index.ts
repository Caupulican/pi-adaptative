import { type ExtensionAPI, piCollaborationExtension } from "@caupulican/pi-adaptative";

export const piConfig = { tools: ["pi_collaboration"] };

export default function collaboration(pi: ExtensionAPI): void {
	piCollaborationExtension(pi);
}
