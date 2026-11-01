from django.contrib import admin

from .models import SBox


@admin.register(SBox)
class SBoxAdmin(admin.ModelAdmin):
    list_display = ('name', 'size', 'is_builtin', 'table_hex_len', 'created_at')
    list_filter = ('size', 'is_builtin')
    search_fields = ('name', 'note')
    readonly_fields = ('created_at', 'updated_at')

    @admin.display(description='表数据长度')
    def table_hex_len(self, obj):
        return len(obj.table_hex)
