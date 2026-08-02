export function escapePromptXmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapePromptXml(value: string): string {
	return escapePromptXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
