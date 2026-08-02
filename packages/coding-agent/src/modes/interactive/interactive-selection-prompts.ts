import type { Component, TUI } from "@caupulican/pi-tui";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { SelectSubmenu } from "./components/settings-selector.ts";

export interface InteractiveSelectionHost {
	showSelector(
		create: (done: () => void) => {
			component: Component;
			focus: Component;
			onSuperseded?: () => void;
		},
	): void;
}

export interface TextInputSelectionHost extends InteractiveSelectionHost {
	readonly tui: TUI;
}

export interface ExternalResourceTrustPrompt {
	title: string;
	description: string;
	acceptDescription: string;
	rejectDescription: string;
}

type SelectionMount = {
	component: Component;
	focus: Component;
};

function showSettledSelection<T>(
	host: InteractiveSelectionHost,
	supersededValue: T,
	create: (settle: (value: T) => void) => SelectionMount,
): Promise<T> {
	return new Promise((resolve) => {
		host.showSelector((done) => {
			let settled = false;
			const settle = (value: T, close: boolean) => {
				if (settled) return;
				settled = true;
				if (close) done();
				resolve(value);
			};
			return {
				...create((value) => settle(value, true)),
				onSuperseded: () => settle(supersededValue, false),
			};
		});
	});
}

export function promptForTextInput(
	host: TextInputSelectionHost,
	title: string,
	placeholder: string,
): Promise<string | undefined> {
	return showSettledSelection<string | undefined>(host, undefined, (settle) => {
		const input = new ExtensionInputComponent(title, placeholder, settle, () => settle(undefined), { tui: host.tui });
		return {
			component: input,
			focus: input,
		};
	});
}

export function confirmExternalResourceTrust(
	host: InteractiveSelectionHost,
	prompt: ExternalResourceTrustPrompt,
): Promise<boolean> {
	return showSettledSelection<boolean>(host, false, (settle) => {
		const submenu = new SelectSubmenu(
			prompt.title,
			prompt.description,
			[
				{ value: "yes", label: "Yes", description: prompt.acceptDescription },
				{ value: "no", label: "No", description: prompt.rejectDescription },
			],
			"no",
			(value) => settle(value === "yes"),
			() => settle(false),
		);
		return {
			component: submenu,
			focus: submenu.getSelectList(),
		};
	});
}
