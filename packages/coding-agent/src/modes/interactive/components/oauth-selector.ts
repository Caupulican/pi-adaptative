import { Container, type Focusable, getKeybindings, type Input, Spacer, TruncatedText } from "@caupulican/pi-tui";
import type { AuthStatus, AuthStorage } from "../../../core/auth-storage.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import {
	advanceSelectorIndex,
	filterSelectorItems,
	getCenteredVisibleRange,
	getSelectorScrollText,
	SearchableListSurface,
} from "./selector-list.ts";

export type AuthSelectorProvider = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
};

/**
 * Component that renders an auth provider selector
 */
export class OAuthSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private searchSurface: SearchableListSurface;

	// Focusable implementation - propagate to search input for IME cursor positioning
	get focused(): boolean {
		return this.searchSurface.focused;
	}
	set focused(value: boolean) {
		this.searchSurface.focused = value;
	}

	private listContainer: Container;
	private allProviders: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex: number = 0;
	private mode: "login" | "logout";
	private authStorage: AuthStorage;
	private getAuthStatus: (providerId: string) => AuthStatus;
	private onSelectCallback: (providerId: string) => void;
	private onCancelCallback: () => void;

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		providers: AuthSelectorProvider[],
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		getAuthStatus?: (providerId: string) => AuthStatus,
	) {
		super();

		this.mode = mode;
		this.authStorage = authStorage;
		this.getAuthStatus = getAuthStatus ?? ((providerId) => this.authStorage.getAuthStatus(providerId));
		this.allProviders = providers;
		this.filteredProviders = providers;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		const title = mode === "login" ? "Select provider to configure:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));

		this.searchSurface = SearchableListSurface.mount(this);
		this.searchInput = this.searchSurface.searchInput;
		this.listContainer = this.searchSurface.listContainer;
		this.searchInput.onSubmit = () => {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id);
			}
		};

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Initial render
		this.filterProviders("");
	}

	private filterProviders(query: string): void {
		this.filteredProviders = filterSelectorItems(
			this.allProviders,
			query,
			(provider) => `${provider.name} ${provider.id} ${provider.authType}`,
		);
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredProviders.length - 1)));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 8;
		const range = getCenteredVisibleRange(this.selectedIndex, this.filteredProviders.length, maxVisible);
		const { startIndex, endIndex } = range;

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.filteredProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;

			const statusIndicator = this.formatStatusIndicator(provider);
			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const text = theme.fg("accent", provider.name);
				line = prefix + text + statusIndicator;
			} else {
				const text = `  ${theme.fg("text", provider.name)}`;
				line = text + statusIndicator;
			}

			this.listContainer.addChild(new TruncatedText(line, 1, 0));
		}

		const scrollText = getSelectorScrollText(this.selectedIndex, this.filteredProviders.length, range);
		if (scrollText) this.listContainer.addChild(new TruncatedText(theme.fg("muted", scrollText), 1, 0));

		// Show "no providers" if empty
		if (this.filteredProviders.length === 0) {
			const message =
				this.allProviders.length === 0
					? this.mode === "login"
						? "No providers available"
						: "No providers logged in. Use /login first."
					: "No matching providers";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 1, 0));
		}
	}

	private formatStatusIndicator(provider: AuthSelectorProvider): string {
		const credential = this.authStorage.get(provider.id);
		if (credential?.type === provider.authType) return theme.fg("success", " ✓ configured");
		if (credential) {
			const label = credential.type === "oauth" ? "subscription configured" : "API key configured";
			return theme.fg("muted", " • ") + theme.fg("warning", label);
		}
		if (provider.authType !== "api_key") return theme.fg("muted", " • unconfigured");

		const status = this.getAuthStatus(provider.id);
		switch (status.source) {
			case "environment":
				return theme.fg("success", ` ✓ env: ${status.label ?? "API key"}`);
			case "runtime":
				return theme.fg("success", " ✓ runtime API key");
			case "fallback":
				return theme.fg("success", " ✓ custom API key");
			case "models_json_key":
				return theme.fg("success", " ✓ key in models.json");
			case "models_json_command":
				return theme.fg("success", " ✓ command in models.json");
			default:
				return theme.fg("muted", " • unconfigured");
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = advanceSelectorIndex(this.selectedIndex, this.filteredProviders.length, -1, "clamp");
			this.updateList();
		}
		// Down arrow
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = advanceSelectorIndex(this.selectedIndex, this.filteredProviders.length, 1, "clamp");
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterProviders(this.searchInput.getValue());
		}
	}
}
