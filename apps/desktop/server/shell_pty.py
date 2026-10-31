"""Runs a shell on a pseudo-terminal for the desktop app's Terminal pane.

Node has no built-in PTY, and native modules (node-pty) need install scripts, so the server runs this instead.
stdin is written to the terminal, terminal output goes to stdout, and fd 3 takes "rows cols" lines to resize.

Usage: shell_pty.py <shell> <cwd> <rows> <cols>
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def write_all(fd, data):
    while data:
        written = os.write(fd, data)
        data = data[written:]


def resize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    shell, cwd, rows, cols = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvp(shell, [shell, "-l"])

    resize(fd, rows, cols)

    def stop(*_):
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    sources = [fd, 0, 3]
    control = b""
    while True:
        try:
            ready, _, _ = select.select(sources, [], [])
        except InterruptedError:
            continue
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                stop()
            write_all(fd, data)
        if 3 in ready:
            data = os.read(3, 1024)
            if not data:
                sources.remove(3)
                continue
            control += data
            while b"\n" in control:
                line, control = control.split(b"\n", 1)
                parts = line.split()
                if len(parts) == 2:
                    resize(fd, int(parts[0]), int(parts[1]))
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)


main()
