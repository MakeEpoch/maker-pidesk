"""Photo widget: upload, screen-fit conversion, and serving.

照片存 <cache_dir>/photo.jpg。上传后用 Pillow 居中裁切成屏幕比例
（480x320 或竖屏 320x480）并压缩，SPI 全屏刷新更省带宽。
白平衡增益在写屏时统一应用，这里不做二次处理。
"""

import logging
from pathlib import Path

from PIL import Image

MAX_UPLOAD_BYTES = 4 * 1024 * 1024
ALLOWED_FORMATS = ("JPEG", "PNG", "WEBP", "BMP")


class PhotoStore:
    def __init__(self, cache_dir):
        self.path = Path(cache_dir) / "photo.jpg"

    def exists(self):
        return self.path.exists()

    def modified_at(self):
        try:
            return int(self.path.stat().st_mtime)
        except OSError:
            return 0

    def read(self):
        try:
            return self.path.read_bytes()
        except OSError:
            return None

    def save_upload(self, data, portrait=False):
        """校验图片数据、裁切成屏比例并保存；返回 (ok, error)。"""
        from io import BytesIO

        if not data or len(data) > MAX_UPLOAD_BYTES:
            return False, "empty or over 4MB"
        try:
            image = Image.open(BytesIO(data))
            image.load()
        except Exception:
            # Pillow 各类解析异常（含 UnidentifiedImageError）；HTTP 错误短语须 ASCII
            return False, "unrecognized image"
        if image.format not in ALLOWED_FORMATS:
            return False, f"unsupported format {image.format}"
        # 居中裁切成屏幕比例再缩放到屏尺寸
        target = (320, 480) if portrait else (480, 320)
        image = image.convert("RGB")
        source_ratio = image.width / image.height
        target_ratio = target[0] / target[1]
        if source_ratio > target_ratio:
            new_width = int(image.height * target_ratio)
            left = (image.width - new_width) // 2
            image = image.crop((left, 0, left + new_width, image.height))
        else:
            new_height = int(image.width / target_ratio)
            top = (image.height - new_height) // 2
            image = image.crop((0, top, image.width, top + new_height))
        image = image.resize(target, Image.LANCZOS)
        temporary = self.path.with_suffix(".tmp")
        try:
            image.save(temporary, format="JPEG", quality=88)
            temporary.replace(self.path)
        except (OSError, ValueError) as error:
            temporary.unlink(missing_ok=True)
            return False, f"image processing failed: {error}"
        logging.info("Photo saved: %s", self.path)
        return True, None


def photo_url(store):
    """state 里的照片地址；无照片返回空串。带 mtime 防浏览器缓存。"""
    if not store.exists():
        return ""
    return f"/photo?v={store.modified_at()}"
