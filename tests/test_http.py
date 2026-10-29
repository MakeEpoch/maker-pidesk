import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from pidesk.app import State, server_for
from pidesk.audio import SoundBusyError
from pidesk.storage import DEFAULT


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        root = Path(cls.directory.name)
        cls.config = root / "settings.json"
        cls.config.write_text(json.dumps(DEFAULT))
        cls.state = State(copy.deepcopy(DEFAULT), cls.config, root / "weather.json")
        cls.server = server_for(cls.state, "127.0.0.1", 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:" + str(cls.server.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(2)
        cls.directory.cleanup()

    def request(self, path, data=None, origin=None):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        body = json.dumps(data).encode() if data is not None else None
        return urllib.request.urlopen(
            urllib.request.Request(self.base + path, data=body, headers=headers), timeout=4
        )

    def test_packaged_assets_and_state(self):
        with self.request("/") as r:
            html = r.read().decode()
            self.assertIn('id="sound-test"', html)
            self.assertIn('id="photo-file"', html)
        for path in ("/app.js", "/style.css", "/font-check.html", "/font-check.js"):
            with self.request(path) as r:
                self.assertGreater(len(r.read()), 0)
        with self.request("/api/state") as r:
            state = json.load(r)
            self.assertIn("rotation", state)
            self.assertIn("photo_url", state)

    def test_settings_and_legacy_rotation(self):
        with self.request("/api/settings", {"rotation": 90, "right_widget": "forecast"}) as r:
            self.assertEqual(json.load(r)["right_widget"], "forecast")
        # 色彩增益：保存并回读（立即生效路径）
        with self.request(
            "/api/settings", {"color_gain_r": 1.05, "color_gain_g": 0.9, "color_gain_b": 1.1}
        ) as r:
            result = json.load(r)
            self.assertEqual(result["color_gain_r"], 1.05)
            self.assertEqual(result["color_gain_g"], 0.9)
            self.assertEqual(result["color_gain_b"], 1.1)
        saved = json.loads(self.config.read_text())
        self.assertEqual(saved["html_color_gain_g"], 0.9)
        # 恢复默认，避免污染其他用例（COLOR_GAIN 是模块级全局）
        with self.request(
            "/api/settings", {"color_gain_r": 1.0, "color_gain_g": 0.98, "color_gain_b": 0.97}
        ) as r:
            json.load(r)
        # 越界拒绝
        import urllib.error as _e

        with self.assertRaises(_e.HTTPError) as error:
            self.request("/api/settings", {"color_gain_r": 2.0})
        self.assertEqual(error.exception.code, 400)
        with self.request("/api/rotation", {"angle": 180}) as r:
            self.assertEqual(json.load(r), {"angle": 180})
        self.assertEqual(json.loads(self.config.read_text())["html_rotation"], 180)

    def test_unknown_and_removed_routes_are_rejected(self):
        for path, data, status in (
            ("/api/settings", {"command": "no"}, 400),
        ):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request(path, data)
            self.assertEqual(error.exception.code, status)

    def test_cross_origin_sound_does_not_play(self):
        with patch.object(self.state.audio, "test_sound") as sound:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request("/api/sound-test", {}, "http://untrusted.invalid")
            self.assertEqual(error.exception.code, 403)
            sound.assert_not_called()

    def test_sound_result_busy_and_unavailable(self):
        with patch.object(self.state.audio, "test_sound", return_value={"ok": True}) as sound:
            with self.request("/api/sound-test", {}) as r:
                self.assertEqual(json.load(r), {"ok": True})
            sound.assert_called_once()
        for exception, status in ((SoundBusyError(), 409), (OSError("no device"), 503)):
            with patch.object(self.state.audio, "test_sound", side_effect=exception):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    self.request("/api/sound-test", {})
                self.assertEqual(error.exception.code, status)

    def test_photo_upload_and_serve(self):
        from PIL import Image
        from io import BytesIO

        buffer = BytesIO()
        Image.new("RGB", (800, 600), (200, 100, 50)).save(buffer, format="JPEG")
        photo_bytes = buffer.getvalue()
        boundary = "----pidesktest"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="photo"; filename="test.jpg"\r\n'
            f"Content-Type: image/jpeg\r\n\r\n"
        ).encode() + photo_bytes + f"\r\n--{boundary}--\r\n".encode()
        request = urllib.request.Request(
            self.base + "/api/photo",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        with urllib.request.urlopen(request, timeout=6) as r:
            result = json.load(r)
        self.assertTrue(result["ok"])
        self.assertIn("/photo?v=", result["url"])
        with self.request("/api/state") as r:
            self.assertIn("/photo?v=", json.load(r)["photo_url"])
        with self.request("/photo") as r:
            self.assertEqual(r.headers["Content-Type"], "image/jpeg")
            served = r.read()
        # 已裁切成屏比例（480x320）
        from PIL import Image as I

        image = I.open(BytesIO(served))
        self.assertEqual(image.size, (480, 320))
        # 坏数据拒绝
        bad = urllib.request.Request(
            self.base + "/api/photo",
            data=b"not-an-image",
            headers={"Content-Type": "image/jpeg"},
        )
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(bad, timeout=6)
        self.assertEqual(error.exception.code, 400)
        # 清理
        Path(self.state.photos.path).unlink(missing_ok=True)

    def test_notify_test_plays_current_settings(self):
        # 空对象默认 done；kind 透传；音量与音效来自已保存设置
        with patch.object(self.state.audio, "notify", return_value={"ok": True}) as sound:
            with self.request("/api/notify-test", {}) as r:
                self.assertEqual(json.load(r), {"ok": True})
            sound.assert_called_once_with(
                "done", volume=0.18, style_done="chime", style_attention="bell"
            )
            with self.request("/api/notify-test", {"kind": "attention"}) as r:
                self.assertEqual(json.load(r), {"ok": True})
            sound.assert_called_with(
                "attention", volume=0.18, style_done="chime", style_attention="bell"
            )
        # 保存新设置后，试听使用保存后的值
        with self.request(
            "/api/settings", {"notify_volume": 0.6, "notify_style_done": "rising"}
        ) as r:
            self.assertEqual(json.load(r)["notify_volume"], 0.6)
        with patch.object(self.state.audio, "notify", return_value={"ok": True}) as sound:
            with self.request("/api/notify-test", {"kind": "done"}) as r:
                self.assertEqual(json.load(r), {"ok": True})
            sound.assert_called_once_with(
                "done", volume=0.6, style_done="rising", style_attention="bell"
            )
        # 恢复默认，避免影响其他用例
        self.state.update_controls(
            {"notify_volume": 0.18, "notify_style_done": "chime"}
        )

    def test_notify_test_rejects_bad_requests_and_reports_busy(self):
        for data in ({"kind": "bad"}, {"extra": 1}):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request("/api/notify-test", data)
            self.assertEqual(error.exception.code, 400)
        # busy 不是错误：200 + {"ok": false, "busy": true}
        with patch.object(
            self.state.audio, "notify", return_value={"ok": False, "busy": True}
        ) as sound:
            with self.request("/api/notify-test", {}) as r:
                self.assertEqual(json.load(r), {"ok": False, "busy": True})
            sound.assert_called_once_with(
                "done", volume=0.18, style_done="chime", style_attention="bell"
            )

    def push(self, payload, token="push-token"):
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
        request = urllib.request.Request(
            self.base + "/api/agents-push",
            data=json.dumps(payload).encode(),
            headers=headers,
        )
        return urllib.request.urlopen(request, timeout=4)

    def test_agent_push_requires_token(self):
        payload = {"pushed_at": time.time(), "agents": []}
        self.state.config["agent_push_token"] = "push-token"
        for token, status in (("wrong", 403), (None, 403)):
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            request = urllib.request.Request(
                self.base + "/api/agents-push",
                data=json.dumps(payload).encode(),
                headers=headers,
            )
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request, timeout=4)
            self.assertEqual(error.exception.code, status)
        self.state.config["agent_push_token"] = ""

    def test_agent_push_invalid_payload_rejected(self):
        self.state.config["agent_push_token"] = "push-token"
        for data, status in (
            ({"agents": []}, 400),  # 缺 pushed_at
            ({"pushed_at": time.time(), "agents": [{"id": 1}]}, 400),
        ):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.push(data)
            self.assertEqual(error.exception.code, status)
        self.state.config["agent_push_token"] = ""

    def test_agent_push_stores_and_appears_in_state(self):
        self.state.config["agent_push_token"] = "push-token"
        # 先建立基线（真实部署里设备持续轮询 /api/state，基线总是先于推送存在）
        self.state.agents.invalidate()
        with patch.object(self.state.audio, "notify", return_value={"ok": True}) as sound:
            with self.request("/api/state"):
                pass
            sound.assert_not_called()
            now = time.time()
            task = {
                "id": "dsh:session-xyz",
                "source": "DSH",
                "title": "推送任务",
                "detail": "来自插件",
                "status": "needs_input",
                "updated": now - 2,
            }
            with self.push({"pushed_at": now, "agents": [task]}) as r:
                result = json.load(r)
            self.assertEqual(result, {"ok": True, "count": 1})
            # 推送即重算，状态变化应触发提示音（needs_input → attention，带音量/音效配置）
            sound.assert_called_once_with(
                "attention",
                volume=0.18,
                style_done="chime",
                style_attention="bell",
            )
        with self.request("/api/state") as r:
            state = json.load(r)
        ids = {item["id"]: item for item in state["agents"]}
        self.assertIn("dsh:session-xyz", ids)
        self.assertEqual(ids["dsh:session-xyz"]["status"], "needs_input")
        self.state.config["agent_push_token"] = ""
        # 清理，避免影响其他用例
        Path(self.state.agents.push_path).unlink(missing_ok=True)
        self.state.agents.invalidate()


if __name__ == "__main__":
    unittest.main()
