import type { Api, Model } from "@caupulican/pi-ai";
import {
	Container,
	type Focusable,
	getKeybindings,
	type Input,
	Key,
	matchesKey,
	Spacer,
	Text,
} from "@caupulican/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyText } from "./keybinding-hints.ts";
import {
	clearSelectorSearchOrCancel,
	formatDirtySelectorFooter,
	SearchableListSurface,
	SelectorListState,
	SelectorStatusFooter,
} from "./selector-list.ts";

// EnabledIds: null = all enabled (no filter), string[] = explicit ordered list
type EnabledIds = string[] | null;

function isEnabled(enabledIds: EnabledIds, id: string): boolean {
	return enabledIds === null || enabledIds.includes(id);
}

function toggle(enabledIds: EnabledIds, id: string): EnabledIds {
	if (enabledIds === null) return [id]; // First toggle: start with only this one
	const index = enabledIds.indexOf(id);
	if (index >= 0) return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
	return [...enabledIds, id];
}

function enableAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) return null; // Already all enabled
	const targets = targetIds ?? allIds;
	const result = [...enabledIds];
	for (const id of targets) {
		if (!result.includes(id)) result.push(id);
	}
	return result.length === allIds.length && result.every((id) => allIds.includes(id)) ? null : result;
}

function clearAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) {
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	const targets = new Set(targetIds ?? enabledIds);
	return enabledIds.filter((id) => !targets.has(id));
}

function move(enabledIds: EnabledIds, id: string, delta: number): EnabledIds {
	if (enabledIds === null) return null;
	const list = [...enabledIds];
	const index = list.indexOf(id);
	if (index < 0) return list;
	const newIndex = index + delta;
	if (newIndex < 0 || newIndex >= list.length) return list;
	const result = [...list];
	[result[index], result[newIndex]] = [result[newIndex], result[index]];
	return result;
}

function getSortedIds(enabledIds: EnabledIds, allIds: string[]): string[] {
	if (enabledIds === null) return allIds;
	const enabledSet = new Set(enabledIds);
	return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
}

interface ModelItem {
	fullId: string;
	model: Model<Api> | undefined;
	enabled: boolean;
}

export interface ModelsConfig {
	allModels: Model<Api>[];
	enabledModelIds: string[] | null;
}

export interface ModelsCallbacks {
	/** Called whenever the enabled model set or order changes (session-only, no persist) */
	onChange: (enabledModelIds: string[] | null) => void | Promise<void>;
	/** Called when user wants to persist current selection to settings */
	onPersist: (enabledModelIds: string[] | null) => void | Promise<void>;
	onCancel: () => void;
}

/**
 * Component for enabling/disabling models for Ctrl+P cycling.
 * Changes are session-only until explicitly persisted with Ctrl+S.
 */
export class ScopedModelsSelectorComponent extends Container implements Focusable {
	private modelsById: Map<string, Model<Api>> = new Map();
	private allIds: string[] = [];
	private enabledIds: EnabledIds = null;
	private readonly listState = new SelectorListState<ModelItem>(() => this.updateList());
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
	private footerText: Text;
	private callbacks: ModelsCallbacks;
	private maxVisible = 8;
	private isDirty = false;

	constructor(config: ModelsConfig, callbacks: ModelsCallbacks) {
		super();
		this.callbacks = callbacks;

		for (const model of config.allModels) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}

		this.enabledIds = config.enabledModelIds === null ? null : [...config.enabledModelIds];
		this.listState.items = this.buildItems();

		// Header
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Model Configuration")), 0, 0));
		this.addChild(
			new Text(theme.fg("muted", `Session-only. ${keyText("app.models.save")} to save to settings.`), 0, 0),
		);
		this.addChild(new Spacer(1));

		this.searchSurface = SearchableListSurface.mount(this);
		this.searchInput = this.searchSurface.searchInput;
		this.listContainer = this.searchSurface.listContainer;

		const statusFooter = new SelectorStatusFooter(this.getFooterText());
		this.footerText = statusFooter.footerText;
		this.addChild(statusFooter);
		this.updateList();
	}

	private buildItems(): ModelItem[] {
		return getSortedIds(this.enabledIds, this.allIds).map((id) => ({
			fullId: id,
			model: this.modelsById.get(id),
			enabled: isEnabled(this.enabledIds, id),
		}));
	}

	private getFooterText(): string {
		const enabledCount = this.enabledIds?.filter((id) => this.modelsById.has(id)).length ?? this.allIds.length;
		const unavailableCount = this.enabledIds?.filter((id) => !this.modelsById.has(id)).length ?? 0;
		const allEnabled = this.enabledIds === null;
		const countText = allEnabled
			? "all enabled"
			: `${enabledCount}/${this.allIds.length} enabled${unavailableCount ? ` · ${unavailableCount} unavailable` : ""}`;
		const parts = [
			`${keyText("tui.select.confirm")} toggle`,
			`${keyText("app.models.enableAll")} all`,
			`${keyText("app.models.clearAll")} clear`,
			`${keyText("app.models.toggleProvider")} provider`,
			`${keyText("app.models.reorderUp")}/${keyText("app.models.reorderDown")} reorder`,
			`${keyText("app.models.save")} save`,
			countText,
		];
		return formatDirtySelectorFooter(parts, this.isDirty);
	}

	private refresh(): void {
		this.listState.refresh(this.buildItems(), this.searchInput.getValue(), (item) =>
			item.model ? `${item.model.id} ${item.model.provider} ${item.model.name}` : item.fullId,
		);
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private notifyChange(): void {
		this.callbacks.onChange(this.enabledIds === null ? null : [...this.enabledIds]);
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.listState.items.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			return;
		}

		const allEnabled = this.enabledIds === null;

		const range = this.listState.visitVisible(this.maxVisible, (item, _index, isSelected) => {
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const id = item.model?.id ?? item.fullId;
			const modelText = isSelected ? theme.fg("accent", id) : id;
			const providerBadge = theme.fg("muted", item.model ? ` [${item.model.provider}]` : " [unavailable]");
			const status = item.model
				? allEnabled
					? ""
					: item.enabled
						? theme.fg("success", " ✓")
						: theme.fg("dim", " ✗")
				: theme.fg("dim", " ✗");
			this.listContainer.addChild(new Text(`${prefix}${modelText}${providerBadge}${status}`, 0, 0));
		});

		this.listState.appendScrollInfo(this.listContainer, range);

		if (this.listState.items.length > 0) {
			const selected = this.listState.items[this.listState.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(
					theme.fg("muted", `  ${selected.model ? `Model Name: ${selected.model.name}` : "Model unavailable"}`),
					0,
					0,
				),
			);
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.listState.handleNavigation(data, "wrap", kb)) return;

		// Reorder enabled models
		const reorderUp = kb.matches(data, "app.models.reorderUp");
		const reorderDown = kb.matches(data, "app.models.reorderDown");
		if (reorderUp || reorderDown) {
			if (this.enabledIds === null) return;
			const item = this.listState.items[this.listState.selectedIndex];
			if (item && isEnabled(this.enabledIds, item.fullId)) {
				const delta = reorderUp ? -1 : 1;
				const currentIndex = this.enabledIds.indexOf(item.fullId);
				const newIndex = currentIndex + delta;
				// Only move if within bounds
				if (newIndex >= 0 && newIndex < this.enabledIds.length) {
					this.enabledIds = move(this.enabledIds, item.fullId, delta);
					this.isDirty = true;
					this.listState.selectedIndex += delta;
					this.refresh();
					this.notifyChange();
				}
			}
			return;
		}

		// Toggle on Enter
		if (kb.matches(data, "tui.select.confirm")) {
			const item = this.listState.items[this.listState.selectedIndex];
			if (item) {
				this.enabledIds = toggle(this.enabledIds, item.fullId);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		// Enable all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.enableAll")) {
			const targetIds = this.searchInput.getValue() ? this.listState.items.map((item) => item.fullId) : undefined;
			this.enabledIds = enableAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		// Clear all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.clearAll")) {
			const targetIds = this.searchInput.getValue() ? this.listState.items.map((item) => item.fullId) : undefined;
			this.enabledIds = clearAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		// Toggle provider of current item
		if (kb.matches(data, "app.models.toggleProvider")) {
			const item = this.listState.items[this.listState.selectedIndex];
			if (item?.model) {
				const provider = item.model.provider;
				const providerIds = this.allIds.filter((id) => this.modelsById.get(id)?.provider === provider);
				const allEnabled = providerIds.every((id) => isEnabled(this.enabledIds, id));
				this.enabledIds = allEnabled
					? clearAll(this.enabledIds, this.allIds, providerIds)
					: enableAll(this.enabledIds, this.allIds, providerIds);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		// Save/persist to settings
		if (kb.matches(data, "app.models.save")) {
			this.callbacks.onPersist(this.enabledIds === null ? null : [...this.enabledIds]);
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
			return;
		}

		// Ctrl+C - clear search or cancel if empty
		if (matchesKey(data, Key.ctrl("c"))) {
			clearSelectorSearchOrCancel(this.searchInput, () => this.refresh(), this.callbacks.onCancel);
			return;
		}

		// Escape - cancel
		if (matchesKey(data, Key.escape)) {
			this.callbacks.onCancel();
			return;
		}

		// Pass everything else to search input
		this.searchInput.handleInput(data);
		this.refresh();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
