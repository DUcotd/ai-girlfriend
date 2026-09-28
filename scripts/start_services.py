# -*- coding: utf-8 -*-
"""以 Windows 独立分离进程启动前后端服务（脱离调用方会话存活）。

用法: python start_services.py   （先探测端口，已监听则跳过）
"""
import subprocess
import socket
import sys
import time

FRONTEND_DIR = r"D:\AI-Projects\ai-girlfriend\frontend"
BACKEND_DIR = r"D:\AI-Projects\ai-girlfriend\backend-node"

DETACHED = (
    subprocess.DETACHED_PROCESS
    | subprocess.CREATE_NEW_PROCESS_GROUP
    | subprocess.CREATE_NO_WINDOW
)


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1.0)
        return s.connect_ex(("127.0.0.1", port)) == 0


def start(name: str, cwd: str, port: int, log_path: str) -> None:
    if port_open(port):
        print(f"[skip] {name}: 端口 {port} 已有服务在监听")
        return
    log = open(log_path, "ab")
    # shell=True -> cmd.exe /c npm run ...，DETACHED 让整棵进程树脱离当前会话
    subprocess.Popen(
        "npm run dev",
        cwd=cwd,
        shell=True,
        stdout=log,
        stderr=subprocess.STDOUT,
        creationflags=DETACHED,
        stdin=subprocess.DEVNULL,
    )
    print(f"[start] {name}: 启动中 (日志 {log_path})")


def wait_port(port: int, timeout: float = 40.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(port):
            return True
        time.sleep(1.0)
    return False


def main() -> int:
    start("backend", BACKEND_DIR, 8000, r"D:\AI-Projects\ai-girlfriend\backend-node\dev.log")
    start("frontend", FRONTEND_DIR, 3000, r"D:\AI-Projects\ai-girlfriend\frontend\dev.log")

    ok_backend = wait_port(8000)
    ok_frontend = wait_port(3000)
    print(f"backend  :8000 {'OK' if ok_backend else 'FAIL'}")
    print(f"frontend :3000 {'OK' if ok_frontend else 'FAIL'}")
    return 0 if (ok_backend and ok_frontend) else 1


if __name__ == "__main__":
    sys.exit(main())
