/**
 * The warning a settings menu shows for a model value that no configured model matches. The value is saved all the
 * same: a model can be reachable although the registry does not list it, so the owner is told it is unverified.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { UnverifiedModelSetting } from "../../core/language/text-en/auto-learn.ts";

/**
 * Undefined when the value is empty, is `active` or names a configured model; the warning otherwise. A value with a
 * provider is compared whole (`provider/id`), since a model's own id may hold a slash; a bare id matches any provider's
 * model of that id. `setting` names the field the value was typed into.
 */
export function unverifiedModelWarning(
	value: string | undefined,
	available: readonly Pick<Model<Api>, "provider" | "id">[],
	setting: UnverifiedModelSetting = "autoLearn",
): string | undefined {
	const modelValue = value?.trim();
	if (!modelValue || modelValue === "active") return undefined;
	const known = modelValue.includes("/")
		? available.some((model) => `${model.provider}/${model.id}` === modelValue)
		: available.some((model) => model.id === modelValue);
	return known ? undefined : interfaceText().autoLearn.unverifiedModel(setting, modelValue);
}
