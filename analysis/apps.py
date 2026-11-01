from django.apps import AppConfig


class AnalysisConfig(AppConfig):
    name = 'analysis'
    verbose_name = '密码算法分析'

    def ready(self):
        """定制后台标题。

        放在 ready() 里是 Django 推荐做法：此时 app registry 已就绪，
        可以安全地导入 django.contrib.admin。
        """
        from django.contrib import admin

        admin.site.site_header = '密码算法分析系统'
        admin.site.site_title = '密码算法分析系统'
        admin.site.index_title = '管理控制台'
