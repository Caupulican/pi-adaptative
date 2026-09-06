/** Synthetic backend-only resources. No operator directories, transcripts, or credentials. */
export const backendReadPaths = [
	{ flavor: "posix", cwd: "/fixture/work space", input: "@literal.txt", expected: "/fixture/work space/@literal.txt" },
	{
		flavor: "posix",
		cwd: "/fixture/work\u00a0space ",
		input: " leading name.txt ",
		expected: "/fixture/work\u00a0space / leading name.txt ",
	},
	{ flavor: "posix", cwd: "/fixture/work", input: "Q:\\literal.txt", expected: "/fixture/work/Q:\\literal.txt" },
	{
		flavor: "posix",
		cwd: "/fixture/work",
		input: "file:///fixture/other%20root/name.txt",
		expected: "/fixture/other root/name.txt",
	},
	{
		flavor: "posix",
		cwd: "/fixture/work",
		homeDir: "/fixture/home",
		input: "~/note.txt",
		expected: "/fixture/home/note.txt",
	},
	{
		flavor: "win32",
		cwd: "Q:\\fixture\\work space",
		input: "sub/é.txt",
		expected: "Q:\\fixture\\work space\\sub\\é.txt",
	},
	{
		flavor: "win32",
		cwd: "\\\\fixture-server\\share\\work",
		input: "../note.txt",
		expected: "\\\\fixture-server\\share\\note.txt",
	},
	{
		flavor: "win32",
		cwd: "Q:\\fixture\\work",
		input: "file://fixture-server/share/note.txt",
		expected: "\\\\fixture-server\\share\\note.txt",
	},
	{
		flavor: "win32",
		cwd: "Q:\\fixture\\work",
		homeDir: "R:\\fixture\\home",
		input: "~\\note.txt",
		expected: "R:\\fixture\\home\\note.txt",
	},
	{ flavor: "win32", cwd: "Q:\\fixture\\work", input: "/rooted/note.txt", expected: "Q:\\rooted\\note.txt" },
] as const;
