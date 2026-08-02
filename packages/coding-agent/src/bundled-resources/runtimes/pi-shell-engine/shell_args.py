"""Bounded shell-argument scans shared by builtins."""

from __future__ import annotations

def split_leading_short_options(
    args: list[str], allowed_chars: str | None = None
) -> tuple[list[str], list[str]]:
    options: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--":
            return options, args[index + 1 :]
        is_short_option = arg.startswith("-") and arg != "-" and len(arg) > 1
        if not is_short_option or (
            allowed_chars is not None
            and any(char not in allowed_chars for char in arg[1:])
        ):
            break
        options.append(arg)
        index += 1
    return options, args[index:]
