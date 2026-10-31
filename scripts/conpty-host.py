import ctypes
import os
import struct
import subprocess
import sys
import threading
from ctypes import wintypes as w

PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
STARTF_USESTDHANDLES = 0x00000100
INFINITE = 0xFFFFFFFF
FRAME_INPUT = b"D"
FRAME_RESIZE = b"R"
INVALID_HANDLE = ctypes.c_void_p(-1)

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
HANDLE = ctypes.c_void_p
kernel32.CreatePipe.argtypes = [ctypes.POINTER(HANDLE), ctypes.POINTER(HANDLE), ctypes.c_void_p, w.DWORD]
kernel32.CreatePseudoConsole.argtypes = [w.DWORD, HANDLE, HANDLE, w.DWORD, ctypes.POINTER(HANDLE)]
kernel32.ResizePseudoConsole.argtypes = [HANDLE, w.DWORD]
kernel32.ClosePseudoConsole.argtypes = [HANDLE]
kernel32.CloseHandle.argtypes = [HANDLE]
kernel32.ReadFile.argtypes = [HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p]
kernel32.WriteFile.argtypes = [HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p]
kernel32.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
kernel32.UpdateProcThreadAttribute.argtypes = [
    ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p,
]
kernel32.WaitForSingleObject.argtypes = [HANDLE, w.DWORD]
kernel32.GetExitCodeProcess.argtypes = [HANDLE, ctypes.POINTER(w.DWORD)]
kernel32.TerminateProcess.argtypes = [HANDLE, w.UINT]
kernel32.CreateProcessW.argtypes = [
    w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR,
    ctypes.c_void_p, ctypes.c_void_p,
]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR),
        ("dwX", w.DWORD), ("dwY", w.DWORD), ("dwXSize", w.DWORD), ("dwYSize", w.DWORD),
        ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD),
        ("dwFlags", w.DWORD), ("wShowWindow", w.WORD), ("cbReserved2", w.WORD),
        ("lpReserved2", ctypes.c_void_p), ("hStdInput", HANDLE), ("hStdOutput", HANDLE), ("hStdError", HANDLE),
    ]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", HANDLE), ("hThread", HANDLE), ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


def coord(cols, rows):
    return cols | (rows << 16)


def read_exactly(stream, count):
    data = b""
    while len(data) < count:
        chunk = stream.read(count - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def pump_output(output_read):
    buffer = ctypes.create_string_buffer(65536)
    count = w.DWORD()
    while kernel32.ReadFile(output_read, buffer, 65536, ctypes.byref(count), None) and count.value:
        sys.stdout.buffer.write(buffer.raw[: count.value])
        sys.stdout.buffer.flush()


def pump_input(console, input_write, process):
    written = w.DWORD()
    while True:
        header = read_exactly(sys.stdin.buffer, 5)
        if header is None:
            kernel32.TerminateProcess(process, 1)
            return
        kind, length = header[:1], struct.unpack(">I", header[1:])[0]
        payload = read_exactly(sys.stdin.buffer, length)
        if payload is None:
            kernel32.TerminateProcess(process, 1)
            return
        if kind == FRAME_INPUT:
            kernel32.WriteFile(input_write, payload, len(payload), ctypes.byref(written), None)
        elif kind == FRAME_RESIZE:
            cols, rows = struct.unpack(">HH", payload)
            kernel32.ResizePseudoConsole(console, coord(cols, rows))


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    command = sys.argv[sys.argv.index("--") + 1 :]

    input_read, input_write, output_read, output_write = HANDLE(), HANDLE(), HANDLE(), HANDLE()
    assert kernel32.CreatePipe(ctypes.byref(input_read), ctypes.byref(input_write), None, 0)
    assert kernel32.CreatePipe(ctypes.byref(output_read), ctypes.byref(output_write), None, 0)
    console = HANDLE()
    result = kernel32.CreatePseudoConsole(coord(cols, rows), input_read, output_write, 0, ctypes.byref(console))
    assert result == 0, f"CreatePseudoConsole failed: {result:#x}"

    size = ctypes.c_size_t()
    kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
    attributes = ctypes.create_string_buffer(size.value)
    assert kernel32.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size))
    assert kernel32.UpdateProcThreadAttribute(
        attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console, ctypes.sizeof(HANDLE), None, None
    ), ctypes.get_last_error()

    startup = STARTUPINFOEXW()
    startup.StartupInfo.cb = ctypes.sizeof(startup)
    startup.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)
    # Without STARTF_USESTDHANDLES the child inherits this process's pipes, not the console, and sees no TTY.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES
    startup.StartupInfo.hStdInput = startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = INVALID_HANDLE

    process_info = PROCESS_INFORMATION()
    command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline(command))
    created = kernel32.CreateProcessW(
        None, command_line, None, None, False,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, None, None,
        ctypes.byref(startup), ctypes.byref(process_info),
    )
    assert created, f"CreateProcessW failed: {ctypes.get_last_error()}"
    kernel32.CloseHandle(input_read)
    kernel32.CloseHandle(output_write)

    output_thread = threading.Thread(target=pump_output, args=(output_read,), daemon=True)
    output_thread.start()
    threading.Thread(target=pump_input, args=(console, input_write, process_info.hProcess), daemon=True).start()

    kernel32.WaitForSingleObject(process_info.hProcess, INFINITE)
    exit_code = w.DWORD()
    kernel32.GetExitCodeProcess(process_info.hProcess, ctypes.byref(exit_code))
    kernel32.ClosePseudoConsole(console)
    output_thread.join(timeout=3)
    sys.stdout.buffer.flush()
    # A normal interpreter exit blocks on the daemon threads that sit in blocking reads.
    os._exit(exit_code.value)


main()
