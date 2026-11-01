"""
模型注册表：CLI 按名字解析模型类。

当前收录四个模型（每个模型的 run_search 完全自由，框架不约束其内部结构）：

- MAP  w7 变量体系（每 S-box 7 个权重变量），单界数组驱动；
- MDW  Matsui 双界 + ImpossibleBound 组合跳过，复用 MAP 的 compute_weight_bound；
- AS   ActiveSBoxBound 递增（q 无乘子变体，p 序列编码关）；
- LIN  线性（Matsui）分析：搜索复用 AS，数据换 LAT（attack=linear），
       搜完逐盒查 |LAT| 回填精确线性权重。

模型之间只有一处复用：MDW 依赖 models.map 的界计算、LIN 依赖 models.as_model
的主循环（都只调用，不改写）。
"""

from .base import ModelBase
from .map import MAPModel
from .mdw import MDWModel
from .as_model import ASModel
from .linear import LINModel

MODEL_REGISTRY = {
    "MAP": MAPModel,
    "MDW": MDWModel,
    "AS": ASModel,
    "LIN": LINModel,
}


def get_model(name):
    if name not in MODEL_REGISTRY:
        raise KeyError(f"未知模型: {name}，可选: {sorted(MODEL_REGISTRY)}")
    return MODEL_REGISTRY[name]


__all__ = ["ModelBase", "MAPModel", "MDWModel", "ASModel", "LINModel",
           "MODEL_REGISTRY", "get_model"]
