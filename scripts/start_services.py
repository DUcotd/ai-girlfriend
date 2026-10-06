# -*- coding: utf-8 -*-
"""以 Windows 独立分离进程启动前后端服务（脱离调用方会话存活）。

用法:
    python scripts/start_services.py            # 先探测，已在跑就跳过
    python scripts/start_services.py --status   # 只查当前状态，不启动

三处以前踩过坑的地方：
1. 路径全部由本文件位置推导，不再硬编码 D:\\... —— 换机器/换目录不必改脚本。
2. 后端就绪判定探 **GET /health** 而不是 TCP 握手：端口通了但容器装配抛错、
   数据目录不可写时，TCP 探测照样报 OK（这是旧脚本最容易骗人的一点）。
3. 日志 append 而不是 overwrite：排障时要的是时间线，不是最后一次启动。
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_DIR = os.path.join(REPO_ROOT, "backend-node")
FRONTEND_DIR = os.path.join(REPO_ROOT, "frontend")

BACKEND_PORT = int(os.environ.get("PORT", "8000"))
FRONTEND_PORT = int(os.environ.get("FRONTEND_PORT", "3000"))

DETACHED = (
    subprocess.DETACHED_PROCESS
    | subprocess.CREATE_NEW_PROCESS_GROUP
    | subprocess.CREATE_NO_WINDOW
)


def safe_print(*args) -> None:
    """Windows 控制台默认是 GBK：⚠️ 这类字符会让 print() 直接抛 UnicodeEncodeError
    （本脚本刚踩到，服务已经起来了却返回失败退出码）。这里按控制台编码安全降级。"""
    text = " ".join(str(a) for a in args)
    try:
        print(text)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "utf-8"
        print(text.encode(enc, errors="replace").decode(enc, errors="replace"))


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1.0)
        return s.connect_ex(("127.0.0.1", port)) == 0


def health(port: int, path: str = "/health", timeout: float = 3.0):
    """取回 JSON；服务没起来或不是 JSON 都返回 None（调用方按「没好」处理）。"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, socket.timeout, json.JSONDecodeError, OSError, ValueError):
        return None


def start(name: str, cwd: str, log_path: str) -> None:
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    # 以追加方式打开：旧日志是排障证据，不能被下一次启动覆盖掉
    log = open(log_path, "ab")
    subprocess.Popen(
        "npm run dev",
        cwd=cwd,
        shell=True,
        stdout=log,
        stderr=subprocess.STDOUT,
        creationflags=DETACHED,
        stdin=subprocess.DEVNULL,
    )
    log.close()  # 句柄已交给子进程，父进程留着只会让我们误以为服务还活着
    safe_print(f"[start] {name}: 启动中 (日志 {log_path})")


def wait_until(predicate, timeout: float = 60.0, interval: float = 1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        got = predicate()
        if got:
            return got
        time.sleep(interval)
    return None


def report_backend():
    h = health(BACKEND_PORT)
    if not h:
        return False, f"后端 :{BACKEND_PORT} 无响应（/health 取不到）"
    flags = []
    flags.append(f"v{h.get('version') or '?'}")
    flags.append(f"node {h.get('node')}")
    flags.append("数据目录可写" if h.get("dataDirWritable") else "[注意] 数据目录不可写")
    # Key 存在浏览器 localStorage，后端重启后要靠前端挂载时重新下发：
    # 没下发时聊天会报「请先配置 API Key」，这不是故障，但很容易被当成故障
    flags.append("Key 已下发" if h.get("llmConfigured") else "[注意] 还没收到 API Key（用浏览器打开一次前端即可）")
    return bool(h.get("ok")), " / ".join(flags)


def main() -> int:
    parser = argparse.ArgumentParser(description="启动/检查小爱本地服务")
    parser.add_argument("--status", action="store_true", help="只检查状态，不启动")
    args = parser.parse_args()

    if not args.status:
        if port_open(BACKEND_PORT):
            safe_print(f"[skip] backend: 端口 {BACKEND_PORT} 已有服务在监听")
        else:
            start("backend", BACKEND_DIR, os.path.join(BACKEND_DIR, "dev.log"))
        if port_open(FRONTEND_PORT):
            safe_print(f"[skip] frontend: 端口 {FRONTEND_PORT} 已有服务在监听")
        else:
            start("frontend", FRONTEND_DIR, os.path.join(FRONTEND_DIR, "dev.log"))

        # 后端要等到 /health 真能取到 JSON 才算起来（TCP 通了不算）
        wait_until(lambda: health(BACKEND_PORT) is not None, timeout=60)
        wait_until(lambda: port_open(FRONTEND_PORT), timeout=60)

    ok_backend, detail = report_backend()
    ok_frontend = port_open(FRONTEND_PORT)
    safe_print(f"backend  :{BACKEND_PORT} {'OK' if ok_backend else 'FAIL'} —— {detail}")
    safe_print(f"frontend :{FRONTEND_PORT} {'OK' if ok_frontend else 'FAIL'}")
    return 0 if (ok_backend and ok_frontend) else 1


if __name__ == "__main__":
    sys.exit(main())
