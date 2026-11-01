"""
BCA 全局常量：结果码、默认配置值。

服务器相关的配置（求解器路径、线程数等）不写死在这里，
统一从 config.json 读取（见 bca/config.py）。

SAT 求解不设全局超时（可跑数小时/数天/数月），超时仅由任务显式
指定（Task.solver_timeout / CLI --timeout）。
"""

# =============================================================================
# SAT 求解结果码
# =============================================================================
RESULT_SATISFIABLE = "SATISFIABLE"
RESULT_UNSATISFIABLE = "UNSATISFIABLE"
RESULT_NO_RESULT = "NoResult"
RESULT_TIMEOUT = "TIMEOUT"
RESULT_TERMINATED = "TERMINATED"
RESULT_ERROR = "ERROR"
RESULT_PENDING = "PENDING"          # 批处理占位行：已记模型参数、求解未完成（非终态）
INFEASIBLE = "infeasible"

# kissat 返回码（也是 SAT 求解器通用约定）
KISSAT_RET_SAT = 10
KISSAT_RET_UNSAT = 20

# =============================================================================
# 默认配置（config.json 未提供相应项时的兜底值）
# =============================================================================
DEFAULT_CONFIG = {
    "solver": {
        "path": "kissat",
        "max_retries": 3,     # 求解器崩溃重试次数（不设超时）
    },
    "workers": {
        "milp": None,         # MILP 并行界计算进程数，None = 默认（cpu 数）
        "sat": 1,             # 模型内并行 SAT 求解线程数
    },
    "keep_cnf": False,        # True 时保留 CNF 文件（debug 用；CNF 大，默认删除）
    "keep_solution": True,    # True 时保留求解器输出文件（默认保留：sol 小，是求解过程记录）
    "espresso_dir": "data/espresso",
}

# config.json 路径优先级：环境变量 BCA_CONFIG > 项目根目录 config.json
ENV_CONFIG = "BCA_CONFIG"

# SAT 求解器路径覆盖：环境变量 BCA_KISSAT > config.json 的 solver.path。
# 换机器/换 WSL 用户名时不必改文件，`export BCA_KISSAT=...` 即可。
ENV_SOLVER = "BCA_KISSAT"
