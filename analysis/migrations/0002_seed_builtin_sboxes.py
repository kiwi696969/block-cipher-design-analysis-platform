"""把三个权威内置 S 盒写进库。

模型里一直有 `is_builtin` 字段、页面上也有「内置 / 自定义」标签，
但库里从来没有内置数据 —— 全新安装打开 S 盒库是一张空表，
详情页也就没有任何记录可看。这个迁移把 SM4 / AES / PRESENT
三个最常用的 S 盒补上，让「S 盒库」开箱可用。

表数据与前端 `frontend/src/core/sbox.js` 的 BUILTIN_SBOXES **必须一致**
（frontend/tests/verify-seed.mjs 会盯着这一点，防止两边各改各的）。
指标（DDT / LAT / 非线性度）不落库，仍由前端实时算。

反向迁移只删这三个内置项，不动用户自建的。
"""

from django.db import migrations

BUILTIN = [
    {
        'name': 'SM4 S-Box',
        'size': 8,
        'table_hex': (
            'd690e9fecce13db716b614c228fb2c052b679a762abe04c3aa44132649860699'
            '9c4250f491ef987a33540b43edcfac62e4b31ca9c908e89580df94fa758f3fa6'
            '4707a7fcf37317ba83593c19e6854fa8686b81b27164da8bf8eb0f4b70569d35'
            '1e240e5e6358d1a225227c3b01217887d40046579fd327524c3602e7a0c4c89e'
            'eabf8ad240c738b5a3f7f2cef96115a1e0ae5da49b341a55ad933230f58cb1e3'
            '1df6e22e8266ca60c02923ab0d534e6fd5db3745defd8e2f03ff6a726d6c5b51'
            '8d1baf92bbddbc7f11d95c411f105ad80ac13188a5cd7bbd2d74d012b8e5b4b0'
            '8969974a0c96777e65b9f109c56ec68418f07dec3adc4d2079ee5f3ed7cb3948'
        ),
        'note': '国密 SM4 分组密码 S 盒，GB/T 32907-2016',
        'is_builtin': True,
    },
    {
        'name': 'AES S-Box',
        'size': 8,
        'table_hex': (
            '637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0'
            'b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275'
            '09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf'
            'd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2'
            'cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb'
            'e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08'
            'ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e'
            'e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16'
        ),
        'note': 'AES（Rijndael）S 盒，FIPS-197',
        'is_builtin': True,
    },
    {
        'name': 'PRESENT S-Box',
        'size': 4,
        'table_hex': (
            '0c05060b09000a0d030e0f0804070102'
        ),
        'note': 'PRESENT 轻量级分组密码 S 盒，ISO/IEC 29192-2',
        'is_builtin': True,
    }

]


def seed(apps, schema_editor):
    SBox = apps.get_model('analysis', 'SBox')
    for row in BUILTIN:
        # 幂等：同名已存在就更新为内置版本，不产生重复行
        SBox.objects.update_or_create(name=row['name'], defaults=row)


def unseed(apps, schema_editor):
    SBox = apps.get_model('analysis', 'SBox')
    SBox.objects.filter(name__in=[r['name'] for r in BUILTIN], is_builtin=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('analysis', '0001_initial'),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
