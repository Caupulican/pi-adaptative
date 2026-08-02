export const ANSI_BASIC_COLORS: readonly string[] = [
	"#000000",
	"#800000",
	"#008000",
	"#808000",
	"#000080",
	"#800080",
	"#008080",
	"#c0c0c0",
	"#808080",
	"#ff0000",
	"#00ff00",
	"#ffff00",
	"#0000ff",
	"#ff00ff",
	"#00ffff",
	"#ffffff",
];

export const ANSI_256_CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];
export const ANSI_256_GRAY_LEVELS: readonly number[] = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

function ansiCubeChannelToHex(index: number): string {
	return ANSI_256_CUBE_LEVELS[index].toString(16).padStart(2, "0");
}

export function ansi256ToHex(index: number): string {
	if (index < 16) return ANSI_BASIC_COLORS[index];
	if (index < 232) {
		const cubeIndex = index - 16;
		const red = Math.floor(cubeIndex / 36);
		const green = Math.floor((cubeIndex % 36) / 6);
		const blue = cubeIndex % 6;
		return `#${ansiCubeChannelToHex(red)}${ansiCubeChannelToHex(green)}${ansiCubeChannelToHex(blue)}`;
	}
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}
