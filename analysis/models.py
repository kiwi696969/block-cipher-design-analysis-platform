"""密码算法分析系统 —— 数据模型。

当前仅落地「S 盒」这一个核心实体：它是差分/线性分析的最小输入单元。
后续的差分特征、线性特征、分析任务等模型，在需要持久化时再逐步加进来。
"""

from django.db import models


class SBox(models.Model):
    """一个 4bit / 8bit S 盒。

    表数据以十六进制字符串存储（SM4 的 256 字节表即 512 个 hex 字符）。
    DDT / LAT / 非线性度等指标由计算层实时算出，**不落库**——
    避免出现「库里的指标和算法算出来的不一致」这种最难查的 bug。
    """

    class Size(models.IntegerChoices):
        BIT4 = 4, '4 bit（16 项）'
        BIT8 = 8, '8 bit（256 项）'

    name = models.CharField('名称', max_length=64, unique=True)
    size = models.PositiveSmallIntegerField('位宽', choices=Size.choices, default=Size.BIT8)
    table_hex = models.TextField('表数据（hex）', help_text='例如 d690e9fecce13db7…，长度应为 2×项数')
    note = models.CharField('备注', max_length=200, blank=True)
    is_builtin = models.BooleanField('内置', default=False)
    created_at = models.DateTimeField('创建时间', auto_now_add=True)
    updated_at = models.DateTimeField('更新时间', auto_now=True)

    class Meta:
        verbose_name = 'S 盒'
        verbose_name_plural = 'S 盒'
        ordering = ['name']

    def __str__(self):
        return f'{self.name} ({self.size}bit)'

    @property
    def expected_hex_len(self):
        """按位宽推算表数据应有的 hex 字符数。"""
        return (1 << self.size) * 2
