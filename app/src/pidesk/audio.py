"""Short stereo sound check through the configured ALSA output."""

from io import BytesIO
import math
import os
import struct
import subprocess
import threading
import wave


class SoundBusyError(Exception):
    pass


def tone_wav(frequencies, duration=0.28, pause=0.14, volume=0.42):
    """依次播放几个频率的短音，用于事件提示。"""
    rate = 44100
    frames = bytearray()
    for frequency in frequencies:
        for i in range(int(rate * duration)):
            progress = i / (rate * duration)
            envelope = max(0.0, min(1.0, progress / 0.12, (1 - progress) / 0.12))
            value = round(
                32767 * volume * envelope * math.sin(2 * math.pi * frequency * i / rate)
            )
            frames.extend(struct.pack("<hh", value, value))
        frames.extend(bytes(int(rate * pause) * 4))
    output = BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(frames)
    return output.getvalue()


def sound_test_wav():
    rate = 44100
    frames = bytearray()
    for channel, frequency in ((0, 523.25), (1, 659.25)):
        for i in range(int(rate * 0.65)):
            envelope = max(0, min(1, i / (rate * 0.025), (rate * 0.65 - 1 - i) / (rate * 0.025)))
            value = round(32767 * 0.12 * envelope * math.sin(2 * math.pi * frequency * i / rate))
            frames.extend(
                struct.pack("<hh", value if channel == 0 else 0, value if channel == 1 else 0)
            )
        frames.extend(bytes(int(rate * 0.25) * 4))
    output = BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(frames)
    return output.getvalue()


class AudioPlayer:
    # 可选音效：kind → (频率序列, 单音时长, 音间停顿)
    NOTIFY_STYLES = {
        "chime": ((784.0, 1047.0), 0.28, 0.14),
        "double": ((880.0, 880.0), 0.16, 0.22),
        "soft": ((523.25,), 0.4, 0.0),
        "rising": ((523.25, 659.25, 784.0), 0.16, 0.08),
        "bell": ((659.25, 523.25, 659.25), 0.22, 0.12),
        "none": ((), 0.0, 0.0),
    }

    def __init__(self, device="plughw:CARD=Headphones,DEV=0", run_as_user="pi"):
        self.device = device
        self.run_as_user = run_as_user
        self.lock = threading.Lock()

    def play_wav(self, data, timeout=8):
        command = ["/usr/bin/aplay", "-q", "-D", self.device]
        if os.geteuid() == 0:
            command = ["runuser", "-u", self.run_as_user, "--"] + command
        subprocess.run(command, input=data, capture_output=True, check=True, timeout=timeout)
        return {"ok": True}

    def style_params(self, style):
        """音效样式 → (频率, 时长, 停顿)；未知样式回退 chime。"""
        return self.NOTIFY_STYLES.get(style, self.NOTIFY_STYLES["chime"])

    def notify(self, kind, volume=0.42, style_done="chime", style_attention="bell"):
        if not self.lock.acquire(blocking=False):
            return {"ok": False, "busy": True}
        try:
            style = style_attention if kind == "attention" else style_done
            frequencies, duration, pause = self.style_params(style)
            if not frequencies:
                return {"ok": True, "silent": True}
            volume = max(0.05, min(1.0, float(volume)))
            return self.play_wav(tone_wav(frequencies, duration, pause, volume))
        finally:
            self.lock.release()

    def test_sound(self):
        if not self.lock.acquire(blocking=False):
            raise SoundBusyError()
        try:
            return self.play_wav(sound_test_wav())
        finally:
            self.lock.release()
