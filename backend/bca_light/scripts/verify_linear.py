#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""线性（LAT）S 盒数据的**独立复核** —— 与生成脚本不同源、不同法。

为什么需要它
------------
`scripts/gen_linear_sbox_data.py` 自己算 LAT、自己造子句、自己自检 —— 三段都
出自同一份实现，「算错了但自洽」是抓不出来的。本脚本换一套算法再走一遍：

* LAT：**Walsh–Hadamard 变换**（生成脚本用的是定义式双循环）。
  WHT 给出 (a,b) 的双极相关系数之和 = 2×LAT_def，因此比对关系是
  `wht(a,b) == 2 · |LAT[a][b]|`。
* 子句：线性文件（4608 条，多数全指定）用**逐点正向判定**「是否存在一条子句被
  违反」—— 与生成脚本的反向立方体标记**不同源**；差分文件（espresso 输出，8599
  条全是带 don't-care 的立方体）改用**反向立方体标记**（逐点扫描要 200s+，标记
  法 0.1s，两者已对拍等价）。子句语义取自 `bca/util/espresso.py: write_sbox_clauses`：
  entry[i]=1 → 子句含 -var，取 var=1 即违反；=0 → 含 +var，取 0 违反；=9 → 不关心。
  于是「一条子句被违反 ⟺ 所有已指定列都等于 entry 值」。
* 权重表：拿 WHT 的 LAT 反算单盒权重 14 − 2·log₂|LAT|，与 JSON 表对拍。
* 交叉锚：线性数据与差分数据的**可用掩码集**分别 == 各自理想关系（LAT/DDT，
  两轴同用 rev8）⇒ 两套数据落在同一掩码约定上（BCA 全栈的硬性要求）。

三种运行
--------
    python3 scripts/verify_linear.py                 # 只做数据复核（纯 Python）
    python3 scripts/verify_linear.py --only SM4
    python3 scripts/verify_linear.py --search        # 追加端到端搜索断言（需 gurobi/kissat）

退出码：0 = 全部通过；1 = 有断言失败。
"""

import argparse
import ast
import io
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BCA_ROOT = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(os.path.dirname(BCA_ROOT))
DEFAULT_SBOX_JS = os.path.join(REPO_ROOT, "frontend", "src", "core", "sbox.js")
ESPRESSO_DIR = os.path.join(BCA_ROOT, "data", "espresso")

CIPHER_SBOX_KEY = {"SM4": "sm4", "AES": "aes"}

# 基准锚点（与前端线性引擎的 SM4 前四轮一致：1 活跃盒 × 6 bit = 6.00）
ANCHORS = {
    "SM4": {"rounds": [1, 2, 3, 4], "active": [0, 0, 0, 1],
            "weight_bound": [0.0, 0.0, 0.0, 6.0]},
}

_fail = []


def check(cond, msg):
    tag = "✓" if cond else "✗"
    print(f"  {tag} {msg}")
    if not cond:
        _fail.append(msg)
    return cond


# ---------------------------------------------------------------------------
# S 盒读取（独立于生成脚本，重新抽取）
# ---------------------------------------------------------------------------

def load_sbox_js(js_path, key):
    text = io.open(js_path, encoding="utf-8").read()
    block = re.search(rf"\n\s*{re.escape(key)}:\s*\{{(.*?)\n\s*\}},", text, re.S)
    if not block:
        raise SystemExit(f"{js_path} 找不到 '{key}'")
    table = re.search(r"table:\s*\[(.*?)\]", block.group(1), re.S)
    vals = [int(x, 16) for x in re.findall(r"0x[0-9a-fA-F]+", table.group(1))]
    if len(vals) != 256 or sorted(vals) != list(range(256)):
        raise SystemExit(f"'{key}' 不是 8bit 置换")
    return vals


# ---------------------------------------------------------------------------
# WHT 求 LAT
# ---------------------------------------------------------------------------

def fwht(vec):
    """原地快速 Walsh–Hadamard（不加归一化）。返回新列表。"""
    a = list(vec)
    h = 1
    n = len(a)
    while h < n:
        for i in range(0, n, h * 2):
            for j in range(i, i + h):
                x, y = a[j], a[j + h]
                a[j] = x + y
                a[j + h] = x - y
        h *= 2
    return a


def lat_via_wht(table):
    """WHT 版 LAT：lat2[a][b] = Σ_x (−1)^{par(a&x) ⊕ par(b&S(x))}（= 2×定义式 LAT）。"""
    par = [bin(v).count("1") & 1 for v in range(256)]
    lat2 = [[0] * 256 for _ in range(256)]
    for b in range(256):
        col = [1 if par[b & table[x]] == 0 else -1 for x in range(256)]
        h = fwht(col)
        for a in range(256):
            lat2[a][b] = h[a]
    return lat2


def rev8(v):
    r = 0
    for k in range(8):
        if (v >> k) & 1:
            r |= 1 << (7 - k)
    return r


def to_model_convention(lat2):
    """物理 LAT → BCA 模型约定（两轴各 8 位反转）。理由见 gen_linear_sbox_data.py。"""
    return [[lat2[rev8(a)][rev8(b)] for b in range(256)] for a in range(256)]


# ---------------------------------------------------------------------------
# 子句正向判定
# ---------------------------------------------------------------------------

def build_clause_index(entries):
    """把子句拆成「全掩码子句」（16 位掩码全指定）与「部分子句」两类，加速逐点判定。"""
    full = {}     # mask16 -> [(p_spec, q_spec)]
    partial = []  # 掩码有 9 的子句（含 p/q 约束）
    for e in entries:
        mask_cols = e[:16]
        p_spec, q_spec = e[16], e[17]
        if all(m != 9 for m in mask_cols):
            key = 0
            for i, m in enumerate(mask_cols):
                if m == 1:
                    key |= (1 << i)
            full.setdefault(key, []).append((p_spec, q_spec))
        else:
            partial.append((mask_cols, p_spec, q_spec))
    return full, partial


def is_forbidden(a, b, p, q, full, partial):
    """点 (a,b,p,q) 是否被任一子句排除（= 至少一条子句被违反）。"""
    key = a | (b << 8)
    for p_spec, q_spec in full.get(key, ()):
        if (p_spec == 9 or p_spec == p) and (q_spec == 9 or q_spec == q):
            return True
    for mask_cols, p_spec, q_spec in partial:
        ok = True
        for i, m in enumerate(mask_cols):
            if m == 9:
                continue
            bit = (a >> i) & 1 if i < 8 else (b >> (i - 8)) & 1
            if bit != m:
                ok = False
                break
        if not ok:
            continue
        if (p_spec == 9 or p_spec == p) and (q_spec == 9 or q_spec == q):
            return True
    return False


def verify_entries(entries, lat2):
    """逐点正向判定：允许集 == {(0,0,0,0)} ∪ {(a,b,0,1) : LAT≠0}。"""
    full, partial = build_clause_index(entries)
    bad = 0
    worst = None
    for a in range(256):
        for b in range(256):
            lat_nonzero = lat2[a][b] != 0
            if a == 0 and b == 0:
                want = {(0, 0, 0, 0)}
            elif lat_nonzero:
                want = {(a, b, 0, 1)}
            else:
                want = set()
            for p in (0, 1):
                for q in (0, 1):
                    allowed = not is_forbidden(a, b, p, q, full, partial)
                    if allowed != ((a, b, p, q) in want):
                        bad += 1
                        if worst is None:
                            worst = (a, b, p, q, allowed)
    return bad, worst


def forbid_bitmap(entries):
    """把「禁止模式」表展开成 2^18 点的禁止位图（**反向立方体标记**）。

    子句语义：entry[i]=1 → 该位取 1 违反；=0 → 取 0 违反；=9 → 不关心。
    于是一条子句覆盖「已指定位固定、未指定位取遍」的一个立方体，把立方体内
    全部点标 1 即完成该子句的「禁止」。

    复杂度 O(Σ 2^自由位数)：espresso 的差分数据全是带 don't-care 的立方体
    （SM4 实测 8599 条、**无一条全指定**），Σ2^nf ≈ 1.1M → 0.1s；而逐点扫描是
    O(2^18 × 子句数) ≈ 2.2e9 → 200s+。两者结果等价（已对拍）。
    """
    npoints = 1 << 18
    forb = bytearray(npoints)
    for e in entries:
        free = [i for i, z in enumerate(e) if z == 9]
        base = 0
        for i, z in enumerate(e):
            if z == 1:
                base |= 1 << i
        subs = [0]
        for idx in free:
            bit = 1 << idx
            subs += [s | bit for s in subs]
        for s in subs:
            forb[base | s] = 1
    return forb


def usable_masks(entries):
    """子句允许的「可用掩码对」集合（存在 (p,q) 未被任何子句排除）。

    走禁止位图：一个 (a,b) 只要 4 个 (p,q) 组合里有 1 个没被标禁止，就算可用。
    """
    forb = forbid_bitmap(entries)
    out = set()
    for a in range(256):
        for b in range(256):
            k = a | (b << 8)
            if not (forb[k] and forb[k | (1 << 16)]
                    and forb[k | (1 << 17)] and forb[k | (3 << 16)]):
                out.add((a, b))
    return out


def ideal_ddt_model(table):
    """模型约定下的真实 SM4 DDT 可用集：{(0,0)} ∪ {(a,b) : DDT_S[rev8 a][rev8 b] ≠ 0}。"""
    DDT = [[0] * 256 for _ in range(256)]
    for a in range(256):
        for x in range(256):
            DDT[a][table[x] ^ table[x ^ a]] += 1
    return {(a, b) for a in range(256) for b in range(256)
            if (a == 0 and b == 0) or DDT[rev8(a)][rev8(b)] != 0}


def ideal_lat_model(lat2):
    """模型约定下线性数据的理想可用集：{(0,0)} ∪ {(a,b) : LAT[rev8 a][rev8 b] ≠ 0}。

    `lat2` 是 WHT 版（双极和 = 2×LAT_def），非零 ⟺ LAT_def 非零。
    """
    return {(a, b) for a in range(256) for b in range(256)
            if (a == 0 and b == 0) or lat2[a][b] != 0}


def diff_entries_convention(diff_entries, table):
    """差分数据是否落在「模型约定（两轴 rev8）」上：可用集 == 真实 DDT。

    与 `ideal_lat_model` 合起来构成「两套数据同掩码约定」的完整证明：
      · 线性数据可用集 == 理想 LAT（模型约定）——第 3 步逐点正向判定已证；
      · 差分数据可用集 == 理想 DDT（**同一个** `rev8`）——本函数证。
    两条都在同一坐标下成立 ⇒ 差分/线性数据落在同一掩码空间，正是 BCA 全栈
    （`bca/cipher/sm4.py` 的移位方向 + 模型坐标系）所要求的不变量。

    走 `forbid_bitmap`（反向立方体标记）：差分数据 8599 条子句全是带 don't-care
    的立方体，逐点扫描 2.2e9 次（200s+），标记法 0.1s。
    """
    return usable_masks(diff_entries) == ideal_ddt_model(table)


# ---------------------------------------------------------------------------
# 单条复核
# ---------------------------------------------------------------------------

def verify_one(name, key, js_path):
    print(f"\n=== {name}（sbox '{key}'）===")
    table = load_sbox_js(js_path, key)
    # 物理 LAT（WHT）→ 转到 BCA 模型约定（两轴 8 位反转）
    lat2 = to_model_convention(lat_via_wht(table))

    wt_path = os.path.join(ESPRESSO_DIR, f"{name}_S-Box_Linear_Weights.json")
    txt_path = os.path.join(ESPRESSO_DIR, f"{name}_S-Box_Linear_Consts.txt")
    for p in (wt_path, txt_path):
        if not os.path.isfile(p):
            check(False, f"缺文件 {os.path.basename(p)}")
            return

    w = json.load(open(wt_path, encoding="utf-8"))
    lat_abs = w["lat_abs"]
    half = w["half"]

    # 1) 权重表 vs WHT（wht = 2×|LAT_def|；两边同为模型约定）
    mismatch = 0
    for a in range(256):
        for b in range(256):
            if abs(lat2[a][b]) != 2 * lat_abs[a * 256 + b]:
                mismatch += 1
    check(mismatch == 0, f"WHT|LAT|(模型约定) == 2×权重表|LAT|（不符 {mismatch} 处）")

    # 2) 线性度 + 单盒最小权重
    mx = max(abs(lat2[a][b]) for a in range(256) for b in range(256)
             if not (a == 0 and b == 0))
    min_w = 2 * math.log2(half) - 2 * math.log2(mx // 2)
    check(mx // 2 == 16, f"线性度 = {mx // 2}（期望 16）")
    check(abs(min_w - 6.0) < 1e-9, f"单盒最小权重 = {min_w:.4f} bit（期望 6.0）")

    # 3) 子句文件 vs WHT-LAT（正向逐点判定）
    with open(txt_path, encoding="utf-8") as f:
        entries = ast.literal_eval(f.read())   # 文件是 repr(list[list[int]])，同 espresso.py: _load_txt
    bad, worst = verify_entries(entries, lat2)
    check(bad == 0, f"子句诱导允许集 == 理想关系（不符 {bad} 点）"
                    + (f"，例 {worst}" if worst else ""))
    # 条数应 == 零相关对数 + 18（q 等值 16+1、p 恒 0 1），由 LAT 现算，不写死
    zero_pairs = sum(1 for a in range(256) for b in range(256)
                     if (a or b) and lat2[a][b] == 0)
    check(len(entries) == zero_pairs + 18,
          f"子句条数 = {len(entries)}（期望 {zero_pairs + 18} = 零相关 {zero_pairs} + 18）")

    # 4) 交叉锚：差分/线性两套数据同掩码约定（都按模型约定 = 两轴 rev8）
    #    4a. 线性数据可用集 == 理想 LAT（模型约定）
    lat_ok = usable_masks(entries) == ideal_lat_model(lat2)
    check(lat_ok, "线性数据可用集 == 模型约定下的真实 LAT")
    #    4b. 差分数据可用集 == 理想 DDT（模型约定）
    diff_txt = os.path.join(ESPRESSO_DIR, f"{name}_S-Box_Consts.txt")
    if os.path.isfile(diff_txt):
        with open(diff_txt, encoding="utf-8") as f:
            diff_entries = ast.literal_eval(f.read())
        same = diff_entries_convention(diff_entries, table)
        check(same, "差分数据可用集 == 模型约定下的真实 DDT（两套数据同约定）")
    else:
        check(False, f"缺差分数据 {os.path.basename(diff_txt)}，无法交叉核对约定")


# ---------------------------------------------------------------------------
# 端到端搜索断言（需 gurobi + kissat）
# ---------------------------------------------------------------------------

def verify_search(name):
    print(f"\n=== 端到端搜索 {name} 线性 ===")
    try:
        import gurobipy  # noqa: F401
    except ImportError:
        check(False, "无 gurobipy，跳过搜索断言（请在 WSL/BCA 宿主运行 --search）")
        return
    sys.path.insert(0, BCA_ROOT)

    from bca.cipher import get_cipher
    from bca.config import load_config
    from bca.ctx import Ctx
    from bca.solver import KissatSolver
    from bca.task import Task
    from models import get_model

    anchor = ANCHORS.get(name)
    rounds = anchor["rounds"] if anchor else [1, 2, 3, 4]
    cfg = load_config()
    cipher = get_cipher(name, cfg, attack="linear")
    task = Task(name=f"verify-linear-{name}", algorithm=name, model="LIN",
                round_start=rounds[0], round_end=rounds[-1], attack="linear")
    ctx = Ctx(cfg, task, cipher, KissatSolver(cfg.solver_path()))
    # 有锚点 = 要比精确权重 → 强制做限制搜索；无锚点 = 只验通用不变量 → 关掉省时
    res = get_model("LIN")().run_search(ctx, refine=bool(anchor))

    A = res["active_sbox_bound"]
    B = res["linear_weight_bound"]
    E = res["linear_weight_exact"]

    # —— 通用不变量（任何算法都该成立）——
    check(len(A) == len(rounds) and len(B) == len(rounds),
          f"结果长度 = {len(A)}/{len(B)}（期望 {len(rounds)}）")
    check(all(abs(B[i] - 6.0 * A[i]) < 1e-9 for i in range(len(A))),
          "下界 == 6 × 活跃 S 盒（每活跃盒 6 bit）")
    check(all(E[i] is None or E[i] >= B[i] - 1e-9 for i in range(len(E))),
          "精确权重 ≥ 下界（后者是严格下界）")

    # —— 有锚点的算法：逐值比对（SM4 前四轮 = 前端线性口径）——
    if anchor:
        check(A == anchor["active"],
              f"活跃 S 盒 = {A}（期望 {anchor['active']}）")
        check(B == anchor["weight_bound"],
              f"线性权重下界 = {B}（期望 {anchor['weight_bound']}）")
        check(res["linear_weight_exact_final"] == 6.0,
              f"精确权重（末轮）= {res['linear_weight_exact_final']}（期望 6.0，与前端一致）")
    else:
        print(f"  · 无基准锚点，只做通用不变量（活跃 {A} / 下界 {B} / "
              f"精确 {res['linear_weight_exact_final']}）")


def main():
    ap = argparse.ArgumentParser(description="线性 LAT / S 盒数据 / 端到端搜索 的独立复核")
    ap.add_argument("--sbox-js", default=DEFAULT_SBOX_JS)
    ap.add_argument("--only", default=None, help=f"逗号分隔，可选 {','.join(CIPHER_SBOX_KEY)}")
    ap.add_argument("--search", action="store_true", help="追加端到端搜索断言")
    args = ap.parse_args()

    names = list(CIPHER_SBOX_KEY)
    if args.only:
        names = [n.strip() for n in args.only.split(",") if n.strip()]

    for n in names:
        if n not in CIPHER_SBOX_KEY:
            sys.exit(f"未知算法 {n}；可选 {list(CIPHER_SBOX_KEY)}")
        verify_one(n, CIPHER_SBOX_KEY[n], args.sbox_js)
    if args.search:
        for n in names:
            verify_search(n)

    print()
    if _fail:
        print(f"✗ 复核失败：{len(_fail)} 项")
        for m in _fail:
            print(f"   - {m}")
        return 1
    print("✓ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
