"""
CNF 逐字节比对：BCA 生成的 CNF vs 打补丁的参考实现。

这是迁移正确性最强的验证：同一 (round, prob, p/q bounds) 参数下，变量分配、
轮函数约束、序列编码约束应与参考实现完全一致（变量编号顺序严格同参考）。

算法专用差异（各参考实现读数据的姿势不同）：
- SM4：SBOX_CONSTRAINT_FILE 打补丁为绝对路径，CNF 写到脚本 cwd（PROJECT_ROOT）
- AES：SBOX_CONSTRAINT_FILE 与 gf PLA 全部用纯文件名 → 临时 workdir symlink 数据
  文件，参考生成时 cwd 指向 workdir
- DBlock：模块级 pickle.load("DBlock_S-Box_Consts.pkl") → import 前必须先 chdir
  到含 pkl 的目录；且需把 SEARCH_MODEL 补成 "DW"（默认 RSX，不写 p 序列编码）
- Rijndael-256：参考只有变量生成 + 轮函数（无 generate_cnf_file、无序列编码）
  → 只比对轮函数约束输出（StringIO）

⚠️ 本脚本依赖本机的外部参考实现（REF_BASE 指向 ODSearch 的参考文件目录），
不属于本框架的一部分，拿到别的机器上跑之前需要先把 REF_BASE 改指到你自己的
参考实现路径。

用法：
    python scripts/verify_cnf.py                     # 全部算法
    python scripts/verify_cnf.py --cipher SM4         # 只跑 SM4
    python scripts/verify_cnf.py --cipher AES
    python scripts/verify_cnf.py --cipher DBlock-128
    python scripts/verify_cnf.py --cipher Rijndael256
"""
import argparse
import importlib.util
import os
import shutil
import sys
import tempfile
from io import StringIO

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_ESPRESSO = os.path.join(PROJECT_ROOT, "data", "espresso")
REF_BASE = "/home/Academic/projects/Fight2026/ODSearch/参考文件" \
           "（独立于项目的参考文件，非项目文件！）"

# =============================================================================
# SM4-DW 回归用例（原有）
# =============================================================================

SM4_REF = os.path.join(REF_BASE, "SM4", "SM4_HPD_Auto_Search_DW.py")

# (round_count, prob, p_lower, p_upper, q_lower, q_upper)
SM4_CASES = [
    (1, 0, [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]),
    (2, 6, [0, 0, 0, 0, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1], [1] * 8, [3] * 8),
    (3, 12, [1] * 12, [2] * 12, [2] * 12, [4] * 12),
    (3, 7, [1] * 4 + [0] * 4 + [1] * 4, [2] * 4 + [1] * 4 + [2] * 4, [1] * 12, [3] * 12),
]

# =============================================================================
# 辅助
# =============================================================================

ALL_PASS = True


def load_reference(ref_path, cwd=None):
    """加载参考模块。cwd 非 None 时先 chdir（DBlock 模块级 pickle.load 需要）。"""
    if cwd:
        os.chdir(cwd)
    spec = importlib.util.spec_from_file_location("bca_ref", ref_path)
    ref = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ref)
    return ref


def make_workdir(links):
    """临时 workdir + symlink。links: [(参考文件名, BCA data 文件名)]。"""
    workdir = tempfile.mkdtemp(prefix="verify_ref_")
    for ref_name, data_name in links:
        src = os.path.join(DATA_ESPRESSO, data_name)
        os.symlink(src, os.path.join(workdir, ref_name))
    return workdir


def bca_generate(cipher_name, round_count, p_lower, p_upper, q_lower, q_upper, prob,
                 include_p_encoding=True):
    """BCA pq 体系 CNF 生成 → (content, var_count, clause_count)。"""
    sys.path.insert(0, PROJECT_ROOT)
    os.chdir(PROJECT_ROOT)
    from bca.config import load_config
    from bca.cipher import get_cipher
    from bca.ctx import Ctx
    from bca.engine import generate_cnf_file
    from bca.solver import KissatSolver
    from bca.task import Task

    cfg = load_config()
    task = Task(name="verify-cnf", algorithm=cipher_name, model="ref",
                round_start=1, round_end=round_count)
    ctx = Ctx(cfg, task, get_cipher(cipher_name, cfg), KissatSolver(cfg.solver_path()))
    cnf_path, var_count, clause_count, _, _, _ = generate_cnf_file(
        ctx, round_count, p_lower, p_upper, q_lower, q_upper, prob,
        include_p_encoding=include_p_encoding)
    with open(cnf_path) as f:
        content = f.read()
    os.remove(cnf_path)
    return content, var_count, clause_count


def bca_generate_w7(cipher_name, round_count, lower_bound, upper_bound, prob):
    """BCA w7 体系 CNF 生成 → (content, var_count, clause_count)。"""
    sys.path.insert(0, PROJECT_ROOT)
    os.chdir(PROJECT_ROOT)
    from bca.config import load_config
    from bca.cipher import get_cipher
    from bca.ctx import Ctx
    from bca.engine import generate_cnf_file_w7
    from bca.solver import KissatSolver
    from bca.task import Task

    cfg = load_config()
    task = Task(name="verify-cnf", algorithm=cipher_name, model="ref",
                round_start=1, round_end=round_count)
    ctx = Ctx(cfg, task, get_cipher(cipher_name, cfg), KissatSolver(cfg.solver_path()))
    cnf_path, var_count, clause_count, _, _, _ = generate_cnf_file_w7(
        ctx, round_count, lower_bound, upper_bound, prob)
    with open(cnf_path) as f:
        content = f.read()
    os.remove(cnf_path)
    return content, var_count, clause_count


def compare(label, ref_content, bca_content, ref_var, bca_var, ref_cls, bca_cls):
    """逐字节比对并输出。"""
    global ALL_PASS
    ok = ref_content == bca_content
    ALL_PASS &= ok
    print(f"{label}: {'PASS' if ok else 'FAIL'}")
    print(f"  var_count: ref={ref_var} bca={bca_var}  clause_count: ref={ref_cls} bca={bca_cls}")
    if not ok:
        ref_lines = ref_content.split("\n")
        bca_lines = bca_content.split("\n")
        for j in range(min(len(ref_lines), len(bca_lines))):
            if ref_lines[j] != bca_lines[j]:
                print(f"  first diff at line {j}:\n    ref: {ref_lines[j]}\n    bca: {bca_lines[j]}")
                break
        else:
            print(f"  length diff: ref={len(ref_lines)} bca={len(bca_lines)}")


# =============================================================================
# SM4-DW（回归）
# =============================================================================

def verify_sm4():
    ref = load_reference(SM4_REF)
    ref.SBOX_CONSTRAINT_FILE = os.path.join(DATA_ESPRESSO, "SM4_S-Box_Consts.txt")
    for i, (rc, prob, pl, pu, ql, qu) in enumerate(SM4_CASES):
        ref_cnf = f"/tmp/verify_ref_sm4_{i}.cnf"
        rv, rc_cls, _, _ = ref.generate_cnf_file(rc, pl, pu, ql, qu, prob)
        gen_name = f"R{rc}-P{prob}.cnf"
        if os.path.exists(gen_name):
            shutil.move(gen_name, ref_cnf)
        with open(ref_cnf) as f:
            ref_content = f.read()
        bca_content, bv, bca_cls = bca_generate("SM4", rc, pl, pu, ql, qu, prob)
        compare(f"SM4 case {i}: round={rc} prob={prob}", ref_content, bca_content,
                rv, bv, rc_cls, bca_cls)


# =============================================================================
# SM4-AS（参考注释掉了 p 序列编码 → BCA include_p_encoding=False）
# =============================================================================

SM4_AS_REF = os.path.join(REF_BASE, "SM4", "SM4_HPD_Auto_Search_AS.py")


def verify_sm4_as():
    ref = load_reference(SM4_AS_REF)
    ref.SBOX_CONSTRAINT_FILE = os.path.join(DATA_ESPRESSO, "SM4_S-Box_Consts.txt")
    for i, (rc, prob, pl, pu, ql, qu) in enumerate(SM4_CASES):
        os.chdir(PROJECT_ROOT)
        rv, rc_cls, fname, _ = ref.generate_cnf_file(rc, pl, pu, ql, qu, prob)
        with open(fname) as f:
            ref_content = f.read()
        os.remove(fname)
        bca_content, bv, bca_cls = bca_generate("SM4", rc, pl, pu, ql, qu, prob,
                                                include_p_encoding=False)
        compare(f"SM4-AS case {i}: round={rc} prob={prob}", ref_content, bca_content,
                rv, bv, rc_cls, bca_cls)


# =============================================================================
# AES（workdir symlink gf PLA + sbox 数据）
# =============================================================================

# bounds 数组长度 = round_count * SBOX_COUNT（AES SBOX_COUNT=16）
AES_CASES = [
    (1, 0, [0] * 16, [0] * 16, [0] * 16, [0] * 16),
    (2, 6, ([0, 0, 0, 0, 1, 1, 1, 1] * 2) * 2, [1] * 32, [1] * 32, [3] * 32),
    (2, 12, [1] * 32, [2] * 32, [2] * 32, [4] * 32),
    (3, 7, ([1] * 4 + [0] * 4 + [1] * 4 + [2] * 4) * 3,
     ([2] * 4 + [1] * 4 + [2] * 4 + [3] * 4) * 3,
     ([1] * 12 + [0] * 12) * 2, ([3] * 12 + [2] * 12) * 2),
]

# 4bit_xor / gf PLA 的参考文件名 → BCA data 文件名
PLA_LINKS = [
    ("AES_gf_x2_Espresso_Result.txt", "AES_gf_x2_Espresso_Result.txt"),
    ("AES_gf_x3_Espresso_Result.txt", "AES_gf_x3_Espresso_Result.txt"),
    ("4bit_xor.txt", "4bit_xor.txt"),
]


def verify_aes():
    ref_path = os.path.join(REF_BASE, "AES", "AES_HPD_Auto_Search_Perfect_Serial_New.py")
    workdir = make_workdir([("AES_Espresso_Result.txt", "AES_S-Box_Consts.txt")] + PLA_LINKS)
    ref = load_reference(ref_path)  # import 无文件读，cwd 在 generate 时切到 workdir
    for i, (rc, prob, pl, pu, ql, qu) in enumerate(AES_CASES):
        os.chdir(workdir)
        rv, rc_cls, fname, _ = ref.generate_cnf_file(rc, pl, pu, ql, qu, prob)
        with open(fname) as f:
            ref_content = f.read()
        bca_content, bv, bca_cls = bca_generate("AES", rc, pl, pu, ql, qu, prob)
        compare(f"AES case {i}: round={rc} prob={prob}", ref_content, bca_content,
                rv, bv, rc_cls, bca_cls)


# =============================================================================
# SM4-MAP（w7 体系：3-XOR + state copy 布局，与 DBlock 的 Feistel 不同）
# =============================================================================

SM4_MAP_REF = os.path.join(REF_BASE, "SM4", "SM4_HPD_Auto_Search_MAP.py")

# w7：lower/upper 数组长度 = round_count * SBOX_COUNT * 7（SM4 = 4*7 = 28）
SM4_W7_CASES = [
    (1, 0, [0] * 28, [0] * 28),
    (1, 6, [0] * 28, [1] * 28),
    (2, 12, [0] * 28 + [1] * 28, [1] * 28 + [2] * 28),
    (2, 7, [1] * 28 + [0] * 28, [2] * 28 + [1] * 28),
]


def verify_sm4_map():
    ref = load_reference(SM4_MAP_REF)
    # 参考默认 SBOX_CONSTRAINT_FILE 误用 AES 数据，补丁为正确的 SM4 数据
    ref.SBOX_CONSTRAINT_FILE = os.path.join(DATA_ESPRESSO, "SM4_S-Box_Consts.txt")
    for i, (rc, prob, lb, ub) in enumerate(SM4_W7_CASES):
        os.chdir(PROJECT_ROOT)  # 参考 CNF 写到 cwd
        rv, rc_cls, fname = ref.generate_cnf_file(rc, lb, ub, prob)
        with open(fname) as f:
            ref_content = f.read()
        os.remove(fname)  # 清理参考产物（参考写到 cwd，不留垃圾）
        bca_content, bv, bca_cls = bca_generate_w7("SM4", rc, lb, ub, prob)
        compare(f"SM4-MAP case {i}: round={rc} prob={prob}", ref_content, bca_content,
                rv, bv, rc_cls, bca_cls)


# =============================================================================
# DBlock-128（import 前 chdir；pq + w7 两套比对）
# =============================================================================

DB_REF = os.path.join(REF_BASE, "DBlock_HPD_Auto_Search.py")

# bounds 数组长度 = round_count * SBOX_COUNT（DBlock-128 SBOX_COUNT=8）
DB_CASES = [
    (1, 0, [0] * 8, [0] * 8, [0] * 8, [0] * 8),
    (2, 6, [0, 0, 0, 0, 1, 1, 1, 1] * 2, [1] * 16, [1] * 16, [3] * 16),
    (2, 12, [1] * 16, [2] * 16, [2] * 16, [4] * 16),
    (3, 7, ([1] * 2 + [0] * 2 + [1] * 2 + [0] * 2) * 3,
     ([2] * 4 + [1] * 4) * 3, [1] * 24, [3] * 24),
]

# w7：lower/upper 数组长度 = round_count * SBOX_COUNT * 7
DB_W7_CASES = [
    (1, 0, [0] * 56, [0] * 56),
    (1, 6, [0] * 56, [1] * 56),
    (2, 12, [0] * 56 + [1] * 56, [1] * 56 + [2] * 56),
]


def verify_dblock():
    workdir = make_workdir([("DBlock_S-Box_Consts.pkl", "DBlock_S-Box_Consts.pkl")])
    ref = load_reference(DB_REF, cwd=workdir)  # 模块级 pickle.load，必须 import 前 chdir
    ref.SEARCH_MODEL = "DW"  # 参考默认 RSX 不写 p 序列编码；DW 与 BCA 一致

    # pq 体系
    for i, (rc, prob, pl, pu, ql, qu) in enumerate(DB_CASES):
        os.chdir(workdir)
        rv, rc_cls, fname, _ = ref.generate_cnf_file(rc, pl, pu, ql, qu, prob)
        with open(fname) as f:
            ref_content = f.read()
        bca_content, bv, bca_cls = bca_generate("DBlock-128", rc, pl, pu, ql, qu, prob)
        compare(f"DBlock-128 case {i}: round={rc} prob={prob}", ref_content, bca_content,
                rv, bv, rc_cls, bca_cls)

    # w7 体系（MAP）
    for i, (rc, prob, lb, ub) in enumerate(DB_W7_CASES):
        os.chdir(workdir)
        rv, rc_cls, fname, _ = ref.generate_cnf_file_with_mapping(rc, lb, ub, prob)
        with open(fname) as f:
            ref_content = f.read()
        bca_content, bv, bca_cls = bca_generate_w7("DBlock-128", rc, lb, ub, prob)
        compare(f"DBlock-128 w7 case {i}: round={rc} prob={prob}", ref_content, bca_content,
                rv, bv, rc_cls, bca_cls)


# =============================================================================
# Rijndael-256（参考无 generate_cnf_file：只比对轮函数约束）
# =============================================================================

RIJ_REF = os.path.join(REF_BASE, "Rijndael-256_HPD_Auto_Search.py")

# bounds 数组长度 = round_count * SBOX_COUNT（Rijndael256 SBOX_COUNT=32）
RIJ_CASES = [
    (1, 0, [0] * 32, [0] * 32, [0] * 32, [0] * 32),
    (2, 6, [0] * 64, [1] * 64, [0] * 64, [2] * 64),
    (2, 12, [1] * 64, [2] * 64, [2] * 64, [4] * 64),
]


def verify_rijndael():
    workdir = make_workdir([("AES_Espresso_Result.txt", "AES_S-Box_Consts.txt")] + PLA_LINKS)
    ref = load_reference(RIJ_REF)

    sys.path.insert(0, PROJECT_ROOT)
    from bca.config import load_config
    from bca.cipher import get_cipher
    from bca.ctx import Ctx
    from bca.solver import KissatSolver
    from bca.task import Task

    cfg = load_config()
    task = Task(name="verify-cnf", algorithm="Rijndael256", model="ref",
                round_start=1, round_end=1)
    ctx = Ctx(cfg, task, get_cipher("Rijndael256", cfg), KissatSolver(cfg.solver_path()))

    for i, (rc, prob, pl, pu, ql, qu) in enumerate(RIJ_CASES):
        # 参考：变量生成 + 轮函数约束 → StringIO
        os.chdir(workdir)
        s_in, p_vars, q_vars, s_out, gf2, gf3, p_aux, q_aux, rv = \
            ref.generate_variables(rc, pl, pu, ql, qu)
        ref_buf = StringIO()
        ref.generate_round_function_constraints(rc, s_in, p_vars, q_vars, s_out,
                                                gf2, gf3, ref_buf)
        ref_content = ref_buf.getvalue()

        # BCA：变量生成 + 轮函数约束 → StringIO
        os.chdir(PROJECT_ROOT)
        pool = ctx.new_pool()
        vars, bv = ctx.cipher.generate_variables_pq(pool, rc, pl, pu, ql, qu)
        bca_buf = StringIO()
        ctx.cipher.generate_round_function_constraints(vars, rc, bca_buf)
        bca_content = bca_buf.getvalue()

        # 参考无序列编码、无 generate_cnf_file：只比轮函数子句
        ref_cls = ref_content.count("\n")
        bca_cls = bca_content.count("\n")
        compare(f"Rijndael256 case {i}: round={rc} (round function)", ref_content,
                bca_content, rv, bv, ref_cls, bca_cls)


# =============================================================================
# 入口
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description="BCA vs 参考实现 CNF 逐字节比对")
    parser.add_argument("--cipher", default=None,
                        help="只跑指定算法：SM4 / AES / DBlock-128 / Rijndael256（默认全部）")
    args = parser.parse_args()

    verifiers = [("SM4", verify_sm4), ("SM4-AS", verify_sm4_as), ("SM4-MAP", verify_sm4_map),
                 ("AES", verify_aes), ("DBlock-128", verify_dblock),
                 ("Rijndael256", verify_rijndael)]

    if args.cipher:
        names = [n for n, _ in verifiers]
        if args.cipher not in names:
            print(f"未知算法: {args.cipher}，可选: {names}")
            sys.exit(1)
        verifiers = [(args.cipher, dict(verifiers)[args.cipher])]

    for name, fn in verifiers:
        print(f"\n===== {name} =====")
        fn()

    print("\nALL PASS" if ALL_PASS else "\nSOME FAILED")
    sys.exit(0 if ALL_PASS else 1)


if __name__ == "__main__":
    main()
