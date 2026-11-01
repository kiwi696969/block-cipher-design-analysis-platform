"""
CNF 文件生成辅助：子句写出、文件写出（含头行与子句计数）。

函数签名与参考实现一致（file 为文件句柄/缓冲），保证逐字节兼容。
"""

from io import StringIO


def write_xor_clause(variables, alpha, file):
    """
    写 XOR 约束子句。

    Args:
        variables: 变量编号列表
        alpha: 二进制掩码，决定每个变量的取反（奇数位取反）
        file: 输出句柄
    """
    clause_parts = []
    for i, var in enumerate(variables):
        if alpha & (1 << i):
            clause_parts.append(f"-{var}")
        else:
            clause_parts.append(f"{var}")
    file.write(" ".join(clause_parts) + " 0\n")


class CNFBuffer:
    """内存 CNF 缓冲：先写内容，再统计子句数、写文件。"""

    def __init__(self):
        self.buf = StringIO()

    def write(self, text):
        self.buf.write(text)

    def write_clause(self, lits):
        """写一条子句：lits 为带符号整数列表，如 [-1, 2, 3] 或字符串。"""
        self.buf.write(" ".join(str(l) for l in lits) + " 0\n")

    def clause_count(self):
        # 每条子句以换行结尾，且内容中无空行
        return self.buf.getvalue().count("\n")

    def content(self):
        return self.buf.getvalue()

    def save(self, filename, var_count):
        """写文件：p cnf 头 + 内容。"""
        with open(filename, "w") as f:
            f.write(f"p cnf {var_count} {self.clause_count()}\n")
            f.write(self.content())
