import { type Model, modelsAreEqual } from "@caupulican/pi-ai";
import type { Api } from "@caupulican/pi-ai/types";
import {
	Container,
	type Focusable,
	getKeybindings,
	type Input,
	Spacer,
	Text,
	type TUI,
	visibleWidth,
} from "@caupulican/pi-tui";
import type { AuthStatus } from "../../../core/auth-storage.ts";
import { ANTIGRAVITY_EFFORT_ORDER, antigravityGeminiEffortFamily } from "../../../core/models/antigravity-effort.ts";
import type { ModelFavorite } from "../../../core/settings/settings-schema.ts";
import { formatSelectorActionHints, keyHint, keyText } from "../../../presentation/keybinding-hints.ts";
import { theme } from "../../../presentation/theme-model.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import {
	advanceSelectorIndex,
	filterSelectorItems,
	getCenteredVisibleRange,
	getSelectorScrollText,
	SearchableListSurface,
} from "./selector-list.ts";

/** The model registry members this module uses, declared by the module itself; the composition root passes the ModelRegistry. */
export interface ModelSelectorModelSource {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAvailable(): Model<Api>[];
	getError(): string | undefined;
	refresh(): void;
	isUsingSubscription(model: Model<Api>): boolean;
	isUsingOAuth(model: Model<Api>): boolean;
	getProviderAuthStatus(provider: string): AuthStatus;
	getProviderDisplayName(provider: string): string;
}

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface ModelSelectorSettingsSource {
	getModelFavorites(): ModelFavorite[];
	toggleModelFavorite(provider: string, modelId: string): void;
}

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
	displayName?: string;
	variants?: Model<any>[];
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

type ModelScope = "all" | "favorites" | "subscriptions" | "api" | "scoped";

/** How a provider's models are paid for: a logged-in subscription or OAuth account, an API credential, or a model that runs locally. */
type AuthCategory = "subscription" | "api" | "local";

/** Providers that run on this machine whatever credential state they report. */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["llama-cpp", "ollama", "transformers", "needle"]);

const AUTH_CATEGORY_ORDER: Record<AuthCategory, number> = { subscription: 0, api: 1, local: 2 };

/** The Tab order of scopes; "scoped" joins it only when the session has scoped models. */
const SCOPE_ORDER: readonly ModelScope[] = ["all", "favorites", "subscriptions", "api", "scoped"];

interface ProviderAuthInfo {
	category: AuthCategory;
	/** Short label for the credential behind the provider, shown on its group header and searchable. */
	badge: string;
	label: string;
}

/** One provider's models under a header that expands and retracts. */
interface ModelGroup {
	key: string;
	label: string;
	category: AuthCategory;
	badge: string;
	items: ModelItem[];
}

type SelectorRow =
	| { kind: "group"; group: ModelGroup; expanded: boolean }
	| { kind: "model"; item: ModelItem; group: ModelGroup };

function apiBadge(status: AuthStatus): string {
	switch (status.source) {
		case "environment":
			return "API · env";
		case "stored":
			return "API · key";
		case "models_json_key":
		case "models_json_command":
			return "API · models.json";
		default:
			return "API";
	}
}

function groupAntigravityModels(items: ModelItem[], currentModel?: Model<any>): ModelItem[] {
	const grouped = new Map<string, ModelItem[]>();
	const result: ModelItem[] = [];
	for (const item of items) {
		const family = antigravityGeminiEffortFamily(item.model);
		if (!family) {
			result.push(item);
			continue;
		}
		const key = `${item.provider}\u0000${family}`;
		const variants = grouped.get(key) ?? [];
		variants.push(item);
		grouped.set(key, variants);
	}
	for (const [key, members] of grouped) {
		if (
			members.length < 2 ||
			new Set(members.map((item) => item.model.defaultThinkingLevel)).size !== members.length
		) {
			result.push(...members);
			continue;
		}
		const variants = members
			.map((item) => item.model)
			.sort(
				(a, b) =>
					ANTIGRAVITY_EFFORT_ORDER.indexOf(a.defaultThinkingLevel as (typeof ANTIGRAVITY_EFFORT_ORDER)[number]) -
					ANTIGRAVITY_EFFORT_ORDER.indexOf(b.defaultThinkingLevel as (typeof ANTIGRAVITY_EFFORT_ORDER)[number]),
			);
		const selected =
			variants.find((model) => modelsAreEqual(currentModel, model)) ??
			variants.find((model) => model.defaultThinkingLevel === "medium") ??
			variants.find((model) => model.defaultThinkingLevel === "high") ??
			variants[0]!;
		const [, displayName] = key.split("\u0000");
		result.push({ provider: members[0]!.provider, id: displayName!, model: selected, displayName, variants });
	}
	return result;
}

/**
 * Component that renders a model selector with search. Models sit under one header per provider (a subscription or
 * OAuth account, an API credential, or a local runtime); one header is expanded at a time, and a search or the
 * favorites view opens every header so the matches are visible.
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private searchSurface: SearchableListSurface;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	get focused(): boolean {
		return this.searchSurface.focused;
	}
	set focused(value: boolean) {
		this.searchSurface.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private rows: SelectorRow[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private modelRegistry: ModelSelectorModelSource;
	private settingsManager: ModelSelectorSettingsSource;
	private favoriteKeys = new Set<string>();
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private providerAuth = new Map<string, ProviderAuthInfo>();
	/** The one header kept open while browsing; null when the operator retracted it. */
	private expandedGroupKey: string | null = null;
	/** Set by the expand-all key: every header stays open until it is pressed again. */
	private allGroupsExpanded = false;
	private lastQuery = "";

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		settingsManager: ModelSelectorSettingsSource,
		modelRegistry: ModelSelectorModelSource,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>) => void,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRegistry = modelRegistry;
		this.refreshFavoriteKeys();
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		if (scopedModels.length === 0) {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.scopeText = new Text(this.getScopeText(), 0, 0);
		this.addChild(this.scopeText);
		this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
		this.addChild(this.scopeHintText);
		this.addChild(new Spacer(1));

		this.searchSurface = SearchableListSurface.mount(this, initialSearchInput);
		this.searchInput = this.searchSurface.searchInput;
		this.listContainer = this.searchSurface.listContainer;
		this.searchInput.onSubmit = () => this.confirmSelected();

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${formatSelectorActionHints(Boolean(onSelectAsDefault))}  ${keyHint("app.models.toggleFavorite", "pin/unpin")}  ${keyHint("app.models.toggleProvider", "expand all")}`,
				1,
			),
		);

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.loadModels().then(() => {
			if (initialSearchInput) {
				this.filterModels(initialSearchInput);
			} else {
				this.rebuildRows();
				this.updateList();
			}
			// Request re-render after models are loaded
			this.tui.requestRender();
		});
	}

	private async loadModels(): Promise<void> {
		let models: ModelItem[];

		// Refresh to pick up any changes to models.json
		this.modelRegistry.refresh();
		this.providerAuth.clear();

		// Check for models.json errors
		const loadError = this.modelRegistry.getError();
		if (loadError) {
			this.errorMessage = loadError;
		}

		// Load available models (built-in models still work even if models.json failed)
		try {
			const availableModels = await this.modelRegistry.getAvailable();
			models = availableModels.map((model: Model<any>) => ({
				provider: model.provider,
				id: model.id,
				model,
				...(model.provider === "google-antigravity" ? { displayName: model.name } : {}),
			}));
		} catch (error) {
			this.allModels = [];
			this.scopedModelItems = [];
			this.activeModels = [];
			this.filteredModels = [];
			this.rows = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
			return;
		}

		this.allModels = this.sortModels(groupAntigravityModels(models, this.currentModel));
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRegistry.find(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = groupAntigravityModels(
			this.scopedModels.map((scoped) => ({
				provider: scoped.model.provider,
				id: scoped.model.id,
				model: scoped.model,
				...(scoped.model.provider === "google-antigravity" ? { displayName: scoped.model.name } : {}),
			})),
			this.currentModel,
		);
		this.activeModels = this.getActiveModels();
		this.filteredModels = this.activeModels;
		// Only the provider holding the current model starts open; the others start retracted.
		this.expandedGroupKey = this.currentModel?.provider ?? this.filteredModels[0]?.provider ?? null;
		this.rebuildRows({ modelKey: this.currentModelKey() });
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort: favorites first, then current model, provider, and id.
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			const aIsFavorite = this.isFavorite(a);
			const bIsFavorite = this.isFavorite(b);
			if (aIsFavorite !== bIsFavorite) return aIsFavorite ? -1 : 1;
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
		});
		return sorted;
	}

	private refreshFavoriteKeys(): void {
		this.favoriteKeys = new Set(
			this.settingsManager.getModelFavorites().map((favorite) => `${favorite.provider}\u0000${favorite.modelId}`),
		);
	}

	private modelKey(item: ModelItem): string {
		return `${item.provider}\u0000${item.id}`;
	}

	private currentModelKey(): string | undefined {
		const current = this.filteredModels.find((item) => this.isCurrent(item));
		return current ? this.modelKey(current) : undefined;
	}

	private isCurrent(item: ModelItem): boolean {
		return (item.variants ?? [item.model]).some((model) => modelsAreEqual(this.currentModel, model));
	}

	private isFavorite(item: ModelItem): boolean {
		return (item.variants ?? [item.model]).some((model) =>
			this.favoriteKeys.has(`${item.provider}\u0000${model.id}`),
		);
	}

	/** The credential behind a provider's models; auth is per provider, so it is read once per provider. */
	private authInfo(item: ModelItem): ProviderAuthInfo {
		const cached = this.providerAuth.get(item.provider);
		if (cached) return cached;
		const label = this.modelRegistry.getProviderDisplayName(item.provider);
		const status = this.modelRegistry.getProviderAuthStatus(item.provider);
		let info: ProviderAuthInfo;
		if (this.modelRegistry.isUsingSubscription(item.model)) info = { category: "subscription", badge: "Sub", label };
		else if (this.modelRegistry.isUsingOAuth(item.model)) info = { category: "subscription", badge: "OAuth", label };
		else if (
			LOCAL_PROVIDERS.has(item.provider) ||
			(status.source === "runtime" && status.label === "no API key required")
		)
			info = { category: "local", badge: "Local", label };
		else info = { category: "api", badge: apiBadge(status), label };
		this.providerAuth.set(item.provider, info);
		return info;
	}

	private getActiveModels(): ModelItem[] {
		if (this.scope === "scoped") return this.scopedModelItems;
		if (this.scope === "subscriptions")
			return this.allModels.filter((item) => this.authInfo(item).category === "subscription");
		if (this.scope === "api") return this.allModels.filter((item) => this.authInfo(item).category !== "subscription");
		if (this.scope === "favorites")
			return this.allModels.flatMap((item) => {
				const pinned = (item.variants ?? [item.model]).filter((model) =>
					this.favoriteKeys.has(`${item.provider}\u0000${model.id}`),
				);
				if (pinned.length === 0) return [];
				if (!item.variants) return [item];
				const selected = pinned.find((model) => model.id === item.model.id) ?? pinned[0]!;
				return [{ ...item, model: selected, variants: pinned }];
			});
		return this.allModels;
	}

	private availableScopes(): ModelScope[] {
		return SCOPE_ORDER.filter(
			(scope) => scope !== "scoped" || this.scopedModelItems.length > 0 || this.scopedModels.length > 0,
		);
	}

	private getScopeText(): string {
		const parts = this.availableScopes().map((scope) => theme.fg(this.scope === scope ? "accent" : "muted", scope));
		return `${theme.fg("muted", "Models: ")}${parts.join(theme.fg("muted", " | "))}`;
	}

	private getScopeHintText(): string {
		return (
			keyHint("app.models.toggleFavoritesTab", "tabs") + theme.fg("muted", ` (${this.availableScopes().join("/")})`)
		);
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		const previousRow = this.rows[this.selectedIndex];
		const previousKey = previousRow?.kind === "model" ? this.modelKey(previousRow.item) : undefined;
		this.scope = scope;
		this.activeModels = this.getActiveModels();
		this.filterModels(this.searchInput.getValue(), previousKey);
		// A scope whose view does not hold the open header opens its first one, so the list never lands on only closed headers.
		if (
			this.expandedGroupKey !== null &&
			!this.groupsOf(this.filteredModels).some((group) => group.key === this.expandedGroupKey)
		) {
			this.expandedGroupKey = this.groupsOf(this.filteredModels)[0]?.key ?? null;
			this.rebuildRows({ modelKey: previousKey });
			this.updateList();
		}
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private searchText(item: ModelItem): string {
		const { id, provider, displayName, variants } = item;
		const auth = this.authInfo(item);
		const accountWords = auth.category === "subscription" ? "subscription sub oauth account" : auth.category;
		return `${id} ${provider} ${provider}/${id} ${displayName ?? ""} ${variants?.map((model) => model.id).join(" ") ?? ""} ${auth.label} ${auth.badge} ${accountWords}`;
	}

	private filterModels(query: string, preferredKey?: string): void {
		const matches = filterSelectorItems(this.activeModels, query, (item) => this.searchText(item));
		this.filteredModels = [
			...matches.filter((item) => this.isFavorite(item)),
			...matches.filter((item) => !this.isFavorite(item)),
		];
		// Typing a new query lands on its first match instead of keeping a row index that now points elsewhere.
		const queryChanged = query !== this.lastQuery;
		this.lastQuery = query;
		this.rebuildRows(preferredKey ? { modelKey: preferredKey } : { firstModel: queryChanged && query !== "" });
		this.updateList();
	}

	/** The providers of these models as headers: subscriptions first, then API, then local; the open and favorite ones lead their category. */
	private groupsOf(items: ModelItem[]): ModelGroup[] {
		const groups = new Map<string, ModelGroup>();
		for (const item of items) {
			let group = groups.get(item.provider);
			if (!group) {
				const auth = this.authInfo(item);
				group = { key: item.provider, label: auth.label, category: auth.category, badge: auth.badge, items: [] };
				groups.set(item.provider, group);
			}
			group.items.push(item);
		}
		const rank = (group: ModelGroup): number =>
			(group.items.some((item) => this.isCurrent(item)) ? 0 : 2) +
			(group.items.some((item) => this.isFavorite(item)) ? 0 : 1);
		return [...groups.values()].sort(
			(a, b) =>
				AUTH_CATEGORY_ORDER[a.category] - AUTH_CATEGORY_ORDER[b.category] ||
				rank(a) - rank(b) ||
				a.label.localeCompare(b.label),
		);
	}

	/** Every header is open while a search is active, in the favorites and scoped views, or after the expand-all key. */
	private allOpen(): boolean {
		return (
			this.allGroupsExpanded ||
			this.searchInput.getValue() !== "" ||
			this.scope === "favorites" ||
			this.scope === "scoped"
		);
	}

	private rebuildRows(target?: { modelKey?: string; groupKey?: string; firstModel?: boolean }): void {
		const open = this.allOpen();
		const rows: SelectorRow[] = [];
		for (const group of this.groupsOf(this.filteredModels)) {
			const expanded = open || group.key === this.expandedGroupKey;
			rows.push({ kind: "group", group, expanded });
			if (expanded) for (const item of group.items) rows.push({ kind: "model", item, group });
		}
		this.rows = rows;
		const wanted = rows.findIndex((row) =>
			target?.modelKey !== undefined
				? row.kind === "model" && this.modelKey(row.item) === target.modelKey
				: target?.groupKey !== undefined
					? row.kind === "group" && row.group.key === target.groupKey
					: false,
		);
		const firstModel = target?.firstModel ? rows.findIndex((row) => row.kind === "model") : -1;
		this.selectedIndex =
			wanted >= 0
				? wanted
				: firstModel >= 0
					? firstModel
					: Math.min(this.selectedIndex, Math.max(0, rows.length - 1));
	}

	private selectedRow(): SelectorRow | undefined {
		return this.rows[this.selectedIndex];
	}

	/** Opens one header (closing the others) and moves onto its current or first model. */
	private expandGroup(group: ModelGroup): void {
		this.expandedGroupKey = group.key;
		const inside = group.items.find((item) => this.isCurrent(item)) ?? group.items[0];
		this.rebuildRows(inside ? { modelKey: this.modelKey(inside) } : { groupKey: group.key });
		this.updateList();
	}

	/** Closes the open header and keeps the selection on it. Does nothing while every header is held open. */
	private retractGroup(group: ModelGroup): boolean {
		if (this.allOpen()) return false;
		this.expandedGroupKey = null;
		this.rebuildRows({ groupKey: group.key });
		this.updateList();
		return true;
	}

	private confirmSelected(): void {
		const row = this.selectedRow();
		if (!row) return;
		if (row.kind === "model") {
			this.handleSelect(row.item.model);
			return;
		}
		if (!row.expanded) this.expandGroup(row.group);
		else if (!this.retractGroup(row.group)) {
			// Held open by a search or a view: Enter steps into the group instead.
			this.expandGroup(row.group);
		}
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const range = getCenteredVisibleRange(this.selectedIndex, this.rows.length, maxVisible);
		const { startIndex, endIndex } = range;

		// Show visible slice of rows
		for (let i = startIndex; i < endIndex; i++) {
			const row = this.rows[i];
			if (!row) continue;

			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : " ".repeat(visibleWidth("→ "));
			let line: string;
			if (row.kind === "group") {
				const holdsCurrent = row.group.items.some((item) => this.isCurrent(item));
				const title = isSelected ? theme.fg("accent", row.group.label) : row.group.label;
				const detail = theme.fg("muted", `[${row.group.badge}] ${row.group.items.length}`);
				const checkmark = holdsCurrent ? theme.fg("success", " ✓") : "";
				line = `${prefix}${theme.fg("accent", row.expanded ? "▾" : "▸")} ${title} ${detail}${checkmark}`;
			} else {
				const { item } = row;
				const favoriteMark = this.isFavorite(item) ? theme.fg("accent", "★ ") : " ".repeat(visibleWidth("★ "));
				const modelText = isSelected
					? theme.fg("accent", item.displayName ?? item.id)
					: (item.displayName ?? item.id);
				const checkmark = this.isCurrent(item) ? theme.fg("success", " ✓") : "";
				line = `${prefix}  ${favoriteMark}${modelText}${checkmark}`;
			}
			const rowText = isSelected && theme.hasBg("selectedBg") ? theme.bg("selectedBg", `${line} `) : line;

			this.listContainer.addChild(new Text(rowText, 0, 0));
		}

		// Add scroll indicator if needed
		const scrollText = getSelectorScrollText(this.selectedIndex, this.rows.length, range);
		if (scrollText) this.listContainer.addChild(new Text(theme.fg("muted", scrollText), 0, 0));

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.rows.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", this.emptyText()), 0, 0));
		} else {
			const selected = this.rows[this.selectedIndex];
			if (!selected) return;
			this.listContainer.addChild(new Spacer(1));
			const detail =
				selected.kind === "group"
					? `  ${selected.group.label} · ${selected.group.badge} · ${selected.group.items.length} models  ${keyHint("tui.select.confirm", selected.expanded && !this.allOpen() ? "retract" : "expand")}`
					: selected.item.variants
						? `  Effort: ${selected.item.model.defaultThinkingLevel}  ${keyHint("app.models.effortLower", "lower")} / ${keyHint("app.models.effortHigher", "higher")}`
						: `  Model Name: ${selected.item.model.name}`;
			this.listContainer.addChild(new Text(theme.fg("muted", detail), 0, 0));
		}
	}

	private emptyText(): string {
		if (this.searchInput.getValue()) return "  No matching models";
		if (this.scope === "favorites")
			return `  No pinned models. ${keyText("app.models.toggleFavorite")} pin/unpin a model in All.`;
		if (this.scope === "subscriptions") return "  No subscription or OAuth account is logged in. Use /login.";
		if (this.scope === "api") return "  No API or local models are available.";
		return "  No matching models";
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.models.toggleFavoritesTab")) {
			const scopes = this.availableScopes();
			this.setScope(scopes[(scopes.indexOf(this.scope) + 1) % scopes.length]!);
			if (this.scopeHintText) this.scopeHintText.setText(this.getScopeHintText());
			return;
		}
		if (kb.matches(keyData, "app.models.toggleProvider")) {
			const row = this.selectedRow();
			this.allGroupsExpanded = !this.allGroupsExpanded;
			this.rebuildRows(
				row
					? row.kind === "model"
						? { modelKey: this.modelKey(row.item) }
						: { groupKey: row.group.key }
					: undefined,
			);
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "app.models.toggleFavorite")) {
			const selected = this.selectedRow();
			if (selected?.kind === "model") {
				this.settingsManager.toggleModelFavorite(selected.item.provider, selected.item.model.id);
				this.refreshFavoriteKeys();
				const selectedKey = this.modelKey(selected.item);
				this.allModels = this.sortModels(this.allModels);
				this.activeModels = this.getActiveModels();
				this.filterModels(this.searchInput.getValue(), selectedKey);
			}
			return;
		}
		if (kb.matches(keyData, "app.models.effortLower") || kb.matches(keyData, "app.models.effortHigher")) {
			const lower = kb.matches(keyData, "app.models.effortLower");
			const selected = this.selectedRow();
			if (selected?.kind === "group") {
				if (lower) this.retractGroup(selected.group);
				else if (!selected.expanded) this.expandGroup(selected.group);
				return;
			}
			if (selected?.item.variants) {
				const item = selected.item;
				const variants = item.variants!;
				const index = variants.findIndex((model) => model.id === item.model.id);
				item.model = variants[Math.max(0, Math.min(variants.length - 1, index + (lower ? -1 : 1)))]!;
				for (const other of [...this.allModels, ...this.scopedModelItems]) {
					if (
						this.modelKey(other) === this.modelKey(item) &&
						other.variants?.some((model) => model.id === item.model.id)
					)
						other.model = item.model;
				}
				this.updateList();
				return;
			}
			// A model without effort variants: Left retracts its header and lands on it.
			if (selected && lower && this.retractGroup(selected.group)) return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.rows.length === 0) return;
			this.selectedIndex = advanceSelectorIndex(this.selectedIndex, this.rows.length, -1, "wrap");
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.rows.length === 0) return;
			this.selectedIndex = advanceSelectorIndex(this.selectedIndex, this.rows.length, 1, "wrap");
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirmSelected();
		}
		// Ctrl+S to set as default
		else if (this.onSelectAsDefaultCallback && kb.matches(keyData, "app.models.save")) {
			const selected = this.selectedRow();
			if (selected?.kind === "model") {
				this.onSelectAsDefaultCallback(selected.item.model);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>): void {
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
