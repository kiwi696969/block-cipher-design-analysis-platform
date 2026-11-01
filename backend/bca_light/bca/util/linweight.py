"""
线性（Matsui）路径的**精确权重**回填。

背景：搜索引擎只用「活跃 S 盒计数」这一档整数权重（q 变量），因为线性侧单盒
权重 −log₂(corr²) = 14 − 2·log₂|LAT| 在 SM4/AES 上有 8 档（6 / 6.39 / 6.83 /
7.36 / 8 / 8.83 / 10 / 12），多数非整数，塞不进「p 取 0/1」的 6/7 分档结构。
所以 LIN 模型先按活跃计数搜出特征，再用本模块逐盒查 LAT **回填真实权重**。

数据来源：scripts/gen_linear_sbox_data.py 生成的
    {DATA_NAME}_S-Box_Linear_Weights.json
    { "lat_abs": [ |LAT[a][b]| ... ]（256×256 展平，下标 = a*256+b）, "half": 128 }
与 S 盒约束数据同源（同一张 S 盒的 LAT），但**独立于子句**——子句只回答
「哪些 (a,b) 被允许」，本表回答「允许的那些各值多少」。

⚠️ **掩码约定**：这里的 a/b 是 **BCA 模型掩码** = 物理掩码整体 32 位反转
（模型位 j = 物理位 31−j，见 `scripts/gen_linear_sbox_data.py` 的说明与
`outputs/BCA后端核对/probe-bit-order.py`）。表在生成时已把两轴各做 8 位反转，
所以 `abs_lat(a, b)` 直接吃路径文件里打印的掩码整数即可，与本模型其余部分一致。

公式（8bit 盒，half = 2^7）：
    corr = LAT / half        （Walsh 系数 / 2^(n−1)）
    weight = −log₂(corr²) = 2·log₂(half) − 2·log₂|LAT| = 14 − 2·log₂|LAT|
max|LAT| = 16 ⇒ 单盒最小权重 = 14 − 8 = 6.0，与平台「每活跃盒 6 bit」口径一致。
"""

import json
import math
import os
import re

# 进程内缓存：{绝对路径: weights dict}
_CACHE = {}

# `details/path/R{r}-P{prob}.txt` 里 sbox 行的解析（见 util/path.py: format_path）
_SBOX_RE = re.compile(
    r"^\s*sbox\s+(\d+):\s*p=(\d+)\s+q=(\d+)\s+in=(0x[0-9A-Fa-f]+)\s+out=(0x[0-9A-Fa-f]+)\s*$"
)


class LinearWeights:
    """一张 S 盒的 |LAT| 表（回填线性权重用）。"""

    def __init__(self, name, lat_abs, half, in_bits=8, out_bits=8, source_path=""):
        self.name = name
        self.lat_abs = lat_abs
        self.half = half
        self.in_bits = in_bits
        self.out_bits = out_bits
        self.source_path = source_path
        self._size = 1 << in_bits

    def abs_lat(self, a, b):
        return self.lat_abs[(a << self.in_bits) + b]

    def box_weight(self, a, b):
        """单个 S 盒的精确线性权重；LAT 为 0（不可能出现在合法路径上）返回 None。"""
        v = self.abs_lat(a, b)
        if v == 0:
            return None
        return 2.0 * math.log2(self.half) - 2.0 * math.log2(v)

    def min_box_weight(self):
        """该 S 盒能达到的最小单盒权重（= 14 − 2·log₂·线性度）。

        注意排除平凡对 (a,b)=(0,0)：LAT[0][0] = 2^(n−1)（相关系数 1），
        它的 |LAT| 比线性度大得多，会污染最大值。
        """
        size = self._size
        mx = max(self.lat_abs[(a << self.in_bits) + b]
                 for a in range(size) for b in range(size)
                 if not (a == 0 and b == 0))
        return 2.0 * math.log2(self.half) - 2.0 * math.log2(mx)


def load_linear_weights(cipher, espresso_dir):
    """按算法的 DATA_NAME 加载线性权重表（进程内缓存）。"""
    data_name = cipher.DATA_NAME or cipher.NAME
    path = os.path.join(espresso_dir, f"{data_name}_S-Box_Linear_Weights.json")
    key = os.path.abspath(path)
    if key in _CACHE:
        return _CACHE[key]
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"线性权重表缺失：{path}（用 scripts/gen_linear_sbox_data.py 生成）")
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    obj = LinearWeights(
        name=raw.get("name", data_name),
        lat_abs=raw["lat_abs"],
        half=raw["half"],
        in_bits=raw.get("in_bits", 8),
        out_bits=raw.get("out_bits", 8),
        source_path=path,
    )
    _CACHE[key] = obj
    return obj


def parse_path_file(text):
    """`details/path/R{r}-P{prob}.txt` → [ {round, sboxes:[{i,p,q,din,dout}]} ]。

    din/dout 解析为整数掩码（a = 输入掩码，b = 输出掩码）。
    """
    rounds = []
    cur = None
    for line in text.splitlines():
        m = _SBOX_RE.match(line)
        if m:
            if cur is None:
                cur = {"round": None, "sboxes": []}
            cur["sboxes"].append({
                "i": int(m.group(1)),
                "p": int(m.group(2)),
                "q": int(m.group(3)),
                "din": int(m.group(4), 16),
                "dout": int(m.group(5), 16),
            })
            continue
        m2 = re.match(r"^\s*Round\s+(\d+):\s*$", line)
        if m2:
            if cur is not None and cur["sboxes"]:
                rounds.append(cur)
            cur = {"round": int(m2.group(1)), "sboxes": []}
    if cur is not None and cur["sboxes"]:
        rounds.append(cur)
    return rounds


def rounds_weight(rows, weights):
    """逐轮精确线性权重：Σ 活跃盒 −log₂(corr²)。

    Args:
        rows: parse_path_file 的输出
        weights: LinearWeights 实例

    Returns:
        (per_round: [ {round, active, weight, unknown} ], total_weight)
        - active: 活跃 S 盒数（q=1）
        - weight: 该轮 Σ box_weight（活跃盒之和）
        - unknown: 该轮 LAT=0（异常）的盒数，正常应为 0
    """
    out = []
    total = 0.0
    for row in rows:
        w = 0.0
        active = 0
        unknown = 0
        for s in row["sboxes"]:
            if not s["q"]:
                continue
            active += 1
            bw = weights.box_weight(s["din"], s["dout"])
            if bw is None:
                unknown += 1
            else:
                w += bw
        total += w
        out.append({"round": row["round"], "active": active,
                    "weight": w, "unknown": unknown})
    return out, total


def bits_of(value, nbits):
    """整数 → 位模式（下标 k = 第 k 位，LSB-first，与 util/espresso.py 列序一致）。"""
    return [(value >> k) & 1 for k in range(nbits)]


def nonzero_abs_levels(weights):
    """该 S 盒所有「非平凡」|LAT| 的不同取值，**降序**（= 线性权重升序的档位）。

    SM4/AES：{16, 14, 12, 10, 8, 6, 4, 2}；最优路径通常用最大那档（16 ⇒ 单盒 6 bit）。

    注意排除下标 0（即 (a,b)=(0,0)）：它的 |LAT| = 2^(n−1)（相关系数 1），
    不是「转移」，若混入会把最大档抬成 128，导致限制搜索禁光所有转移。
    """
    return sorted({v for i, v in enumerate(weights.lat_abs) if v and i != 0},
                  reverse=True)


def restricted_extra_entries(weights, min_abs_lat):
    """构造「只许高相关转移」的追加禁止子句：活跃盒 |LAT| < min_abs_lat 一律禁。

    与基础 S 盒约束同格式（18 列），可直接拼到 EspressoData.entries 后面：
        ctx.cipher.esc_data = EspressoData(base.entries + extra, ...)

    语义：收窄活跃转移集合后，搜索求出的任何路径仍是**真实特征**（只是可选
    转移变少），因此可作为精确权重的上界改进 —— 若限制后最小活跃数不变，
    则该路径每个活跃盒都是 |LAT| ≥ min_abs_lat，权重即达下界（最优）。
    取 min_abs_lat = 线性度（max|LAT|）即「只许权重最小的盒」。

    注意：子句只禁 (a,b) 掩码对本身（q 侧由基础 q-等值子句强制为 1），
    不碰 (0,0) 不活跃情形。
    """
    n = weights.in_bits
    size = 1 << n
    extra = []
    for a in range(size):
        for b in range(size):
            if a == 0 and b == 0:
                continue          # 平凡对（不活跃）永不禁
            v = weights.abs_lat(a, b)
            if v == 0 or v >= min_abs_lat:
                continue
            extra.append(bits_of(a, n) + bits_of(b, n) + [9, 1])  # 禁「该对 + q=1」
    return extra
