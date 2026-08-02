export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

export function parseSkillBlock(text: string): ParsedSkillBlock | null;
