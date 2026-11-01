"""
BCA CLI：任务声明与执行。

用法：
    python main.py run --cipher SM4 --model MAP --rounds 1-8 [--task sm4-map]
    python main.py run --cipher SM4 --model LIN --rounds 1-8 --attack linear
    python main.py convert-data                  # S 盒 txt → pkl（差分 + 线性）

`--attack linear` 走线性（Matsui）搜索：S 盒约束换成 LAT 数据
（{DATA_NAME}_S-Box_Linear_Consts.*），搜索链路与差分完全一致；推荐配 model=LIN
（活跃 S 盒 + 精确线性权重），或直接用 AS（只报活跃 S 盒计数）。
"""

import argparse
import ast
import glob
import os
import pickle
import sys

from bca.config import load_config
from bca.cipher import get_cipher
from bca.ctx import Ctx
from bca.solver import KissatSolver
from bca.task import Task
from models import get_model

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))


def parse_rounds(s):
    """解析轮数范围字符串，如 "1-8" → (1, 8)。"""
    try:
        start, end = s.split("-")
        return int(start), int(end)
    except ValueError:
        raise argparse.ArgumentTypeError(f"轮数范围应为 start-end（如 1-8），收到: {s}")


def build_task(args):
    """从 CLI 参数构建 Task。--task 是任务名（输出目录名，默认 "default"），
    语义同 DC-SAT：断点恢复 = 用相同命令重跑，已记录的实例跳过。"""
    if not (args.cipher and args.model and args.rounds):
        sys.exit("run 需要 --cipher --model --rounds（--task 可选，默认 default）")
    task = Task(
        name=args.task or "default",
        algorithm=args.cipher,
        model=args.model,
        round_start=parse_rounds(args.rounds)[0],
        round_end=parse_rounds(args.rounds)[1],
    )
    if args.attack is not None:
        task.attack = args.attack
    if args.timeout is not None:
        task.solver_timeout = args.timeout
    if args.sat_jobs is not None:
        task.sat_jobs = args.sat_jobs
    return task


def cmd_run(args):
    cfg = load_config()
    task = build_task(args)

    cipher = get_cipher(task.algorithm, cfg, attack=task.attack)
    solver = KissatSolver(cfg.solver_path(), max_retries=cfg.solver_max_retries())
    ctx = Ctx(cfg, task, cipher, solver)

    print(task.display())
    model_cls = get_model(task.model)
    kwargs = {}
    if task.model == "LIN":
        # 线性模型的精确权重限制搜索开关（auto = 按成本闸自动决定）
        kwargs["refine"] = {"auto": "auto", "on": True, "off": False}[args.lin_refine]
    result = model_cls().run_search(ctx, **kwargs)

    if result:
        pwb = result.get("prob_weight_bound")
        if pwb is not None:
            print("\nProbWeightBound:", pwb)
            print("pBound:        ", result.get("p_bound"))
            print("qBound:        ", result.get("q_bound"))
        # LIN：活跃 S 盒数（prob_weight_bound）之外再打线性权重界与路径精确权重
        weight_bound = result.get("linear_weight_bound")
        if weight_bound is not None:
            print("ActiveSBoxBound:", result.get("active_sbox_bound"))
            print("LinearWeightBound(6×active):", weight_bound)
            exact = result.get("linear_weight_exact")
            if exact is not None:
                print("LinearWeightExact(per round):", exact)
            final = result.get("linear_weight_exact_final")
            if final is not None:
                print("LinearWeightExact(final):", final, "(最优)" if result.get("linear_optimal", [False])[-1] else "")
        t = result.get("total_solve_time")
        if t is not None:
            print(f"Total SAT solve time: {t:.2f}s")


def cmd_convert_data(args):
    """把数据目录下所有 S 盒约束 txt 转换为 .pkl（差分 *_S-Box_Consts.txt +
    线性 *_S-Box_Linear_Consts.txt）。pkl 只是加载加速，txt 仍是权威源。"""
    esc_dir = args.dir
    if not os.path.isdir(esc_dir):
        sys.exit(f"目录不存在: {esc_dir}")
    txt_files = sorted(set(
        glob.glob(os.path.join(esc_dir, "*_S-Box_Consts.txt")) +
        glob.glob(os.path.join(esc_dir, "*_S-Box_Linear_Consts.txt"))
    ))
    if not txt_files:
        print(f"{esc_dir} 下没有 *_S-Box_Consts.txt / *_S-Box_Linear_Consts.txt")
        return
    for txt in txt_files:
        with open(txt, "r", encoding="utf-8") as f:
            entries = ast.literal_eval(f.read())
        pkl = txt.rsplit(".", 1)[0] + ".pkl"
        with open(pkl, "wb") as f:
            pickle.dump(entries, f)
        print(f"{os.path.basename(txt)}: {len(entries)} entries -> {os.path.basename(pkl)}")


def main():
    parser = argparse.ArgumentParser(prog="bca", description="BCA 分组密码差分路径搜索")
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="运行一个搜索任务")
    p_run.add_argument("--task", default=None, help="任务名（输出目录名），默认 default")
    p_run.add_argument("--cipher", help="算法名，如 SM4")
    p_run.add_argument("--model", help="模型名，如 MAP / MDW / AS / LIN（LIN = 线性，配 --attack linear）")
    p_run.add_argument("--rounds", type=str, help="轮数范围，如 1-8")
    p_run.add_argument("--attack", choices=["differential", "linear"],
                       help="攻击类型（默认 differential；linear 换用 LAT 数据 "
                            "*_S-Box_Linear_Consts，搜索链路不变）")
    p_run.add_argument("--lin-refine", choices=["auto", "on", "off"], default="auto",
                       help="LIN 模型的精确权重限制搜索：auto（默认，按成本闸自动）"
                            " / on（强制） / off（关，只给下界）")
    p_run.add_argument("--timeout", type=int, help="单次 SAT 求解超时（秒），不设则无限")
    p_run.add_argument("--sat-jobs", type=int,
                       help="同概率权重下多格并行的并发上限（给并行模型用的接口；"
                            "本包收录的三个模型都是串行求解，该项当前无效果）")
    p_run.set_defaults(func=cmd_run)

    p_conv = sub.add_parser("convert-data", help="espresso txt → pkl")
    p_conv.add_argument("--dir", default="data/espresso", help="espresso 数据目录")
    p_conv.set_defaults(func=cmd_convert_data)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
