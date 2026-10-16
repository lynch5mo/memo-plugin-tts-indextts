#!/usr/bin/env python3
"""Audio8 同进程只读身份辅助入口。

从明确指定的安装根目录导入既有的 arktts_runtime.service FastAPI app，只新增一个只读
GET /api/memo/runtime，身份值全部来自 require_runtime() 返回的实际 runtime 对象。

本入口不注册音色、不切换权重、不 reload、不下载模型、不写安装目录、不开第二模型进程；
默认且强制仅 loopback 监听，且只在本脚本被显式启动时才运行。
"""

from __future__ import annotations

import argparse
import importlib
import ipaddress
import json
import os
import secrets
import sys
from pathlib import Path

IDENTITY_PATH = "/api/memo/runtime"
LOOPBACK_NAMES = {"localhost", "::1", "0:0:0:0:0:0:0:1"}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the installed Audio8 FastAPI app with a read-only identity endpoint.",
    )
    parser.add_argument("--install-root", required=True, help="包含 arktts_runtime 的安装目录")
    parser.add_argument("--model-dir", default=None, help="显式模型目录（可选）")
    parser.add_argument("--voices-dir", default=None, help="显式音色目录（可选）")
    parser.add_argument("--precision", default=None, help="显式精度（可选）")
    parser.add_argument("--codec-precision", default=None, help="显式 codec 精度（可选）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，只允许 loopback")
    parser.add_argument("--port", type=int, default=8001, help="监听端口")
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="只校验参数并从 runtime 读取身份后打印 JSON，不启动服务",
    )
    return parser.parse_args(argv)


def fail(message: str, code: int = 2) -> None:
    print(f"audio8-service: {message}", file=sys.stderr)
    raise SystemExit(code)


def is_loopback_host(host: str) -> bool:
    if host in LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def resolve_dir(raw: str | None, label: str) -> Path | None:
    if raw is None:
        return None
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        fail(f"{label} 必须是绝对路径：{raw}")
    resolved = candidate.resolve()
    if not resolved.is_dir():
        fail(f"{label} 不是可读目录：{resolved}")
    return resolved


def build_identity(module, instance_id: str) -> dict:
    runtime = module.require_runtime()
    return {
        "backendId": "audio8",
        "modelFingerprint": str(runtime.manifest["model_fingerprint"]),
        "modelDir": str(Path(runtime.model_dir).resolve()),
        "voicesRoot": str(Path(runtime.voices.root).resolve()),
        "precision": str(runtime.precision),
        "codecPrecision": str(runtime.codec_precision),
        "instanceId": instance_id,
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)

    # 纯参数校验先做：任何失败都在导入安装包之前返回，不触碰安装目录。
    if not isinstance(args.port, int) or not 1 <= args.port <= 65535:
        fail(f"端口必须是 1..65535 的整数：{args.port}")
    if not is_loopback_host(args.host):
        fail(f"只允许 loopback 监听，拒绝 host={args.host}")

    install_root_raw = args.install_root
    if not Path(install_root_raw).expanduser().is_absolute():
        fail(f"install-root 必须是绝对路径：{install_root_raw}")
    install_root = resolve_dir(install_root_raw, "install-root")
    service_file = install_root / "arktts_runtime" / "service.py"
    if not service_file.is_file():
        fail(f"install-root 下缺少 arktts_runtime/service.py：{install_root}")

    model_dir = resolve_dir(args.model_dir, "model-dir")
    voices_dir = resolve_dir(args.voices_dir, "voices-dir")

    # service.py 在导入期读取这些环境变量，所以要在导入之前设置。
    if model_dir is not None:
        os.environ["ARKTTS_MODEL_DIR"] = str(model_dir)
    if voices_dir is not None:
        os.environ["ARKTTS_VOICES_DIR"] = str(voices_dir)
    if args.precision:
        os.environ["ARKTTS_PRECISION"] = args.precision
    if args.codec_precision:
        os.environ["ARKTTS_CODEC_PRECISION"] = args.codec_precision

    # 不在安装目录写 bytecode。
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(install_root))

    module = importlib.import_module("arktts_runtime.service")
    module_file = Path(getattr(module, "__file__", "")).resolve()
    if install_root not in module_file.parents:
        fail(f"导入到的 arktts_runtime 不在指定安装目录：{module_file}")

    instance_id = secrets.token_hex(16)

    def memo_runtime() -> dict:
        # 每次请求都从当前 runtime 对象读取，reload 之后身份随之更新。
        return build_identity(module, instance_id)

    module.app.get(IDENTITY_PATH)(memo_runtime)

    if args.self_check:
        payload = dict(memo_runtime())
        payload["identityPath"] = IDENTITY_PATH
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    import uvicorn

    uvicorn.run(module.app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
