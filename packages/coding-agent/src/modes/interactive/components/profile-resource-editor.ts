import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
} from "@caupulican/pi-tui";
import { decodeResourceSelection, encodeResourceSelection } from "../../../core/profile-resource-selection.ts";
import type { ResourceProfileKind, ResourceProfileSettings } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyText } from "./keybinding-hints.ts";

export interface ProfileResourceEditorKind {
	kind: ResourceProfileKind; // "tools" | "skills" | "extensions" | "agents" | "prompts" | "themes"
	label: string; // display label, e.g. "Tools"
	allIds: string[]; // the full universe of selectable ids for this kind
}

export interface ProfileResourceEditorOptions {
	profileName: string;
	initialResources: ResourceProfileSettings; // existing profile.resources; may be {}
	kinds: ProfileResourceEditorKind[]; // the six kinds, with their universes
	onSave: (resources: ResourceProfileSettings) => void; // called on ctrl+s with the encoded result
	onCancel: () => void; // called on esc
}

interface ResourceItem {
	id: string;
	enabled: boolean;
}

/**
 * TUI component for editing per-kind resource toggles in a profile.
 * Shows a selectable list of resources for each kind (tools, skills, etc.),
 * with space-to-toggle, search filtering, and save/cancel callbacks.
 */
export class ProfileResourceEditorComponent extends Container implements Focusable {
	private profileName: string;
	private kinds: ProfileResourceEditorKind[];
	private enabledByKind: Map<ResourceProfileKind, Set<string>> = new Map();
	private currentKindIndex = 0;

	private filteredItems: ResourceItem[] = [];
	private selectedIndex = 0;
	private searchInput: Input;
	private kindHeaderText: Text;
	private listContainer: Container;
	private footerText: Text;
	private isDirty = false;
	private maxVisible = 8;

	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private onSave: (resources: ResourceProfileSettings) => void;
	private onCancel: () => void;

	constructor(options: ProfileResourceEditorOptions) {
		super();
		this.profileName = options.profileName;
		this.kinds = options.kinds;
		this.onSave = options.onSave;
		this.onCancel = options.onCancel;

		// Initialize enabled sets for each kind via decoding
		for (const kind of this.kinds) {
			const filter = options.initialResources[kind.kind];
			const enabledSet = decodeResourceSelection(filter, kind.allIds);
			this.enabledByKind.set(kind.kind, enabledSet);
		}

		// Header
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold(`Edit Resources: ${this.profileName}`)), 0, 0));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Navigate kinds with ${keyText("tui.input.tab")}. Toggle with ${keyText("tui.select.confirm")}.`,
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		// Kind selector header (shows current kind label and count)
		this.kindHeaderText = new Text(this.getKindHeaderText(), 0, 0);
		this.addChild(this.kindHeaderText);
		this.addChild(new Spacer(1));

		// Search input
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// List container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		// Footer hint
		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);

		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private getKindHeaderText(): string {
		const kind = this.kinds[this.currentKindIndex]!;
		const enabledSet = this.enabledByKind.get(kind.kind)!;
		const countText = `${enabledSet.size}/${kind.allIds.length} enabled`;
		const kindIndicator = this.kinds
			.map((k, i) => {
				const marker = i === this.currentKindIndex ? "●" : "○";
				return theme.fg(i === this.currentKindIndex ? "accent" : "muted", `${marker} ${k.label}`);
			})
			.join(" ");
		return `${kindIndicator}  ${theme.fg("muted", countText)}`;
	}

	private getCurrentKind(): ProfileResourceEditorKind {
		return this.kinds[this.currentKindIndex]!;
	}

	private getCurrentEnabledSet(): Set<string> {
		const kind = this.getCurrentKind();
		return this.enabledByKind.get(kind.kind)!;
	}

	private buildItems(): ResourceItem[] {
		const kind = this.getCurrentKind();
		const enabledSet = this.getCurrentEnabledSet();
		// Return items sorted: enabled first (in order), then disabled
		const enabled: ResourceItem[] = [];
		const disabled: ResourceItem[] = [];
		for (const id of kind.allIds) {
			if (enabledSet.has(id)) {
				enabled.push({ id, enabled: true });
			} else {
				disabled.push({ id, enabled: false });
			}
		}
		return [...enabled, ...disabled];
	}

	private getFooterText(): string {
		const kind = this.getCurrentKind();
		const enabledSet = this.getCurrentEnabledSet();
		const countText = `${enabledSet.size}/${kind.allIds.length} enabled`;
		const parts = [
			`${keyText("tui.select.confirm")} toggle`,
			`${keyText("tui.input.tab")} kind`,
			`${keyText("app.models.save")} save`,
			countText,
		];
		return this.isDirty
			? theme.fg("dim", `  ${parts.join(" · ")} `) + theme.fg("warning", "(unsaved)")
			: theme.fg("dim", `  ${parts.join(" · ")}`);
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		const items = this.buildItems();
		this.filteredItems = query ? fuzzyFilter(items, query, (i) => i.id) : items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching resources"), 0, 0));
			return;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const resourceText = isSelected ? theme.fg("accent", item.id) : item.id;
			const status = item.enabled ? theme.fg("success", " ✓") : theme.fg("dim", " ✗");
			this.listContainer.addChild(new Text(`${prefix}${resourceText}${status}`, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
			);
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Navigation within list
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}

		// Switch kind with Tab (cycles forward)
		if (kb.matches(data, "tui.input.tab")) {
			this.currentKindIndex = (this.currentKindIndex + 1) % this.kinds.length;
			this.selectedIndex = 0;
			this.searchInput.setValue("");
			this.kindHeaderText.setText(this.getKindHeaderText());
			this.refresh();
			return;
		}

		// Toggle on space/enter
		if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				const enabledSet = this.getCurrentEnabledSet();
				if (enabledSet.has(item.id)) {
					enabledSet.delete(item.id);
				} else {
					enabledSet.add(item.id);
				}
				this.isDirty = true;
				this.refresh();
			}
			return;
		}

		// Save/persist to settings
		if (kb.matches(data, "app.models.save")) {
			this.persistChanges();
			return;
		}

		// Ctrl+C - clear search or cancel if empty
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.onCancel();
			}
			return;
		}

		// Escape - cancel
		if (matchesKey(data, Key.escape)) {
			this.onCancel();
			return;
		}

		// Pass everything else to search input
		this.searchInput.handleInput(data);
		this.refresh();
	}

	private persistChanges(): void {
		// Encode each kind and build the result
		const resources: ResourceProfileSettings = {};
		for (const kind of this.kinds) {
			const enabledSet = this.enabledByKind.get(kind.kind)!;
			const encoded = encodeResourceSelection(enabledSet, kind.allIds);
			if (encoded !== undefined) {
				resources[kind.kind] = encoded;
			}
		}
		this.onSave(resources);
		this.isDirty = false;
		this.footerText.setText(this.getFooterText());
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
