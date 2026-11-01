"""
Cipher 基类：算法常量 + 轮函数约束生成。

设计（用户确认）：
- 轮函数约束是"一定不会改"的部分，抽成 cipher 原语，跨模型复用
- p/q 体系（AS/DW/MDW/RS 共用）与 w7 体系（MAP）各有独立的轮函数布局，
  具体布局（变量命名/索引）由各算法实现决定
- 模型通过 ctx.cipher 调用，模型不关心变量编号细节

常量由各算法子类覆盖。KNOWN_ACTIVE_SBOXES 是算法固有属性（最好已知活跃
S-box 数），任务可覆盖。
"""

from abc import ABC, abstractmethod

from ..util.espresso import load_sbox_constraints


class CipherBase(ABC):
    # ---- 算法常量（子类覆盖）----
    NAME = "Base"
    DATA_NAME = None                     # espresso 数据文件名（不含 _S-Box_Consts 后缀）；
                                        # None = 用 NAME。DBlock-128/192/256 共享 DBlock 数据
    STATE_BITS = 128
    WORD_BITS = 32
    SBOX_COUNT = 4
    SBOX_BITS = 8
    FULL_ROUNDS = 32
    HALF_BLOCK_WEIGHT_SIZE = 4          # 每轮权重变量数（p 或 q 体系）
    WEIGHT_VARS_PER_SBOX = 7            # w7 体系：每 S-box 权重变量数（MAP）
    KNOWN_ACTIVE_SBOXES = None          # [0] + 各轮最好已知活跃 S-box 数
    LINEAR_SHIFTS = []                  # 线性变换 L 的循环移位量
    SUPPORTS_W7 = True                  # 是否有 w7（MAP）参考实现；AES/Rijndael 无

    def __init__(self, cfg, attack="differential"):
        self.cfg = cfg
        self.attack = attack
        # S-box 约束数据（espresso 目录），进程内缓存，一次加载。
        # 差分攻击读 *_S-Box_Consts（DDT 侧）；线性攻击读 *_S-Box_Linear_Consts
        # （LAT 侧，由 scripts/gen_linear_sbox_data.py 生成）。数据缺失时
        # load_sbox_constraints 会按 attack 给出明确报错。
        self.esc_data = load_sbox_constraints(self, cfg.espresso_dir())

    # ------------------------------------------------------------------
    # 变量生成（每算法布局不同，由各算法实现；engine 统一调用）
    # ------------------------------------------------------------------

    def generate_variables_pq(self, pool, round_count, p_lower, p_upper, q_lower, q_upper):
        """p/q 体系变量生成。返回 (vars_dict, var_count)。vars 键含 p/q/p_aux_u/q_aux_u。"""
        raise NotImplementedError(f"{self.NAME} 未实现 generate_variables_pq")

    def generate_variables_w7(self, pool, round_count, lower_bound, upper_bound):
        """w7 体系变量生成（MAP）。返回 (vars_dict, var_count)。vars 键含 w/aux_u。"""
        raise NotImplementedError(f"{self.NAME} 未实现 generate_variables_w7（无 MAP 参考）")

    # ------------------------------------------------------------------
    # 轮函数约束（每算法实现两套布局：pq 与 w7）
    # ------------------------------------------------------------------

    @abstractmethod
    def generate_round_function_constraints(self, vars, round_count, file):
        """p/q 体系轮函数约束（AS/DW/MDW/RS 共用）。vars 为 pq 布局字典。"""

    def generate_round_function_constraints_w7(self, vars, round_count, file):
        """w7 体系轮函数约束（MAP 用）。vars 为 w7 布局字典。无 w7 参考实现的
        算法（AES/Rijndael）不实现，调用时抛错。"""
        raise NotImplementedError(f"{self.NAME} 未实现 generate_round_function_constraints_w7（无 MAP 参考）")

    # ------------------------------------------------------------------
    # 供模型使用的小工具
    # ------------------------------------------------------------------

    def total_weight_vars_per_round(self):
        """w7 体系每轮权重变量数（SBOX_COUNT × 7）。"""
        return self.SBOX_COUNT * self.WEIGHT_VARS_PER_SBOX

    def known_active_default(self):
        if self.KNOWN_ACTIVE_SBOXES is None:
            raise ValueError(f"{self.NAME} 未定义 KNOWN_ACTIVE_SBOXES")
        return self.KNOWN_ACTIVE_SBOXES
