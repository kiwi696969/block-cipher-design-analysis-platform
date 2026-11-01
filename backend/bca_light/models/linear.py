"""
LIN 模型：线性（Matsui）分析搜索。

与 AS 的关系
------------
搜索主循环**完全复用 ASModel**（`asb_bound` 递增、MILP 界、pq 体系 CNF、SAT
记录）—— 差分与线性的 CNF 结构是**攻击无关**的：生成器只消费每个 S 盒的
「禁止模式」子句，而子句只回答「哪些 (a,b) 被允许」。换攻击 = 换数据文件：

    差分 differential → {DATA_NAME}_S-Box_Consts.*        （DDT 侧）
    线性 linear       → {DATA_NAME}_S-Box_Linear_Consts.* （LAT 侧）

`load_sbox_constraints` 已按 `cipher.attack` 自动选文件，故 LIN 只需把
`task.attack` 置为 "linear"（见 main.py / bca_entry.py 的 --attack）。**不改
搜索代码** —— 这正是「同一语义不两处实现」的落地。

两级输出
--------
1. **线性权重下界**（严格）：AS 数出的活跃 S 盒数 × 单盒最小权重
   （= 14 − 2·log₂·线性度 = 6.0 bit for SM4/AES，因 max|LAT| = 16）。
   任一条特征的线性权重 ≥ 此界。平台对外统一口径即此值，SM4 32 轮
   6×113 = 678 与前端一致。

2. **精确权重（上界收紧到最优）**：单盒真实权重 = 14 − 2·log₂|LAT|，
   有 8 档（SM4：6 / 6.83 / 8 / 8.83 / 10 / 11 / 12 / 12.83），AS 只数个数、
   不认档位，SAT 又只返回**任意**一条最小活跃数解（可能落在低相关盒上）。
   为此本模型加一趟**限制搜索**：把活跃转移收窄到 |LAT| ≥ 线性度
   （即只许权重 6 的盒），重跑 AS。若最小活跃数不变，则这条特征每个活跃盒
   都达最小权重 ⇒ 权重 = 下界 ⇒ **已证最优**；否则取「基础路径 / 限制路径」
   里权重较小者（仍是精确的特征权重，只是未必全局最优）。

限制搜索写在独立任务目录 `{task}-linref`（`Ctx` 记录/产物按任务名分目录），
与基础趟互不污染、各自可断点续跑。`refine` 参数：默认 `"auto"` —— 按
`REFINE_CLAUSE_CAP` 自动决定做不做（SM4 小轮数会做；AES 这类 16 盒/轮的结构
自动跳过，只给下界）；`True` 强制做；`False` 关掉。跳过的原因回填在结果的
`linear_refine_skip_reason`。
"""

import dataclasses
import os

from bca.ctx import Ctx
from bca.util.espresso import EspressoData
from bca.util.linweight import (
    load_linear_weights,
    nonzero_abs_levels,
    parse_path_file,
    restricted_extra_entries,
    rounds_weight,
)
from models.as_model import ASModel

REFINE_SUFFIX = "-linref"

# 限制搜索的**成本闸**：追加子句数 ≈ (被禁的低相关转移数) × SBOX_COUNT × 轮数。
# 超过此上限就自动跳过（只给下界 + 基础特征权重），避免 AES 这类 16 盒/轮的结构
# 把一趟搜索拖成几十分钟。SM4（4 盒/轮）1~4 轮 ≈ 95 万条 → 会做；AES 1~4 轮
# ≈ 382 万条 → 跳过。`refine=True/False` 可强制开关。
REFINE_CLAUSE_CAP = 2_000_000


def _path_weight(path_file, weights):
    """读一条已落盘的特征路径，返回其精确线性权重（Σ−log₂(corr²)）；无文件返回 None。"""
    if not os.path.isfile(path_file):
        return None
    with open(path_file, "r", encoding="utf-8") as f:
        rows = parse_path_file(f.read())
    if not rows:
        return None
    _per_round, total = rounds_weight(rows, weights)
    return round(total, 4)


class LINModel(ASModel):
    """LIN：活跃 S 盒增量搜索（复用 AS）+ 限制搜索把精确权重收紧到最优。"""

    name = "LIN"

    def run_search(self, ctx, refine="auto"):
        if ctx.cipher.attack != "linear":
            raise ValueError(
                "LIN 模型只用于线性攻击：请以 attack=linear 运行"
                "（差分请用 MAP / MDW / AS）")

        # —— 1) 复用 AS 的活跃 S 盒搜索（attack=linear 已让 esc_data = LAT 约束）——
        base = super().run_search(ctx)

        weights = load_linear_weights(ctx.cipher, ctx.cfg.espresso_dir())
        min_box = weights.min_box_weight()
        levels = nonzero_abs_levels(weights)
        top = levels[0] if levels else None

        # 每轮最优权重：先放基础趟结果
        best_weight = {}
        weight_source = {}
        for s in base["rounds"]:
            r = s["round"]
            best_weight[r] = _path_weight(ctx.path_path(r, s["asb"]), weights)
            weight_source[r] = "as"

        # —— 2) 限制搜索：只许 |LAT| = 线性度 的活跃盒，尝试把权重压到下界 ——
        refined = False
        skip_reason = None
        if refine and top is not None:
            extra = restricted_extra_entries(weights, top)
            n_rounds = len(base["rounds"])
            extra_est = len(extra) * ctx.cipher.SBOX_COUNT * n_rounds
            if refine == "auto" and extra_est > REFINE_CLAUSE_CAP:
                skip_reason = (f"限制搜索预估追加 {extra_est} 条子句 > 上限 "
                               f"{REFINE_CLAUSE_CAP}（改 refine=True 可强制）")
            else:
                orig = ctx.cipher.esc_data
                try:
                    ctx.cipher.esc_data = EspressoData(
                        list(orig.entries) + extra,
                        source_path=getattr(orig, "source_path", "") + "#restricted")
                    ref_task = dataclasses.replace(
                        ctx.task, name=ctx.task.name + REFINE_SUFFIX)
                    ref_ctx = Ctx(ctx.cfg, ref_task, ctx.cipher, ctx.solver)
                    ref = super().run_search(ref_ctx)
                    for s in ref["rounds"]:
                        r = s["round"]
                        w = _path_weight(ref_ctx.path_path(r, s["asb"]), weights)
                        if w is not None and (best_weight.get(r) is None
                                              or w < best_weight[r]):
                            best_weight[r] = w
                            weight_source[r] = "restricted"
                    refined = True
                finally:
                    ctx.cipher.esc_data = orig

        # —— 3) 汇总 ——
        rounds_out = []
        for s in base["rounds"]:
            r = s["round"]
            asb = s["asb"]
            bound = round(asb * min_box, 4)
            exact = best_weight.get(r)
            # 精确 == 下界 ⇒ 该权重已达理论最小 ⇒ 最优
            optimal = exact is not None and abs(exact - bound) < 1e-6
            rounds_out.append({
                **s,
                "active_sboxes": asb,
                "linear_weight_bound": bound,
                "linear_weight_exact": exact,
                "linear_optimal": optimal,
                "weight_source": weight_source.get(r),
            })

        exacts = [s["linear_weight_exact"] for s in rounds_out
                  if s["linear_weight_exact"] is not None]
        result = dict(base)
        result.update({
            "attack": "linear",
            "min_box_weight": round(min_box, 4),
            "linear_refined": refined,
            "linear_refine_skip_reason": skip_reason,
            "active_sbox_bound": [s["active_sboxes"] for s in rounds_out],
            "linear_weight_bound": [s["linear_weight_bound"] for s in rounds_out],
            "linear_weight_exact": [s["linear_weight_exact"] for s in rounds_out],
            "linear_weight_exact_final": exacts[-1] if exacts else None,
            "linear_optimal": [s["linear_optimal"] for s in rounds_out],
            "rounds": rounds_out,
        })
        return result
