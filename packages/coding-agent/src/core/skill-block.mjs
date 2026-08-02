const SKILL_OPEN = '<skill name="';
const LOCATION_SEPARATOR = '" location="';
const ATTRIBUTE_END = '">\n';
const SKILL_CLOSE = "\n</skill>";
const USER_MESSAGE_SEPARATOR = "\n\n";

function parsedSkill(name, location, content, userMessage) {
	return {
		name,
		location,
		content,
		userMessage: userMessage?.trim() || undefined,
	};
}

/** Parse Pi's exact skill wrapper without regex backtracking or prefix accumulation. */
export function parseSkillBlock(text) {
	if (!text.startsWith(SKILL_OPEN)) return null;

	const nameStart = SKILL_OPEN.length;
	const nameEnd = text.indexOf('"', nameStart);
	if (nameEnd <= nameStart || !text.startsWith(LOCATION_SEPARATOR, nameEnd)) return null;

	const locationStart = nameEnd + LOCATION_SEPARATOR.length;
	const locationEnd = text.indexOf('"', locationStart);
	if (locationEnd <= locationStart || !text.startsWith(ATTRIBUTE_END, locationEnd)) return null;

	const contentStart = locationEnd + ATTRIBUTE_END.length;
	let closeStart = text.indexOf(SKILL_CLOSE, contentStart);
	while (closeStart !== -1) {
		const suffixStart = closeStart + SKILL_CLOSE.length;
		if (suffixStart === text.length) {
			return parsedSkill(
				text.slice(nameStart, nameEnd),
				text.slice(locationStart, locationEnd),
				text.slice(contentStart, closeStart),
				undefined,
			);
		}
		if (text.startsWith(USER_MESSAGE_SEPARATOR, suffixStart) && suffixStart + USER_MESSAGE_SEPARATOR.length < text.length) {
			return parsedSkill(
				text.slice(nameStart, nameEnd),
				text.slice(locationStart, locationEnd),
				text.slice(contentStart, closeStart),
				text.slice(suffixStart + USER_MESSAGE_SEPARATOR.length),
			);
		}
		closeStart = text.indexOf(SKILL_CLOSE, suffixStart);
	}

	return null;
}
