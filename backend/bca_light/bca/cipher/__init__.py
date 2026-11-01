"""
算法注册表：CLI 按名字解析 cipher 类。

cipher 类需 cfg 参数构造（加载 espresso S-box 数据）。
不同 block size 视为不同算法（DBlock-128/192/256 独立注册）。
"""

from .base import CipherBase
from .sm4 import SM4Cipher
from .aes import AESCipher
from .dblock import DBlock128Cipher, DBlock192Cipher, DBlock256Cipher
from .rijndael256 import Rijndael256Cipher

CIPHER_REGISTRY = {
    "SM4": SM4Cipher,
    "AES": AESCipher,
    "DBlock-128": DBlock128Cipher,
    "DBlock-192": DBlock192Cipher,
    "DBlock-256": DBlock256Cipher,
    "Rijndael256": Rijndael256Cipher,
}


def get_cipher(name, cfg, attack="differential"):
    if name not in CIPHER_REGISTRY:
        raise KeyError(f"未知算法: {name}，可选: {sorted(CIPHER_REGISTRY)}")
    return CIPHER_REGISTRY[name](cfg, attack=attack)


__all__ = [
    "CipherBase", "SM4Cipher", "AESCipher",
    "DBlock128Cipher", "DBlock192Cipher", "DBlock256Cipher", "Rijndael256Cipher",
    "CIPHER_REGISTRY", "get_cipher",
]
