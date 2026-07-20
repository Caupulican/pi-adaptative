"""Entrypoint: read the JSON request, run the AST, emit merged output + control frame.

The sole composition root — wires the real expander (`expand.expand_word`), the real
command-substitution runner (`exec.run_command_substitution`), and the real builtin
registry (`commands.REGISTRY`) into an `ExecContext`. See
windows-shell-workpackages-2026-07-19.md §1.2/§1.3/§3.
"""

from __future__ import annotations

import json
import os
import sys
import time

import exec as exec_module
import parser as parser_module
import tokens as tokens_module
from context import ExecContext
from errors import UnsupportedConstruct
from expand import ParamExpansionError
from state import ShellState

RECORD_SEPARATOR = b"\x1e"


def _read_request() -> dict:
    raw = sys.stdin.buffer.read()
    return json.loads(raw.decode("utf-8"))


class _OutputSink:
    """Binary sink that streams command output without retaining the whole result."""

    def write(self, data: bytes) -> int:
        written = sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        return written

    def flush(self) -> None:
        sys.stdout.buffer.flush()


def _write_frame(exit_code: int, cwd: str, env_delta: dict, unsupported: dict | None) -> None:
    frame = {
        "exitCode": exit_code,
        "cwd": cwd,
        "envDelta": env_delta,
        "unsupported": unsupported,
    }
    # stderr is the control channel. Command stderr is explicitly merged into
    # the command-output sink by ExecContext, so this frame cannot collide with
    # arbitrary command bytes (including RECORD_SEPARATOR).
    sys.stderr.buffer.write(RECORD_SEPARATOR)
    sys.stderr.buffer.write(json.dumps(frame, separators=(",", ":")).encode("utf-8"))
    sys.stderr.buffer.write(RECORD_SEPARATOR)
    sys.stderr.buffer.flush()


def main() -> int:
    request = _read_request()
    command: str = request["command"]
    cwd: str = request["cwd"]
    env: dict[str, str] = dict(request.get("env") or {})
    timeout_ms = request.get("timeoutMs")

    original_env = dict(env)

    if not os.path.isdir(cwd):
        message = f"cwd does not exist: {cwd}"
        sys.stdout.buffer.write(message.encode("utf-8"))
        _write_frame(2, cwd, {}, {"code": "unsupported", "construct": "cwd-missing", "message": message})
        return 0

    state = ShellState(cwd=cwd, env=env)
    output = _OutputSink()

    deadline = None
    if isinstance(timeout_ms, (int, float)) and timeout_ms > 0:
        deadline = time.monotonic() + (timeout_ms / 1000.0)

    from commands import REGISTRY  # noqa: PLC0415 - deferred so WP-C is testable without commands/
    from expand import expand_word  # noqa: PLC0415 - deferred so WP-C is testable without expand.py

    ctx = ExecContext(
        state=state,
        stdin=sys.stdin.buffer,
        stdout=output,
        expand_word=expand_word,
        run_command_substitution=exec_module.run_command_substitution,
        builtins=REGISTRY,
        deadline=deadline,
        stderr=output,
    )

    try:
        tokens = tokens_module.tokenize(command)
        ast = parser_module.parse(tokens)
        exit_code = exec_module.execute(ast, ctx)
    except UnsupportedConstruct as exc:
        output.write(exc.message.encode("utf-8", errors="replace"))
        _write_frame(
            2,
            state.cwd,
            state.delta(original_env),
            {"code": exc.code, "construct": exc.construct, "message": exc.message},
        )
        return 0
    except ParamExpansionError as exc:
        output.write(f"bash: {exc.name}: {exc.message}\n".encode("utf-8", errors="replace"))
        _write_frame(1, state.cwd, state.delta(original_env), None)
        return 0
    except (OSError, ValueError, UnicodeError) as exc:
        # Expected command/builtin failures must remain framed and must never
        # leak a Python traceback into the host shell protocol.
        output.write(f"shell: {exc}\n".encode("utf-8", errors="replace"))
        _write_frame(1, state.cwd, state.delta(original_env), None)
        return 0
    except Exception as exc:
        # Last-resort protocol boundary: preserve a bounded, actionable error
        # while keeping the control frame parseable.
        output.write(f"shell engine internal error: {type(exc).__name__}: {exc}\n".encode("utf-8", errors="replace"))
        _write_frame(1, state.cwd, state.delta(original_env), None)
        return 0

    output.flush()
    _write_frame(exit_code, state.cwd, state.delta(original_env), None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
