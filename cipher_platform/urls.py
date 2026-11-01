"""密码算法分析系统 —— 根路由。

- /admin/   Django 管理后台
- /         analysis 应用（首页 / 健康检查 / API）
"""

from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('analysis.urls')),
]
