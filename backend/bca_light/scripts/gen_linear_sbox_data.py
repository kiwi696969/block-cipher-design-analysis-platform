#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 S 盒 LAT 生成**线性分析**的 S-box 约束数据（与差分 espresso 数据同格式）。

为什么需要它
------------
BCA_Light 的搜索引擎把每个 S 盒上一层的「可达转移」编码成一组**禁止模式**
子句（`data/espresso/{NAME}_S-Box_Consts.txt`，18 列列表）。攻击类型由
`CipherBase.attack` 决定，`bca/util/espresso.py: load_sbox_constraints` 会
按后缀挑文件：

    差分 differential → {NAME}_S-Box_Consts.{txt,pkl}         （DDT 侧，espresso 离线产出）
    线性 linear       → {NAME}_S-Box_Linear_Consts.{txt,pkl}  （LAT 侧，**本脚本产出**）

差分侧的文件是 espresso 逻辑最小化器的输出，本仓库里没有 espresso；线性侧
不需要它 —— 直接按定义构造禁止模式集合即可，规模足够小（SM4 约 4.6k 条，
比差分侧的 8.6k 还少）。

⚠️ **掩码约定（关键）**：BCA 的掩码是**物理 SM4 掩码的「整体 32 位反转」**
（模型位 j = 物理位 31−j）。这一条是实测确定的，不是猜的：
`bca/cipher/sm4.py` 把 L 写成模型坐标下的**右**旋 `out[j] ⊕= in[(j+shift)%32]`，
经全局反转后正是 SM4 物理的**左**旋；`outputs/BCA后端核对/probe-bit-order.py`
穷举 4 种位序 × 4 种 S 盒变体，只有「整体 32 位反转 + 真 SM4」命中（p ≈ 2^-5.94），
其余 15 种全是 0。

所以本脚本算完 LAT 后，**两个轴都要做 8 位反转**（`to_model_convention`）：
模型掩码 a ↔ 物理掩码 `rev8(a)`，约束必须写成 `LAT_S[rev8(a)][rev8(b)] ≠ 0`。
差分侧 `SM4_S-Box_Consts.txt` 同样是这个约定（本仓库已实测：它的可用集 ==
`{(a,b) : DDT_S[rev8(a)][rev8(b)] ≠ 0}`）。**不转就会拿「位反转过的 S 盒」当 S 盒用。**

产出内容
--------
1. **零相关禁止**：`LAT[a][b] == 0` 且 `(a,b) ≠ (0,0)` 的每一对，各一条 16 位
   全指定子句。等价于「线性层的 S 盒只允许 LAT 非零的掩码对」。
   （注意 `a = 0, b ≠ 0` 与 `a ≠ 0, b = 0` 的 LAT 恒为 0，因此「不活跃」
   只能是 `(a,b) = (0,0)`，自动成立。）
2. **活跃指示 q 与 (a,b) 严格等值**（q=1 ⟺ 该 S 盒在这一层被激活）：
   - 禁止 `q = 0 ∧ 第 i 位 = 1`：16 条（8 输入位 + 8 输出位）
   - 禁止 `(a,b) = (0,0) ∧ q = 1`：1 条
3. **权重指示 p 恒 0**（一条 `-p`）：差分侧 p 表示「DDT=2 ⇒ 权重 7」的
   S 盒；线性侧单盒权重 = −log₂(corr²) = 14 − 2·log₂|LAT|，SM4/AES 取值
   为 6 / 6.39 / 6.83 / 7.36 / 8 / 8.83 / 10 / 12（8 档、多数非整数），
   **没有** 6/7 两档的整数结构。平台对外统一的线性口径是
   「max|LAT| = 16 ⇒ corr = 2⁻³ ⇒ 平方相关 2⁻⁶ ⇒ 每活跃盒 6 bit」，
   与本文件的 `p ≡ 0` 一致 ⇒ 模型报出的权重 = 6 × 活跃 S 盒数
   （真实最小权重的**下界**）。该特征自身的**精确**权重由
   `bca/util/linweight.py` + `models/linear.py` 逐盒查 LAT 回填。

列语义（与 `bca/util/espresso.py: write_sbox_clauses` 完全一致）
--------------------------------------------------------------
    col 0..7   输入掩码位 Γin    col 8..15  输出掩码位 Γout
    col 16     p                 col 17     q
    1 → 子句含 -var（该位取 1 被本条禁止）
    0 → 子句含 +var（该位取 0 被本条禁止）
    9 → 不关心
位序：下标 k = 第 k 个比特（LSB-first），与 `util/path.py: bits_hex` 一致。

用法
----
    python3 scripts/gen_linear_sbox_data.py                  # SM4 + AES
    python3 scripts/gen_linear_sbox_data.py --only SM4
    python3 scripts/gen_linear_sbox_data.py --check          # 只校验已有文件，不写
"""

import argparse
import io
import json
import math
import os
import pickle
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BCA_ROOT = os.path.dirname(HERE)                       # backend/bca_light
REPO_ROOT = os.path.dirname(os.path.dirname(BCA_ROOT))
DEFAULT_SBOX_JS = os.path.join(REPO_ROOT, "frontend", "src", "core", "sbox.js")
DEFAULT_OUT = os.path.join(BCA_ROOT, "data", "espresso")

# 支持线性的算法 → S 盒在 frontend/src/core/sbox.js 里的键
# （Rijndael256 的 DATA_NAME = "AES"，共用 AES 数据；DBlock 的 S 盒仓库里没有）
CIPHER_SBOX_KEY = {
    "SM4": "sm4",
    "AES": "aes",
}


# ---------------------------------------------------------------------------
# S 盒读取
# ---------------------------------------------------------------------------

def load_builtin_sbox(js_path, key):
    """从 frontend/src/core/sbox.js 的 BUILTIN_SBOXES 里取一张 8bit S 盒。

    与种子迁移（analysis/migrations/0002_seed_builtin_sboxes.py）同源同手法：
    **脚本抽取，不手抄 256 字节**。
    """
    text = io.open(js_path, encoding="utf-8").read()
    m = re.search(rf"\n\s*{re.escape(key)}:\s*\{{(.*?)\n\s*\}},", text, re.S)
    if not m:
        raise SystemExit(f"在 {js_path} 里找不到 S 盒条目 '{key}'")
    body = m.group(1)
    mt = re.search(r"table:\s*\[(.*?)\]", body, re.S)
    if not mt:
        raise SystemExit(f"S 盒 '{key}' 没有 table 字段")
    vals = [int(x, 16) for x in re.findall(r"0x[0-9a-fA-F]+", mt.group(1))]
    if len(vals) != 256:
        raise SystemExit(f"S 盒 '{key}' 长度 {len(vals)} ≠ 256（只支持 8bit 盒）")
    if sorted(vals) != list(range(256)):
        raise SystemExit(f"S 盒 '{key}' 不是置换（{len(set(vals))} 个互异值）")
    return vals


# ---------------------------------------------------------------------------
# LAT
# ---------------------------------------------------------------------------

def compute_lat(table, nbits=8):
    """按定义算 LAT：lat[a][b] = #{x : parity(a&x) == parity(b&S(x))} − 2^(n−1)。

    朴素实现（双循环 + 逐点奇偶），与前端 `SBox.getLAT()`（Walsh-Hadamard）
    算法不同 —— 独立复核脚本用 WHT 再算一遍对拍。
    """
    size = 1 << nbits
    half = size >> 1
    par = [bin(v).count("1") & 1 for v in range(size)]
    # 预置奇偶位向量：par_rows[a][x] = parity(a & x)、par_sbox[b][x] = parity(b & S(x))
    par_rows = [bytes(par[a & x] for x in range(size)) for a in range(size)]
    par_sbox = [bytes(par[b & table[x]] for x in range(size)) for b in range(size)]
    lat = [[0] * size for _ in range(size)]
    for a in range(size):
        row_a = par_rows[a]
        out = lat[a]
        for b in range(size):
            row_b = par_sbox[b]
            cnt = 0
            for x in range(size):
                if row_a[x] == row_b[x]:
                    cnt += 1
            out[b] = cnt - half
    return lat, half


# ---------------------------------------------------------------------------
# 子句构造
# ---------------------------------------------------------------------------

def bits_of(value, nbits=8):
    """整数的位模式：下标 k = 第 k 位（LSB-first）。9 = 不关心不用在这里。"""
    return [(value >> k) & 1 for k in range(nbits)]


def rev8(v):
    """8 位反转。"""
    r = 0
    for k in range(8):
        if (v >> k) & 1:
            r |= 1 << (7 - k)
    return r


def to_model_convention(lat, nbits=8):
    """把 LAT 的两个轴都做位反转 —— 对齐 BCA 模型/子句数据的掩码约定。

    为什么必须转：BCA 的掩码是**物理掩码的「整体 32 位反转」**（模型位 j = 物理位
    31−j）。证据：`bca/cipher/sm4.py` 的 L 写成 `out[j] ⊕= in[(j+shift)%32]`（模型
    坐标下的**右**旋），经全局反转后正是 SM4 物理的**左**旋 `x⊕x<<<2⊕x<<<10⊕…`；
    且 `outputs/BCA后端核对/probe-bit-order.py` 实测「整体 32 位反转 + 真 SM4」才
    命中（p ≈ 2^-5.94），其余 15 种组合全 0。

    因此模型掩码 a ↔ 物理掩码 rev8(a)；S 盒约束必须写成
    `LAT_S[rev8(a)][rev8(b)] ≠ 0` 才等价于真实的「物理 S 盒 LAT 非零」。
    差分数据 `SM4_S-Box_Consts.txt` 也是这个约定（同样两轴反转过）。
    """
    size = 1 << nbits
    return [[lat[rev8(a)][rev8(b)] for b in range(size)] for a in range(size)]


def build_entries(lat, nbits=8):
    """构造线性 S 盒的 18 列禁止模式表。"""
    size = 1 << nbits
    entries = []

    # ---- 1. 零相关禁止 ----
    for a in range(size):
        ba = bits_of(a, nbits)
        for b in range(size):
            if (a == 0 and b == 0) or lat[a][b] != 0:
                continue
            entries.append(ba + bits_of(b, nbits) + [9, 9])

    # ---- 2. q ⟺ (a,b) ≠ (0,0) ----
    # 2a. 禁止 q=0 ∧ 第 i 位 = 1
    for i in range(2 * nbits):
        pat = [9] * (2 * nbits)
        pat[i] = 1
        entries.append(pat + [9, 0])          # q 取 0 → 子句含 +q
    # 2b. 禁止 (a,b)=(0,0) ∧ q=1
    entries.append([0] * (2 * nbits) + [9, 1])   # q 取 1 → 子句含 -q

    # ---- 3. p ≡ 0（线性不做 6/7 分档，见文件头） ----
    entries.append([9] * (2 * nbits) + [1, 9])

    return entries


def check_entries(lat, entries, nbits=8):
    """自检：把 entries 当作「禁止模式」，验证它诱导出的允许集 == 理想关系。

    做法：18 位点空间（16 位掩码 + p + q）共 2^18 个格，先把全空间标为
    「允许」，再逐条子句把它覆盖的立方体（未指定位取遍）标为「禁止」；
    最后与理想关系逐点比较。反向标比「逐点查子句」快几个数量级。
    """
    npoints = 1 << (2 * nbits + 2)
    forbidden = bytearray(npoints)
    for e in entries:
        # 展开该模式的未指定（9）位，枚举立方体内全部点
        free = [i for i, z in enumerate(e) if z == 9]
        base = 0
        for i, z in enumerate(e):
            if z == 1:
                base |= (1 << i)
        for mask in range(1 << len(free)):
            pt = base
            for k, idx in enumerate(free):
                if (mask >> k) & 1:
                    pt |= (1 << idx)
            forbidden[pt] = 1

    size = 1 << nbits
    bad = 0
    for a in range(size):
        for b in range(size):
            ideal_ok_pair = (a, b) == (0, 0) or lat[a][b] != 0
            ideal_q = 0 if (a, b) == (0, 0) else 1
            for p in (0, 1):
                for q in (0, 1):
                    pt = a | (b << nbits) | (p << (2 * nbits)) | (q << (2 * nbits + 1))
                    allowed = not forbidden[pt]
                    want = ideal_ok_pair and (q == ideal_q) and (p == 0)
                    if allowed != want:
                        bad += 1
                        if bad <= 5:
                            print(f"  [不一致] a={a:#04x} b={b:#04x} p={p} q={q} "
                                  f"诱导={'允许' if allowed else '禁止'} "
                                  f"期望={'允许' if want else '禁止'}")
    return bad


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def generate(name, key, js_path, out_dir, check_only=False):
    table = load_builtin_sbox(js_path, key)
    # 先按定义（物理掩码）算 LAT，再转到 BCA 模型约定（两轴位反转，见 to_model_convention）
    lat_phys, half = compute_lat(table)
    lat = to_model_convention(lat_phys)
    entries = build_entries(lat)

    max_abs = max(abs(lat[a][b]) for a in range(256) for b in range(256)
                  if not (a == 0 and b == 0))
    nonzero = sum(1 for a in range(256) for b in range(256)
                  if (a or b) and lat[a][b] != 0)
    zero = 65535 - nonzero

    print(f"\n=== {name} (sbox '{key}') ===")
    print(f"  掩码约定：BCA 模型 = 物理掩码整体 32 位反转（两轴 rev8）；数据已按此给出")
    print(f"  max|LAT| = {max_abs}（线性度）｜corr_max = {max_abs}/{half} "
          f"= 2^{math.log2(max_abs / half):.2f}")
    print(f"  最小单盒线性权重 = -log2(corr^2) = "
          f"{-math.log2((max_abs / half) ** 2):.2f} bit")
    print(f"  LAT 非零转移 {nonzero} / 零相关 {zero}")
    print(f"  禁止模式条数 = {len(entries)}（零相关 {zero} + q 等值 17 + p 恒 0 1）")

    bad = check_entries(lat, entries)
    if bad:
        print(f"  ✗ 自检失败：{bad} 个点与理想关系不符")
        return False
    print("  ✓ 自检通过：子句诱导的允许集 == { (0,0,0,0) } ∪ { (a,b)≠(0,0), LAT≠0, q=1, p=0 }")

    if check_only:
        return True

    txt_path = os.path.join(out_dir, f"{name}_S-Box_Linear_Consts.txt")
    pkl_path = os.path.join(out_dir, f"{name}_S-Box_Linear_Consts.pkl")
    wt_path = os.path.join(out_dir, f"{name}_S-Box_Linear_Weights.json")

    os.makedirs(out_dir, exist_ok=True)
    with io.open(txt_path, "w", encoding="utf-8") as f:
        f.write(repr(entries))
    with open(pkl_path, "wb") as f:
        pickle.dump(entries, f)
    with open(wt_path, "w", encoding="utf-8") as f:
        json.dump({
            "name": name,
            "in_bits": 8,
            "out_bits": 8,
            "half": half,
            "note": "lat_abs 为 256×256 展平的 |LAT[a][b]|，下标 = a*256+b；"
                    "a/b 为 BCA 模型掩码（= 物理掩码整体 32 位反转，两轴已 rev8）",
            "lat_abs": [abs(lat[a][b]) for a in range(256) for b in range(256)],
        }, f, separators=(",", ":"))

    print(f"  → {os.path.basename(txt_path)} ({os.path.getsize(txt_path)} B)")
    print(f"  → {os.path.basename(pkl_path)} ({os.path.getsize(pkl_path)} B)")
    print(f"  → {os.path.basename(wt_path)} ({os.path.getsize(wt_path)} B)")
    return True


def main():
    ap = argparse.ArgumentParser(description="由 S 盒 LAT 生成线性分析的 S-box 约束数据")
    ap.add_argument("--sbox-js", default=DEFAULT_SBOX_JS,
                    help="frontend/src/core/sbox.js 路径（默认自动定位）")
    ap.add_argument("--out", default=DEFAULT_OUT, help="输出目录（默认 data/espresso）")
    ap.add_argument("--only", default=None,
                    help=f"只生成指定算法，逗号分隔；可选 {','.join(CIPHER_SBOX_KEY)}")
    ap.add_argument("--check", action="store_true", help="只做自检，不写文件")
    args = ap.parse_args()

    if not os.path.isfile(args.sbox_js):
        sys.exit(f"S 盒源文件不存在：{args.sbox_js}\n用 --sbox-js 指定 frontend/src/core/sbox.js")

    names = list(CIPHER_SBOX_KEY)
    if args.only:
        names = [n.strip() for n in args.only.split(",") if n.strip()]
        unknown = [n for n in names if n not in CIPHER_SBOX_KEY]
        if unknown:
            sys.exit(f"未知算法 {unknown}；可选 {list(CIPHER_SBOX_KEY)}")

    ok = True
    for name in names:
        ok = generate(name, CIPHER_SBOX_KEY[name], args.sbox_js, args.out,
                      check_only=args.check) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
