"""Executes the frozen AST: lists, pipelines, redirections, subshells, dispatch.

Owned by WP-C. Reaches expansion/builtins ONLY through `ExecContext` (never imports
`expand` or `commands`). See windows-shell-workpackages-2026-07-19.md §3.
"""

from __future__ import annotations

import io
import os
import subprocess
import threading
from typing import BinaryIO

import nodes
import parser as parser_module
import proc
import tokens as tokens_module
from context import RUNNER_BUILTINS, STATE_BUILTINS, BuiltinContext, ExecContext
from errors import UnsupportedConstruct
from state import ShellState

DEVNULL = os.devnull


class _Redirected:
    """Tracks open file handles opened for a command's redirects, closed after run."""

    def __init__(self) -> None:
        self.handles: list[BinaryIO] = []

    def open(self, path: str, mode: str) -> BinaryIO:
        handle = open(path, mode)  # noqa: SIM115 - closed explicitly in close()
        self.handles.append(handle)
        return handle

    def close(self) -> None:
        for handle in self.handles:
            try:
                handle.close()
            except OSError:
                pass


def _redirect_target_path(redirect: nodes.Redirect, ctx: ExecContext) -> str:
    if redirect.target is None:
        raise UnsupportedConstruct("malformed-syntax", "redirect missing a target")
    parts = ctx.expand_word(redirect.target, ctx)
    if not parts:
        raise UnsupportedConstruct("malformed-syntax", "redirect target expanded to nothing")
    path = parts[0]
    if path == "/dev/null":
        path = DEVNULL
    if not os.path.isabs(path):
        path = os.path.join(ctx.state.cwd, path)
    return path


def _apply_redirects(
    redirects: list[nodes.Redirect],
    ctx: ExecContext,
    stdin_stream: BinaryIO | int,
    stdout_stream: BinaryIO | int,
    stderr_stream: BinaryIO | int,
    tracker: _Redirected,
) -> tuple[BinaryIO | int, BinaryIO | int, BinaryIO | int]:
    """Return the (stdin, stdout, stderr) streams after applying `redirects` in order."""
    cur_in, cur_out, cur_err = stdin_stream, stdout_stream, stderr_stream
    for redirect in redirects:
        op = redirect.op
        if op in (">", "1>"):
            cur_out = tracker.open(_redirect_target_path(redirect, ctx), "wb")
        elif op in (">>", "1>>"):
            cur_out = tracker.open(_redirect_target_path(redirect, ctx), "ab")
        elif op == "<":
            cur_in = tracker.open(_redirect_target_path(redirect, ctx), "rb")
        elif op == "2>":
            cur_err = tracker.open(_redirect_target_path(redirect, ctx), "wb")
        elif op == "2>>":
            cur_err = tracker.open(_redirect_target_path(redirect, ctx), "ab")
        elif op in ("2>&1",):
            cur_err = cur_out
        elif op in ("&>", ">&"):
            target = tracker.open(_redirect_target_path(redirect, ctx), "wb")
            cur_out = target
            cur_err = target
        elif op == "1>&2":
            cur_out = cur_err
        else:
            raise UnsupportedConstruct("malformed-syntax", f"unsupported redirect operator {op!r}")
    return cur_in, cur_out, cur_err


class _ChildStream:
    """An OS-level fd usable by a spawned child, plus optional pipe-bridge cleanup.

    `stream_or_fd` handed to us may already be a real fd (a redirected file, or the
    process's own stdin/stdout) — in that case we hand it straight through. It may also
    be a plain in-memory `BinaryIO` (e.g. the merged-sink `io.BytesIO` used by `main.py`
    and command substitution) which has no fd a child process can write/read directly;
    for that case we bridge through a real `os.pipe()` with a background thread copying
    bytes to/from the memory stream, so external children work identically either way.
    """

    def __init__(self, fd: int, owns_fd: bool, join: object | None = None) -> None:
        self.fd = fd
        self.owns_fd = owns_fd
        self.join = join


def _real_fd(stream: BinaryIO | int) -> int | None:
    if isinstance(stream, int):
        return stream
    try:
        return stream.fileno()
    except (io.UnsupportedOperation, AttributeError, ValueError, OSError):
        return None


def _prepare_child_output(stream: BinaryIO | int) -> _ChildStream:
    fd = _real_fd(stream)
    if fd is not None:
        return _ChildStream(fd, owns_fd=False)
    assert not isinstance(stream, int)
    read_fd, write_fd = os.pipe()

    def pump() -> None:
        with os.fdopen(read_fd, "rb", closefd=True) as reader:
            while True:
                chunk = reader.read(65536)
                if not chunk:
                    break
                stream.write(chunk)

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()
    return _ChildStream(write_fd, owns_fd=True, join=thread.join)


def _prepare_child_input(stream: BinaryIO | int) -> _ChildStream:
    fd = _real_fd(stream)
    if fd is not None:
        return _ChildStream(fd, owns_fd=False)
    assert not isinstance(stream, int)
    data = stream.read()
    read_fd, write_fd = os.pipe()

    def feed() -> None:
        with os.fdopen(write_fd, "wb", closefd=True) as writer:
            writer.write(data)

    thread = threading.Thread(target=feed, daemon=True)
    thread.start()
    return _ChildStream(read_fd, owns_fd=True, join=thread.join)


def _spawn_with_bridges(
    argv: list[str],
    state: ShellState,
    stdin_stream: BinaryIO | int,
    stdout_stream: BinaryIO | int,
    stderr_stream: BinaryIO | int,
    deadline: float | None,
) -> tuple["subprocess.Popen[bytes]", _ChildStream, _ChildStream, _ChildStream]:
    """Spawn `argv`, bridging any non-fd streams through a pipe.

    Returns `(child, in_prep, out_prep, err_prep)`; the caller must wait on `child` and
    then call `_finish_bridges(in_prep, out_prep, err_prep)` so any bridge thread has
    fully drained/fed the memory stream before the caller reads its contents.
    """
    in_prep = _prepare_child_input(stdin_stream)
    out_prep = _prepare_child_output(stdout_stream)
    err_prep = out_prep if stderr_stream is stdout_stream else _prepare_child_output(stderr_stream)
    try:
        child = proc.spawn_external(argv, state, in_prep.fd, out_prep.fd, err_prep.fd, deadline)
    finally:
        if in_prep.owns_fd:
            _safe_close(in_prep.fd)
        if out_prep.owns_fd:
            _safe_close(out_prep.fd)
        if err_prep is not out_prep and err_prep.owns_fd:
            _safe_close(err_prep.fd)
    return child, in_prep, out_prep, err_prep


def _finish_bridges(*preps: _ChildStream) -> None:
    for prep in preps:
        if prep.join is not None:
            prep.join()


def _merged_sink(ctx: ExecContext) -> BinaryIO | int:
    """The session merged sink for un-redirected stderr: `ctx.stderr` if set, else `ctx.stdout`."""
    return ctx.stderr if ctx.stderr is not None else ctx.stdout


def _write_merged(stream: BinaryIO | int, data: bytes, ctx: ExecContext) -> None:
    if isinstance(stream, int):
        os.write(stream, data)
    else:
        stream.write(data)
        stream.flush()


def execute(list_node: nodes.CommandList, ctx: ExecContext) -> int:
    """Run a `CommandList`; returns the exit code of the last executed entry."""
    exit_code = 0
    for entry in list_node.entries:
        exit_code = _execute_andor(entry, ctx)
    return exit_code


def _execute_andor(andor: nodes.AndOr, ctx: ExecContext) -> int:
    exit_code = 0
    for i, pipeline in enumerate(andor.pipelines):
        if i > 0:
            operator = andor.operators[i - 1]
            if operator == "&&" and exit_code != 0:
                continue
            if operator == "||" and exit_code == 0:
                continue
        exit_code = _execute_pipeline(pipeline, ctx)
    return exit_code


def _execute_pipeline(pipeline: nodes.Pipeline, ctx: ExecContext) -> int:
    elements = pipeline.elements
    exit_code = _run_pipeline_elements(elements, ctx)
    if pipeline.negated:
        exit_code = 0 if exit_code != 0 else 1
    return exit_code


def _run_pipeline_elements(elements: list, ctx: ExecContext) -> int:
    stderr_base = _merged_sink(ctx)
    if len(elements) == 1:
        return _dispatch_element(elements[0], ctx, ctx.stdin, ctx.stdout, stderr_base)

    n = len(elements)
    read_ends: list[int] = []
    write_ends: list[int] = []
    for _ in range(n - 1):
        r, w = os.pipe()
        read_ends.append(r)
        write_ends.append(w)

    # Every fd number actually closed so far. `os.pipe()` recycles fd numbers, so a
    # bridge pipe created later in this same loop (for a non-fd stdout/stdin stream)
    # may reuse a number we already closed; guard every close through this set so a
    # live, recycled fd is never closed a second time.
    closed_fds: set[int] = set()

    def close_once(fd: int) -> None:
        if fd not in closed_fds:
            closed_fds.add(fd)
            _safe_close(fd)

    results: list[int] = [0] * n
    refusals: list[UnsupportedConstruct | None] = [None] * n

    # External-process stages spawn as real OS processes (concurrent by construction).
    # Builtin/state stages run in-process; each runs on its own thread so a stage that
    # writes more than a pipe's kernel buffer cannot deadlock waiting for a downstream
    # reader that hasn't started yet (real bash pipes are all concurrent).
    procs: list[subprocess.Popen | None] = [None] * n
    proc_preps: list[tuple[_ChildStream, _ChildStream, _ChildStream] | None] = [None] * n
    threads: list[threading.Thread | None] = [None] * n

    for index in range(n):
        stdin_stream = ctx.stdin if index == 0 else read_ends[index - 1]
        stdout_stream = ctx.stdout if index == n - 1 else write_ends[index]
        element = elements[index]
        is_write_end_owned_here = index < n - 1

        if isinstance(element, nodes.SimpleCommand) and _is_external_dispatch(element, ctx):
            spawned = _spawn_external_stage(element, ctx, stdin_stream, stdout_stream, stderr_base)
            if spawned is None:
                # Command-not-found in a pipeline stage: report it, record 127 for this
                # stage, and close the stage's owned write end so downstream sees EOF —
                # never let this crash the engine or stall the rest of the pipeline.
                results[index] = 127
            else:
                child, preps = spawned
                procs[index] = child
                proc_preps[index] = preps
            # Parent's real-pipe copies were dup'd into the child by fork/exec (or were
            # never used, on the not-found path); close ours so downstream sees EOF
            # once the (now independent) child process exits or the stage is skipped.
            if is_write_end_owned_here:
                close_once(write_ends[index])
            if index > 0:
                close_once(read_ends[index - 1])
        else:
            # Inline (in-process) stage: the thread reads/writes these SAME fds directly
            # (no fork/dup), so the main loop must not close them out from under it.

            def run_inline(idx=index, sin=stdin_stream, sout=stdout_stream, owns_write=is_write_end_owned_here) -> None:
                try:
                    results[idx] = _dispatch_element(elements[idx], ctx, sin, sout, stderr_base, is_pipeline=True)
                except UnsupportedConstruct as exc:
                    # A structured refusal from an inline stage means the WHOLE command
                    # is outside the frozen grammar/behavior contract — captured here and
                    # re-raised on the main thread after all stages join (first one wins),
                    # so the caller sees the normal structured-refusal frame, never a
                    # fabricated exit-0/empty-output success.
                    refusals[idx] = exc
                    results[idx] = 1
                except BaseException as exc:  # noqa: BLE001 - any other stage failure must not crash the engine
                    # Any OTHER exception is a real per-stage failure, not a refusal: it
                    # gets a named, actionable one-line message on the merged sink (never
                    # a Python traceback) and this stage records exit 1.
                    message = f"{_stage_label(elements[idx])}: {exc}\n"
                    _write_merged(stderr_base, message.encode("utf-8", errors="replace"), ctx)
                    results[idx] = 1
                finally:
                    if owns_write:
                        close_once(sout)

            thread = threading.Thread(target=run_inline, daemon=True)
            threads[index] = thread
            thread.start()

    for thread in threads:
        if thread is not None:
            thread.join()
    for index, proc_obj in enumerate(procs):
        if proc_obj is not None:
            results[index] = proc.wait_with_deadline(proc_obj, ctx.deadline)
            preps = proc_preps[index]
            if preps is not None:
                _finish_bridges(*preps)

    # Defensive cleanup: any pipe fd an inline stage held onto (rather than an external
    # stage's already-closed dup) is now unreachable and can be closed — but never a
    # number already closed and potentially recycled by a bridge pipe above.
    for fd in (*read_ends, *write_ends):
        close_once(fd)

    for refusal in refusals:
        if refusal is not None:
            # First refusal wins; re-raise on the main thread (after every stage has
            # joined/waited and every fd is cleaned up) so `execute()`'s caller sees the
            # normal structured-refusal frame for the whole command — never a fabricated
            # exit-0/empty-output success.
            raise refusal

    return results[-1]


def _stage_label(element) -> str:
    """A short, human-actionable name for a pipeline stage used in error messages.

    Uses the unexpanded command word text when it is a plain `Lit`/`Raw` segment (no
    expansion needed to read it); falls back to the node's type name otherwise.
    """
    if isinstance(element, nodes.SimpleCommand) and element.words:
        segments = element.words[0].segments
        if len(segments) == 1 and isinstance(segments[0], (nodes.Lit, nodes.Raw)):
            return segments[0].text
    return type(element).__name__


def _safe_close(fd_or_stream) -> None:
    if isinstance(fd_or_stream, int):
        try:
            os.close(fd_or_stream)
        except OSError:
            pass


def _is_external_dispatch(command: nodes.SimpleCommand, ctx: ExecContext) -> bool:
    if not command.words:
        return False
    expanded = ctx.expand_word(command.words[0], ctx)
    if not expanded:
        return False
    name = expanded[0]
    if name in STATE_BUILTINS or name in RUNNER_BUILTINS or name in ctx.builtins:
        return False
    return True


def _spawn_external_stage(
    command: nodes.SimpleCommand,
    ctx: ExecContext,
    stdin_stream: BinaryIO | int,
    stdout_stream: BinaryIO | int,
    stderr_base: BinaryIO | int,
) -> tuple[subprocess.Popen, tuple[_ChildStream, _ChildStream, _ChildStream]] | None:
    """Spawn one external pipeline stage, applying ITS OWN redirects first.

    Un-redirected stdout stays wired to the pipe; un-redirected stderr routes to
    `stderr_base` (the session merged sink), never into the pipe. Returns `None` (after
    reporting "command not found" to `stderr_base`) instead of raising, so a bad stage
    name cannot crash the whole pipeline — the caller records exit 127 for this stage.
    """
    tracker = _Redirected()
    try:
        r_in, r_out, r_err = _apply_redirects(command.redirects, ctx, stdin_stream, stdout_stream, stderr_base, tracker)
        argv = _expand_argv(command, ctx)
        env = _apply_transient_assignments(command, ctx)
        scratch_state = ShellState(cwd=ctx.state.cwd, env=env)
        try:
            child, in_prep, out_prep, err_prep = _spawn_with_bridges(
                argv, scratch_state, r_in, r_out, r_err, ctx.deadline
            )
        except FileNotFoundError:
            message = f"{argv[0]}: command not found\n"
            _write_merged(stderr_base, message.encode("utf-8", errors="replace"), ctx)
            return None
        return child, (in_prep, out_prep, err_prep)
    finally:
        tracker.close()


def _expand_argv(command: nodes.SimpleCommand, ctx: ExecContext) -> list[str]:
    argv: list[str] = []
    for word in command.words:
        argv.extend(ctx.expand_word(word, ctx))
    return argv


def _apply_transient_assignments(command: nodes.SimpleCommand, ctx: ExecContext) -> dict[str, str]:
    env = dict(ctx.state.env)
    for name, word in command.assignments:
        values = ctx.expand_word(word, ctx)
        env[name] = "".join(values) if values else ""
    return env


def _dispatch_element(
    element,
    ctx: ExecContext,
    stdin_stream: BinaryIO | int,
    stdout_stream: BinaryIO | int,
    stderr_stream: BinaryIO | int,
    is_pipeline: bool = False,
) -> int:
    if isinstance(element, nodes.Subshell):
        return _execute_subshell(element, ctx, stdin_stream, stdout_stream, stderr_stream)
    if isinstance(element, nodes.BraceGroup):
        return _execute_brace_group(element, ctx, stdin_stream, stdout_stream, stderr_stream)
    if isinstance(element, nodes.SimpleCommand):
        return _dispatch_simple_command(element, ctx, stdin_stream, stdout_stream, stderr_stream)
    raise UnsupportedConstruct("malformed-syntax", f"unrecognized pipeline element {type(element)!r}")


def _sub_ctx(
    ctx: ExecContext,
    state: ShellState,
    stdin_stream: BinaryIO | int,
    stdout_stream: BinaryIO | int,
    stderr_stream: BinaryIO | int,
) -> ExecContext:
    return ExecContext(
        state=state,
        stdin=stdin_stream,
        stdout=stdout_stream,
        expand_word=ctx.expand_word,
        run_command_substitution=ctx.run_command_substitution,
        builtins=ctx.builtins,
        deadline=ctx.deadline,
        stderr=stderr_stream,
    )


def _execute_subshell(node: nodes.Subshell, ctx: ExecContext, stdin_stream, stdout_stream, stderr_stream) -> int:
    tracker = _Redirected()
    try:
        r_in, r_out, r_err = _apply_redirects(
            node.redirects, ctx, stdin_stream, stdout_stream, stderr_stream, tracker
        )
        isolated_state = ctx.state.copy()
        inner_ctx = _sub_ctx(ctx, isolated_state, r_in, r_out, r_err)
        return execute(node.body, inner_ctx)
    finally:
        tracker.close()


def _execute_brace_group(node: nodes.BraceGroup, ctx: ExecContext, stdin_stream, stdout_stream, stderr_stream) -> int:
    tracker = _Redirected()
    try:
        r_in, r_out, r_err = _apply_redirects(
            node.redirects, ctx, stdin_stream, stdout_stream, stderr_stream, tracker
        )
        inner_ctx = _sub_ctx(ctx, ctx.state, r_in, r_out, r_err)
        return execute(node.body, inner_ctx)
    finally:
        tracker.close()


def _dispatch_simple_command(
    command: nodes.SimpleCommand,
    ctx: ExecContext,
    stdin_stream: BinaryIO | int,
    stdout_stream: BinaryIO | int,
    stderr_stream: BinaryIO | int,
) -> int:
    tracker = _Redirected()
    try:
        r_in, r_out, r_err = _apply_redirects(
            command.redirects, ctx, stdin_stream, stdout_stream, stderr_stream, tracker
        )

        if not command.words:
            # Pure assignment(s), no command word: mutate ctx.state.
            for name, word in command.assignments:
                values = ctx.expand_word(word, ctx)
                ctx.state.setenv(name, "".join(values) if values else "")
            return 0

        argv = _expand_argv(command, ctx)
        if not argv:
            # All words expanded to zero argv strings (e.g. an unset/empty `$VAR` alone):
            # bash runs no command here. Redirects/assignments above still applied; exit 0.
            return 0
        name = argv[0]

        if name in STATE_BUILTINS:
            return _run_state_builtin(name, argv, ctx, r_out)

        if name in RUNNER_BUILTINS:
            return _run_xargs(argv, ctx, r_in, r_out)

        if name in ctx.builtins:
            env = _apply_transient_assignments(command, ctx)
            builtin_ctx = BuiltinContext(
                argv=argv, cwd=ctx.state.cwd, env=env, stdin=_as_stream(r_in, "rb"), stdout=_as_stream(r_out, "wb")
            )
            return ctx.builtins[name](builtin_ctx)

        # External command.
        env = _apply_transient_assignments(command, ctx)
        scratch_state = ShellState(cwd=ctx.state.cwd, env=env)
        try:
            child, in_prep, out_prep, err_prep = _spawn_with_bridges(argv, scratch_state, r_in, r_out, r_err, ctx.deadline)
        except FileNotFoundError:
            message = f"{name}: command not found\n"
            _write_merged(r_err, message.encode("utf-8", errors="replace"), ctx)
            return 127
        exit_code = proc.wait_with_deadline(child, ctx.deadline)
        _finish_bridges(in_prep, out_prep, err_prep)
        return exit_code
    finally:
        tracker.close()


def _as_stream(fd_or_stream: BinaryIO | int, mode: str) -> BinaryIO:
    """Wrap `fd_or_stream` as a `BinaryIO` opened in the CALLER-KNOWN `mode`.

    A pipeline stage's stdin/stdout fd is an arbitrary kernel fd number picked by
    `os.pipe()` — it is never reliably 0 or 1 — so the read/write intent must come from
    the call site (which knows whether this is stdin or stdout), never be guessed from
    the fd's numeric value.
    """
    if isinstance(fd_or_stream, int):
        return os.fdopen(fd_or_stream, mode, closefd=False)
    return fd_or_stream


def _run_state_builtin(name: str, argv: list[str], ctx: ExecContext, out_stream: BinaryIO | int) -> int:
    if name == "cd":
        target = argv[1] if len(argv) > 1 else ctx.state.env.get("HOME")
        print_new_cwd = argv[1:2] == ["-"]
        if print_new_cwd:
            oldpwd = ctx.state.env.get("OLDPWD")
            if not oldpwd:
                _write_merged(out_stream, b"cd: OLDPWD not set\n", ctx)
                return 1
            target = oldpwd
        if target is None:
            _write_merged(out_stream, b"cd: HOME not set\n", ctx)
            return 1
        try:
            ctx.state.chdir(target)
        except FileNotFoundError:
            _write_merged(out_stream, f"cd: {target}: No such file or directory\n".encode("utf-8"), ctx)
            return 1
        if print_new_cwd:
            _write_merged(out_stream, f"{ctx.state.cwd}\n".encode("utf-8"), ctx)
        return 0

    if name == "export":
        for item in argv[1:]:
            if "=" in item:
                key, _, value = item.partition("=")
                ctx.state.setenv(key, value)
            else:
                ctx.state.env.setdefault(item, "")
        return 0

    if name == "unset":
        for item in argv[1:]:
            ctx.state.unsetenv(item)
        return 0

    raise UnsupportedConstruct("unsupported-builtin", f"unsupported state builtin {name!r}")


def _run_xargs(argv: list[str], ctx: ExecContext, in_stream: BinaryIO | int, out_stream: BinaryIO | int) -> int:
    args = argv[1:]
    null_sep = False
    n_count: int | None = None
    replace_marker: str | None = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "-0":
            null_sep = True
            i += 1
        elif a == "-n":
            i += 1
            if i >= len(args):
                raise UnsupportedConstruct("unsupported-flag", "xargs -n requires an argument")
            n_count = int(args[i])
            i += 1
        elif a.startswith("-n") and len(a) > 2 and a[2:].isdigit():
            n_count = int(a[2:])
            i += 1
        elif a == "-I":
            i += 1
            if i >= len(args):
                raise UnsupportedConstruct("unsupported-flag", "xargs -I requires an argument")
            replace_marker = args[i]
            i += 1
        elif a.startswith("-I") and len(a) > 2:
            replace_marker = a[2:]
            i += 1
        elif a.startswith("-") and a not in ("-",):
            raise UnsupportedConstruct("unsupported-flag", f"xargs: unsupported flag {a!r}")
        else:
            break
    cmd_argv = args[i:]
    if not cmd_argv:
        raise UnsupportedConstruct("malformed-syntax", "xargs requires a command")

    data = _read_all(in_stream)
    if null_sep:
        raw_tokens = [t for t in data.split(b"\x00") if t != b""]
        items = [t.decode("utf-8", errors="replace") for t in raw_tokens]
    else:
        items = data.decode("utf-8", errors="replace").split()

    exit_code = 0
    if replace_marker is not None:
        for item in items:
            # GNU xargs -I replaces every OCCURRENCE of the marker inside each argument
            # (a substring replace), not only args that are exactly the marker token.
            batch_argv = [piece.replace(replace_marker, item) for piece in cmd_argv]
            exit_code = _run_xargs_batch(batch_argv, ctx, out_stream)
        return exit_code

    batch_size = n_count if n_count is not None else len(items) if items else 1
    if batch_size <= 0:
        batch_size = 1
    if not items:
        return 0
    for start in range(0, len(items), batch_size):
        batch = items[start : start + batch_size]
        exit_code = _run_xargs_batch([*cmd_argv, *batch], ctx, out_stream)
    return exit_code


def _run_xargs_batch(argv: list[str], ctx: ExecContext, out_stream: BinaryIO | int) -> int:
    name = argv[0]
    if name in ctx.builtins:
        builtin_ctx = BuiltinContext(
            argv=argv, cwd=ctx.state.cwd, env=dict(ctx.state.env), stdin=_empty_stream(), stdout=_as_stream(out_stream, "wb")
        )
        return ctx.builtins[name](builtin_ctx)
    if name in STATE_BUILTINS:
        return _run_state_builtin(name, argv, ctx, out_stream)
    scratch_state = ShellState(cwd=ctx.state.cwd, env=dict(ctx.state.env))
    try:
        child, in_prep, out_prep, err_prep = _spawn_with_bridges(
            argv, scratch_state, subprocess.DEVNULL, out_stream, out_stream, ctx.deadline
        )
    except FileNotFoundError:
        _write_merged(out_stream, f"{name}: command not found\n".encode("utf-8"), ctx)
        return 127
    exit_code = proc.wait_with_deadline(child, ctx.deadline)
    _finish_bridges(in_prep, out_prep, err_prep)
    return exit_code


def _empty_stream() -> BinaryIO:
    return io.BytesIO(b"")


def _read_all(stream: BinaryIO | int) -> bytes:
    if isinstance(stream, int):
        chunks = []
        while True:
            chunk = os.read(stream, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    return stream.read()


def run_command_substitution(src: str, ctx: ExecContext) -> tuple[str, int]:
    """Tokenize+parse+execute `src` with stdout captured; returns (stripped_stdout, exit_code)."""
    tokens = tokens_module.tokenize(src)
    ast = parser_module.parse(tokens)
    buffer = io.BytesIO()
    sub_ctx = ExecContext(
        state=ctx.state,
        stdin=ctx.stdin,
        stdout=buffer,
        expand_word=ctx.expand_word,
        run_command_substitution=ctx.run_command_substitution,
        builtins=ctx.builtins,
        deadline=ctx.deadline,
        stderr=ctx.stderr,
    )
    exit_code = execute(ast, sub_ctx)
    text = buffer.getvalue().decode("utf-8", errors="replace")
    return text.rstrip("\n"), exit_code
