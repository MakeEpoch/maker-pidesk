"""Exact rotation, RGB565 conversion and changed-span framebuffer output."""

from array import array
import fcntl
import mmap
import os
from pathlib import Path
import sys

import numpy as np
from PIL import Image

W, H = 480, 320

# 面板白平衡补偿（实拍校准结果）：R/G/B 通道增益。1.0 为不补偿。
# 控制台可通过设置 html_color_gain（[r, g, b] 列表，0.5-1.5）实时调整。
COLOR_GAIN = (1.0, 0.98, 0.97)


def set_color_gain(gain):
    """更新通道增益；无效输入忽略并返回 False。"""
    if (
        not isinstance(gain, (list, tuple))
        or len(gain) != 3
        or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and 0.5 <= v <= 1.5 for v in gain)
    ):
        return False
    global COLOR_GAIN
    COLOR_GAIN = tuple(float(v) for v in gain)
    return True


def apply_gain(image):
    """按面板校准增益微调通道（numpy 快速路径，无增益时原样返回）。"""
    if COLOR_GAIN == (1.0, 1.0, 1.0):
        return image
    data = np.asarray(image.convert("RGB"), dtype=np.float32)
    data *= COLOR_GAIN
    return Image.fromarray(np.clip(data, 0, 255).astype(np.uint8), "RGB")


def canvas_size(angle):
    return (320, 480) if angle in (90, 270) else (480, 320)


def orient(image, angle):
    operations = {
        90: Image.Transpose.ROTATE_270,
        180: Image.Transpose.ROTATE_180,
        270: Image.Transpose.ROTATE_90,
    }
    return image.transpose(operations[angle]) if angle else image


def write_snapshot(image, path):
    path = Path(path)
    temporary = path.with_suffix(".tmp")
    image.save(temporary, format="PNG")
    temporary.replace(path)


def rgb565(image):
    data = apply_gain(image).convert("RGB").tobytes()
    pixels = array(
        "H",
        (
            ((data[i] >> 3) << 11) | ((data[i + 1] >> 2) << 5) | (data[i + 2] >> 3)
            for i in range(0, len(data), 3)
        ),
    )
    if sys.byteorder != "little":
        pixels.byteswap()
    return pixels.tobytes()


def changed_spans(previous, current, width=W, height=H):
    """Yield changed, pixel-aligned horizontal spans; never clear the screen."""
    rowbytes = width * 2
    for y in range(height):
        base = y * rowbytes
        old, new = previous[base : base + rowbytes], current[base : base + rowbytes]
        if old == new:
            continue
        left, right = 0, rowbytes
        while left < rowbytes and old[left : left + 2] == new[left : left + 2]:
            left += 2
        while right > left and old[right - 2 : right] == new[right - 2 : right]:
            right -= 2
        yield y, left, new[left:right]


class Framebuffer:
    def __init__(self):
        candidates = [
            p
            for p in Path("/sys/class/graphics").glob("fb[0-9]*")
            if (p / "name").read_text().strip() == "kedei62"
        ]
        if not candidates:
            raise RuntimeError("KeDei framebuffer not ready")
        screen = candidates[0]
        if (screen / "virtual_size").read_text().strip() != "480,320":
            raise RuntimeError("Dashboard requires a 480x320 display")
        if int((screen / "bits_per_pixel").read_text()) != 16:
            raise RuntimeError("Dashboard requires RGB565")
        stride_file = screen / "stride"
        self.stride = int(stride_file.read_text()) if stride_file.exists() else W * 2
        self.fd = os.open("/dev/" + screen.name, os.O_RDWR)
        self.memory = mmap.mmap(
            self.fd, self.stride * H, flags=mmap.MAP_SHARED, prot=mmap.PROT_READ | mmap.PROT_WRITE
        )
        self.previous = bytes().join(
            self.memory[y * self.stride : y * self.stride + W * 2] for y in range(H)
        )
        self.tty = os.open("/dev/tty1", os.O_RDWR | os.O_NOCTTY)
        self.mode = array("i", [0])
        fcntl.ioctl(self.tty, 0x4B3B, self.mode, True)  # KDGETMODE
        fcntl.ioctl(self.tty, 0x4B3A, 1)  # KD_GRAPHICS: prevent console overdraw

    def show(self, image):
        current = rgb565(image)
        count = 0
        for row, offset, data in changed_spans(self.previous, current):
            begin = row * self.stride + offset
            self.memory[begin : begin + len(data)] = data
            count += len(data) // 2
        self.previous = current
        return count

    def close(self):
        try:
            fcntl.ioctl(self.tty, 0x4B3A, self.mode[0])
        finally:
            os.close(self.tty)
            self.memory.close()
            os.close(self.fd)


def screen_pixels(image):
    colors = np.asarray(apply_gain(image).convert("RGB"), dtype=np.uint16)
    packed = ((colors[:, :, 0] >> 3) << 11) | ((colors[:, :, 1] >> 2) << 5) | (colors[:, :, 2] >> 3)
    return packed.astype("<u2").tobytes()


class BrowserFramebuffer(Framebuffer):
    def show(self, image):
        current = screen_pixels(image)
        count = 0
        for row, offset, data in changed_spans(self.previous, current):
            begin = row * self.stride + offset
            self.memory[begin : begin + len(data)] = data
            count += len(data) // 2
        self.previous = current
        return count
