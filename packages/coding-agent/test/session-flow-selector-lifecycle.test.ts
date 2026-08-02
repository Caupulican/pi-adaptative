import { type Component, setKeybindings } from "@caupulican/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import {
	type SessionFlowHost,
	showModelSelector,
	showUserMessageSelector,
} from "../src/modes/interactive/session-flow-commands.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type MountedSelector = { component: Component; focus: Component };

function createHost(
	events: string[],
	fork: () => Promise<{ cancelled: boolean; selectedText?: string }> = async () => ({ cancelled: false }),
): { host: SessionFlowHost; getMounted: () => MountedSelector } {
	let mounted: MountedSelector | undefined;
	const host = {
		session: {
			extensionRunner: { emit: async () => {} },
			model: undefined,
			scopedModels: [],
			modelRegistry: {
				refresh: () => {},
				getError: () => undefined,
				getAvailable: async () => [],
				find: () => undefined,
			},
			getUserMessagesForForking: () => [{ entryId: "entry-1", text: "Keep this message" }],
			setSessionName: () => events.push("name"),
		},
		settingsManager: {},
		runtimeHost: { fork },
		ui: { requestRender: () => events.push("render") },
		editor: { setText: () => events.push("editor") },
		footer: { invalidate: () => events.push("footer") },
		showSelector: (create: (done: () => void) => MountedSelector) => {
			mounted = create(() => events.push("done"));
		},
		showStatus: (message: string) => events.push(`status:${message}`),
		showError: (message: string) => events.push(`error:${message}`),
		renderCurrentSessionState: () => events.push("session"),
		updateEditorBorderColor: () => events.push("border"),
		maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
		checkDaxnutsEasterEgg: () => {},
	} as unknown as SessionFlowHost;

	return {
		host,
		getMounted: () => {
			if (!mounted) throw new Error("selector was not mounted");
			return mounted;
		},
	};
}

async function flushCallbacks(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("session-flow selector lifecycle", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("closes the model selector before rendering and preserves its focus target", async () => {
		const events: string[] = [];
		const { host, getMounted } = createHost(events);

		await showModelSelector(host);
		await flushCallbacks();
		events.length = 0;

		const mounted = getMounted();
		expect(mounted.component).toBeInstanceOf(ModelSelectorComponent);
		expect(mounted.focus).toBe(mounted.component);
		(mounted.component as ModelSelectorComponent).handleInput("\x1b");

		expect(events).toEqual(["done", "render"]);
	});

	it("keeps fork focus on the message list and treats a cancelled fork as selector cancellation", async () => {
		const events: string[] = [];
		const { host, getMounted } = createHost(events, async () => ({ cancelled: true }));

		showUserMessageSelector(host, "copy");
		const mounted = getMounted();
		expect(mounted.component).toBeInstanceOf(UserMessageSelectorComponent);
		const selector = mounted.component as UserMessageSelectorComponent;
		expect(mounted.focus).toBe(selector.getMessageList());

		selector.getMessageList().handleInput("\r");
		await flushCallbacks();

		expect(events).toEqual(["done", "render"]);
	});

	it("closes a failed fork before reporting the error without rendering a success state", async () => {
		const events: string[] = [];
		const { host, getMounted } = createHost(events, async () => {
			throw new Error("fork failed");
		});

		showUserMessageSelector(host);
		const selector = getMounted().component as UserMessageSelectorComponent;
		selector.getMessageList().handleInput("\r");
		await flushCallbacks();

		expect(events).toEqual(["done", "error:fork failed"]);
	});
});
