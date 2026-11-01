"""
模型基类：模型全自由 + 原语兜底（用户确认的搜索层设计）。

每个模型的 run_search(ctx) 完全持有自己的主循环控制流（搜索方向、界管理、
SAT 调度），只通过 ctx 取框架原语（cipher/record/solver/config/engine 函数），
可以调用也可以绕过。不使用继承/模板方法约束模型行为。
"""

from abc import ABC, abstractmethod


class ModelBase(ABC):
    """模型接口：run_search(ctx) 执行一次完整搜索。"""

    name = "base"

    @abstractmethod
    def run_search(self, ctx):
        """
        执行搜索。ctx 提供 cipher/record/solver/cfg/task 与 engine 原语。

        Returns:
            dict，汇总搜索结果（各模型自定义键），用于 CLI 打印。
        """
