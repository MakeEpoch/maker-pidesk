import copy
from datetime import datetime, timedelta
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import wave
from zoneinfo import ZoneInfo

from PIL import Image

from pidesk.app import State
from pidesk.audio import AudioPlayer, SoundBusyError, sound_test_wav
from pidesk.framebuffer import canvas_size, changed_spans, orient, rgb565, screen_pixels
from pidesk.storage import DEFAULT
from pidesk.weather import Weather


class PixelTests(unittest.TestCase):
    def test_rgb565_matches_reference_for_all_gray_levels_and_primaries(self):
        image = Image.new("RGB", (260, 1))
        image.putdata(
            [(v, v, v) for v in range(256)]
            + [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255)]
        )
        self.assertEqual(screen_pixels(image), rgb565(image))
        # 面板白平衡增益 COLOR_GAIN=(1.0, 0.98, 0.97)：
        # 绿(0,255,0)→(0,249,0)=0x07c0，蓝(0,0,255)→(0,0,247)=0x001e，白→(255,249,247)=0xffde
        self.assertEqual(screen_pixels(image)[-8:], bytes.fromhex("00f8c0071e00deff"))

    def test_color_gain_identity_passes_through(self):
        from pidesk.framebuffer import apply_gain

        image = Image.new("RGB", (2, 1), (120, 130, 140))
        with patch("pidesk.framebuffer.COLOR_GAIN", (1.0, 1.0, 1.0)):
            self.assertEqual(apply_gain(image).getpixel((0, 0)), (120, 130, 140))

    def test_rotation_places_corner_without_resampling(self):
        for angle, destination in ((0, (0, 0)), (90, (479, 0)), (180, (479, 319)), (270, (0, 319))):
            image = Image.new("RGB", canvas_size(angle))
            image.putpixel((0, 0), (255, 0, 0))
            output = orient(image, angle)
            self.assertEqual(output.size, (480, 320))
            self.assertEqual(output.getpixel(destination), (255, 0, 0))
            self.assertEqual(sum(p == (255, 0, 0) for p in output.getdata()), 1)

    def test_changed_spans_reconstruct_frame_and_skip_unchanged_rows(self):
        before = bytes(8 * 4 * 2)
        after = bytearray(before)
        after[2:6] = bytes.fromhex("00f8e007")
        after[52:54] = bytes.fromhex("1f00")
        spans = list(changed_spans(before, bytes(after), width=8, height=4))
        self.assertEqual([row for row, _, _ in spans], [0, 3])
        restored = bytearray(before)
        for row, offset, data in spans:
            self.assertEqual(offset % 2, 0)
            self.assertEqual(len(data) % 2, 0)
            start = row * 16 + offset
            restored[start : start + len(data)] = data
        self.assertEqual(restored, after)
        self.assertEqual(list(changed_spans(bytes(after), bytes(after), 8, 4)), [])


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.config = copy.deepcopy(DEFAULT)
        self.config["private_setting"] = "keep"
        self.path = root / "settings.json"
        self.path.write_text(json.dumps(self.config))
        self.state = State(self.config, self.path, root / "weather.json")

    def test_settings_survive_reload_without_overwriting_other_values(self):
        self.state.update_controls({"rotation": 270, "right_widget": "calendar"})
        saved = json.loads(self.path.read_text())
        restored = State(saved, self.path, Path(self.directory.name) / "weather.json")
        controls = restored.controls()
        self.assertEqual(controls["rotation"], 270)
        self.assertEqual(controls["right_widget"], "calendar")
        self.assertEqual(saved["private_setting"], "keep")

    def test_invalid_partial_patch_does_not_change_file(self):
        original = self.path.read_bytes()
        for patch_value in (
            {"rotation": True},
            {"rotation": 45},
            {"brightness": 50},
            {"right_widget": "brightness"},
            {"rotation": 90, "unknown": 1},
            {},
        ):
            with self.assertRaises(ValueError):
                self.state.update_controls(patch_value)
            self.assertEqual(self.path.read_bytes(), original)

    def test_photo_widget_is_valid(self):
        self.config["html_right_widget"] = "photo"
        controls = self.state.controls()
        self.assertEqual(controls["right_widget"], "photo")

    def test_unconfigured_location_does_not_request_weather(self):
        with tempfile.TemporaryDirectory() as directory:
            weather = Weather(copy.deepcopy(DEFAULT), Path(directory) / "weather.json")
            self.assertEqual(weather.snapshot()["location"]["source"], "unconfigured")
            with patch("pidesk.weather.get_json") as request:
                weather.refresh()
                request.assert_not_called()
            state = weather.snapshot()
            self.assertEqual(state["location"]["source"], "unconfigured")
            self.assertIsNone(state["weather"])

    def test_ip_location_accepts_other_countries_when_unrestricted(self):
        with tempfile.TemporaryDirectory() as directory:
            config = copy.deepcopy(DEFAULT)
            config.update(location_mode="ip", accepted_country="")
            today = datetime.now(ZoneInfo(config["timezone"])).date()
            response = {"current": {"temperature_2m": 21, "relative_humidity_2m": 70, "weather_code": 0, "time": today.isoformat()}, "daily": {"time": [today.isoformat()], "weather_code": [0], "temperature_2m_max": [24], "temperature_2m_min": [16], "precipitation_probability_max": [20]}}
            weather = Weather(config, Path(directory) / "weather.json")
            with patch("pidesk.weather.get_json", side_effect=[{"success": True, "country_code": "JP", "city": "Tokyo", "latitude": 35.68, "longitude": 139.69}, response]):
                weather.refresh()
            self.assertEqual(weather.snapshot()["location"]["city"], "Tokyo")
            self.assertIsNotNone(weather.snapshot()["weather"])

    def test_foreign_location_falls_back_and_fetches_next_three_days(self):
        with tempfile.TemporaryDirectory() as directory:
            config = copy.deepcopy(DEFAULT)
            config.update(location_mode="ip", accepted_country="CN", fallback={"city": "测试城市", "latitude": 32.0, "longitude": 118.0})
            today = datetime.now(ZoneInfo(config["timezone"])).date()
            response = {
                "current": {
                    "temperature_2m": 21,
                    "relative_humidity_2m": 70,
                    "weather_code": 0,
                    "time": today.isoformat(),
                },
                "daily": {
                    "time": [(today + timedelta(days=i)).isoformat() for i in range(4)],
                    "weather_code": [0, 1, 2, 3],
                    "temperature_2m_max": [24] * 4,
                    "temperature_2m_min": [16] * 4,
                    "precipitation_probability_max": [20] * 4,
                },
            }
            cache = Path(directory) / "weather.json"
            weather = Weather(config, cache)
            with patch(
                "pidesk.weather.get_json",
                side_effect=[{"success": True, "country_code": "JP"}, response],
            ):
                weather.refresh()
            state = weather.snapshot()
            self.assertEqual(state["location"]["city"], "测试城市")
            self.assertEqual(len(state["weather"]["forecast"]), 3)
            self.assertEqual(
                state["weather"]["forecast"][0]["date"], (today + timedelta(days=1)).isoformat()
            )
            self.assertEqual(Weather(config, cache).snapshot()["weather"], state["weather"])
            with patch("pidesk.weather.get_json", side_effect=OSError("offline")):
                weather.refresh()
            self.assertTrue(weather.snapshot()["error"])
            self.assertEqual(weather.snapshot()["weather"], state["weather"])


class AudioTests(unittest.TestCase):
    def test_sound_is_short_stereo_wave_with_fade(self):
        with wave.open(BytesIO(sound_test_wav()), "rb") as sound:
            self.assertEqual(
                (sound.getnchannels(), sound.getsampwidth(), sound.getframerate()), (2, 2, 44100)
            )
            self.assertAlmostEqual(sound.getnframes() / 44100, 1.8, places=2)
            self.assertEqual(sound.readframes(1), bytes(4))

    def test_configured_audio_device_and_runtime_user_are_arguments(self):
        player = AudioPlayer(device="hw:Device,0", run_as_user="displayuser")
        with patch("pidesk.audio.os.geteuid", return_value=0), patch("pidesk.audio.subprocess.run") as run:
            player.play_wav(b"sample")
        self.assertEqual(run.call_args.args[0], ["runuser", "-u", "displayuser", "--", "/usr/bin/aplay", "-q", "-D", "hw:Device,0"])

    def test_busy_playback_is_rejected(self):
        player = AudioPlayer()
        player.lock.acquire()
        try:
            with self.assertRaises(SoundBusyError):
                player.test_sound()
        finally:
            player.lock.release()

    def test_failed_player_releases_lock_for_retry(self):
        player = AudioPlayer()
        with patch(
            "pidesk.audio.subprocess.run", side_effect=[subprocess.TimeoutExpired("aplay", 8), None]
        ) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                player.test_sound()
            self.assertEqual(player.test_sound(), {"ok": True})
            self.assertEqual(run.call_count, 2)
            self.assertIn("plughw:CARD=Headphones,DEV=0", run.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
