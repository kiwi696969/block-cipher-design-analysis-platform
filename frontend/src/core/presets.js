/**
 * 内置参考 S 盒。用于快速填充表单、以及作为计算层的基准测试向量。
 * 数值来源：各自算法的官方规范。
 */

export const SM4_SBOX_HEX = [
  'd690e9fecce13db716b614c228fb2c05',
  '2b679a762abe04c3aa44132649860699',
  '9c4250f491ef987a33540b43edcfac62',
  'e4b31ca9c908e89580df94fa758f3fa6',
  '4707a7fcf37317ba83593c19e6854fa8',
  '686b81b27164da8bf8eb0f4b70569d35',
  '1e240e5e6358d1a225227c3b01217887',
  'd40046579fd327524c3602e7a0c4c89e',
  'eabf8ad240c738b5a3f7f2cef96115a1',
  'e0ae5da49b341a55ad933230f58cb1e3',
  '1df6e22e8266ca60c02923ab0d534e6f',
  'd5db3745defd8e2f03ff6a726d6c5b51',
  '8d1baf92bbddbc7f11d95c411f105ad8',
  '0ac13188a5cd7bbd2d74d012b8e5b4b0',
  '8969974a0c96777e65b9f109c56ec684',
  '18f07dec3adc4d2079ee5f3ed7cb3948',
].join('')

export const AES_SBOX_HEX = [
  '637c777bf26b6fc53001672bfed7ab76',
  'ca82c97dfa5947f0add4a2af9ca472c0',
  'b7fd9326363ff7cc34a5e5f171d83115',
  '04c723c31896059a071280e2eb27b275',
  '09832c1a1b6e5aa0523bd6b329e32f84',
  '53d100ed20fcb15b6acbbe394a4c58cf',
  'd0efaafb434d338545f9027f503c9fa8',
  '51a3408f929d38f5bcb6da2110fff3d2',
  'cd0c13ec5f974417c4a77e3d645d1973',
  '60814fdc222a908846eeb814de5e0bdb',
  'e0323a0a4906245cc2d3ac629195e479',
  'e7c8376d8dd54ea96c56f4ea657aae08',
  'ba78252e1ca6b4c6e8dd741f4bbd8b8a',
  '703eb5664803f60e613557b986c11d9e',
  'e1f8981169d98e949b1e87e9ce5528df',
  '8ca1890dbfe6426841992d0fb054bb16',
].join('')

/** PRESENT 是 4 位 S 盒，只有 16 个元素。 */
export const PRESENT_SBOX_HEX = 'c56b90ad3ef84712'

export const PRESETS = [
  { name: 'SM4-Sbox', size: 256, hex: SM4_SBOX_HEX, note: 'GB/T 32907-2016 标准 S 盒' },
  { name: 'AES-Sbox', size: 256, hex: AES_SBOX_HEX, note: 'FIPS-197 标准 S 盒（GF(2^8) 求逆 + 仿射变换）' },
  { name: 'PRESENT-Sbox', size: 16, hex: PRESENT_SBOX_HEX, note: 'PRESENT 轻量级分组密码 4 位 S 盒' },
]
