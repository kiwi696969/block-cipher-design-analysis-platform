"""
配置加载：config.json（服务器相关配置，每台机器可能不同）。

优先级：环境变量 BCA_CONFIG 指定的文件 > 项目根目录 config.json。
config.json 未覆盖的项使用 consts.DEFAULT_CONFIG 兜底。
"""

import json
import os
import shutil
from copy import deepcopy

from .consts import DEFAULT_CONFIG, ENV_CONFIG, ENV_SOLVER


class Config:
    """服务器相关配置的只读视图。"""

    def __init__(self, data):
        self._data = data

    def get(self, *keys, default=None):
        """按路径取配置值，如 cfg.get('solver', 'path')。"""
        cur = self._data
        for key in keys:
            if not isinstance(cur, dict) or key not in cur:
                return default
            cur = cur[key]
        return cur

    def solver_path(self):
        """求解器路径原始值（可能是绝对路径，也可能只是个命令名）。

        优先级：环境变量 BCA_KISSAT > config.json 的 solver.path > 默认 "kissat"。
        环境变量只覆盖这一项，其余配置仍走 config.json —— 换机器/换 WSL 用户名时
        不必改文件，`export BCA_KISSAT=/path/to/kissat` 即可。
        """
        override = os.environ.get(ENV_SOLVER, "").strip()
        if override:
            return override
        return self.get("solver", "path", default=DEFAULT_CONFIG["solver"]["path"])

    def solver_max_retries(self):
        return self.get("solver", "max_retries", default=DEFAULT_CONFIG["solver"]["max_retries"])

    def milp_workers(self):
        return self.get("workers", "milp")

    def sat_workers(self):
        return self.get("workers", "sat", default=DEFAULT_CONFIG["workers"]["sat"])

    def keep_cnf(self):
        return self.get("keep_cnf", default=DEFAULT_CONFIG["keep_cnf"])

    def keep_solution(self):
        return self.get("keep_solution", default=DEFAULT_CONFIG["keep_solution"])

    def espresso_dir(self):
        return self.get("espresso_dir", default=DEFAULT_CONFIG["espresso_dir"])


# 随代码分发的 kissat：<项目根>/kissat-4.0.0-linux-amd64/kissat-4.0.0-linux-amd64。
# 只在"配置值是裸命令名、且 PATH 里找不到"时兜底 —— 换机器没装 kissat 也能跑。
BUNDLED_SOLVER = os.path.join("kissat-4.0.0-linux-amd64", "kissat-4.0.0-linux-amd64")


def _project_root():
    """bca/config.py → bca → bca_light → backend → <项目根>。"""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(os.path.dirname(here)))


def resolve_solver_path(value):
    """把 solver_path() 的原始值解析成真实可执行文件路径；解析不到返回 None。

    **唯一实现**：probe() 与 KissatSolver 都调这里，不许各自再写一份。
    历史上 probe 用 `shutil.which()`、solver 用 `os.path.exists()`，于是配置成
    裸命令名时自检报 ok、真正求解却 FileNotFoundError —— 同一语义两处实现的典型。

    - 含路径分隔符：按路径处理，存在就返回，不存在返回 None。
      写错的路径**不兜底** —— 静默改用别的二进制会掩盖配置错误。
    - 裸命令名：先查 PATH；仍找不到时兜底到项目自带副本。
    """
    if not value:
        return None
    if "/" in value or "\\" in value:
        return value if os.path.exists(value) else None
    found = shutil.which(value)
    if found:
        return found
    bundled = os.path.join(_project_root(), BUNDLED_SOLVER)
    return bundled if os.path.exists(bundled) else None


def _deep_merge(base, override):
    """override 递归覆盖 base，返回新 dict。"""
    result = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config(path=None):
    """
    加载配置。

    Args:
        path: 显式指定配置文件路径；None 时按 env > 默认顺序查找。
              找不到文件时返回全部默认值。

    Returns:
        Config 实例
    """
    if path is None:
        path = os.environ.get(ENV_CONFIG)
    if path is None or not os.path.exists(path):
        # 默认路径：项目根目录 config.json（即本包上一级的 config.json）
        default_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")
        if os.path.exists(default_path):
            path = default_path
        else:
            return Config(DEFAULT_CONFIG)

    with open(path, "r", encoding="utf-8") as f:
        user_data = json.load(f)

    return Config(_deep_merge(DEFAULT_CONFIG, user_data))
