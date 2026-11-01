"""
Ctx：模型依赖注入容器（用户确认：搜索层模型全自由，框架经 ctx 提供原语）。

模型 run_search(ctx) 从中取：
- ctx.cfg      服务器配置（solver 路径/线程数/保留选项）
- ctx.task     任务参数
- ctx.cipher   算法实例（常量 + 轮函数原语）
- ctx.solver   求解器（SolverBase，默认 kissat）
- ctx.record   按 (task,algorithm,model) 的 CSV 记录器（含断点恢复）
- ctx.bounds   界数组记录器（每个 (task,algorithm,model) 一个 bounds.json，
               集中记全部 SAT 模型的 MILP 界数组，原子更新）
- ctx.esc      espresso S-box 数据（经 cipher.esc_data）

SAT 明细产物（CNF / 求解器输出 sol / 解路径 path）由 Ctx 提供路径原语
（cnf_path/sol_path/path_path），写 details/{cnf,sol,path} 子目录。界数组
不在此列——模型把数组作为 bounds 参数传入 engine.solve_sat_and_record，
由后者调 ctx.bounds.add 集中落盘。

模型可自由组合或绕过这些原语。
"""

import os

from pysat.formula import IDPool

from .record import BoundsStore, Record


class Ctx:
    def __init__(self, cfg, task, cipher, solver):
        self.cfg = cfg
        self.task = task
        self.cipher = cipher
        self.solver = solver
        self.record = Record(task, task.algorithm_key, task.model)
        self.bounds = BoundsStore(task, task.algorithm_key, task.model)

        # 明细目录：results/{task}/{algorithm}/{model}/details/{cnf,sol,path}
        self.cnf_dir = os.path.join(task.detail_dir, "cnf")
        self.sol_dir = os.path.join(task.detail_dir, "sol")
        self.path_dir = os.path.join(task.detail_dir, "path")
        os.makedirs(self.cnf_dir, exist_ok=True)
        os.makedirs(self.sol_dir, exist_ok=True)
        os.makedirs(self.path_dir, exist_ok=True)

    # ------------------------------------------------------------------
    # 变量体系
    # ------------------------------------------------------------------

    @staticmethod
    def new_pool():
        """新建 IDPool（每个 CNF 一个，编号从 1 起，顺序同参考实现）。"""
        return IDPool()

    # ------------------------------------------------------------------
    # 文件路径
    # ------------------------------------------------------------------

    def _tag(self, tag):
        return f"-T{tag}" if tag is not None else ""

    def cnf_path(self, round_num, prob, tag=None):
        return os.path.join(self.cnf_dir, f"R{round_num}-P{prob}{self._tag(tag)}.cnf")

    def sol_path(self, round_num, prob, tag=None):
        return os.path.join(self.sol_dir, f"R{round_num}-P{prob}{self._tag(tag)}_Solution.txt")

    def path_path(self, round_num, prob, tag=None):
        return os.path.join(self.path_dir, f"R{round_num}-P{prob}{self._tag(tag)}.txt")

    def cleanup(self, cnf_path=None, sol_path=None):
        """按配置删除 CNF / 求解器输出文件。

        keep_cnf 默认 False（CNF 大）→ 删 cnf；keep_solution 默认 True（sol 小、
        记录求解过程）→ 只在显式设 false 时删 sol。"""
        if not self.cfg.keep_cnf() and cnf_path:
            try:
                os.remove(cnf_path)
            except OSError:
                pass
        if not self.cfg.keep_solution() and sol_path:
            try:
                os.remove(sol_path)
            except OSError:
                pass
