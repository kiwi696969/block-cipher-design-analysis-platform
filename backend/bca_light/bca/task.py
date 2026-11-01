"""
任务定义：一次逻辑运行的完整参数（同一任务 = 同一 results 目录，不并行）。

任务由命令行参数声明（--task 指定任务名 = 输出目录名，默认 "default"），
不需要手写 Python 文件。known_active 默认取 cipher 类常量（算法固有属性），
任务可覆盖。
"""

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Task:
    name: str                      # 任务名 = 输出目录名（results/{name}/...），由 CLI --task 指定，默认 "default"
    algorithm: str                 # cipher 名称，如 "SM4"；含 block_size 时 key 为 "SM4-256"
    model: str                     # 模型名，如 "DW"
    block_size: Optional[int] = None   # 非 None 时视为不同算法（输出/记录按 algorithm-{bs} 分）
    attack: str = "differential"   # 攻击类型：differential（DDT）/ linear（LAT）
    round_start: int = 1
    round_end: int = 20
    known_active: Optional[List[int]] = None   # None = 用 cipher 类常量
    p_bound_init: Optional[int] = None         # 初始概率界；None = 按模型默认
    solver_timeout: Optional[int] = None       # 显式求解超时（秒），None 不设超时
    sat_jobs: Optional[int] = None             # DWP/RSP 同 prob 格并行并发上限；None = 全开

    # ------- 派生属性 -------

    @property
    def algorithm_key(self):
        """输出/记录的算法键：不同 block_size 视为不同算法。"""
        if self.block_size is not None:
            return f"{self.algorithm}-{self.block_size}"
        return self.algorithm

    @property
    def result_dir(self):
        """本任务本算法的结果根目录：results/{task}/{algorithm_key}。"""
        import os
        return os.path.join("results", self.name, self.algorithm_key)

    @property
    def model_dir(self):
        """模型目录：results/{task}/{algorithm_key}/{model}。"""
        import os
        return os.path.join(self.result_dir, self.model)

    @property
    def detail_dir(self):
        import os
        return os.path.join(self.model_dir, "details")

    def __post_init__(self):
        # attack 归一化 + 校验（命令行写 "Differential" 也能用）
        self.attack = self.attack.lower()
        if self.attack not in ("differential", "linear"):
            raise ValueError(
                f"未知攻击类型: {self.attack}，可选: differential / linear")

    def display(self):
        lines = [
            f"Task: {self.name}",
            f"  algorithm: {self.algorithm_key}  model: {self.model}  attack: {self.attack}",
            f"  rounds: {self.round_start}..{self.round_end}",
        ]
        if self.sat_jobs is not None:
            lines.append(f"  sat_jobs: {self.sat_jobs}")
        if self.known_active is not None:
            lines.append(f"  known_active: {self.known_active}")
        return "\n".join(lines)
