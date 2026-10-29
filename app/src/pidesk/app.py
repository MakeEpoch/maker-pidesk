#!/usr/bin/env python3
"""Local HTML page -> persistent headless Chromium -> changed framebuffer spans."""

import argparse
import calendar
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import logging
from pathlib import Path
import signal
import subprocess
import threading
import time
import urllib.parse
from zoneinfo import ZoneInfo

from PIL import Image, ImageChops

from .agents import AgentBoard, clean_push, save_push, token_matches
from .audio import AudioPlayer, SoundBusyError
from .photos import PhotoStore, photo_url
from .browser import Browser
from .framebuffer import (
    BrowserFramebuffer,
    canvas_size,
    changed_spans,
    orient,
    screen_pixels,
    write_snapshot,
)
from .storage import DEFAULT, read_json
from .system import local_ip, metrics, read_cpu
from .weather import Weather

def _asset_root():
    """前端目录：安装后在包内 pidesk/web；开发树里在 app/web。"""
    packaged = Path(__file__).resolve().parent / "web"
    if packaged.is_dir():
        return packaged
    # app/src/pidesk/app.py → app/web
    source = Path(__file__).resolve().parents[2] / "web"
    return source if source.is_dir() else packaged


ROOT = _asset_root()
ANGLES = (0, 90, 180, 270)
WIDGETS = ("none", "calendar", "forecast", "agents", "photo")
NOTIFY_STYLES = ("chime", "double", "soft", "rising", "bell", "none")
CONTROL_FIELDS = {
    "rotation": ("html_rotation", 0),
    "right_widget": ("html_right_widget", "none"),
    "notify_volume": ("html_notify_volume", 0.18),
    "notify_style_done": ("html_notify_style_done", "chime"),
    "notify_style_attention": ("html_notify_style_attention", "bell"),
    "color_gain_r": ("html_color_gain_r", 1.0),
    "color_gain_g": ("html_color_gain_g", 0.98),
    "color_gain_b": ("html_color_gain_b", 0.97),
}


class State:
    def __init__(
        self,
        config,
        settings_path="/etc/pidesk-dashboard.json",
        cache_path="/var/lib/pidesk-dashboard/weather.json",
    ):
        self.config = config
        self.settings_path = Path(settings_path)
        self.weather = Weather(config, cache_path)
        self.stats = {}
        self.stats_minute = None
        self.lock = threading.Lock()
        self.audio = AudioPlayer()
        self.cpu_sample = self.read_cpu()
        self.agents = AgentBoard(
            cache_dir=Path(cache_path).parent / "agents",
            push_path=Path(cache_path).parent / "agents" / "push.json",
        )
        self.agents.on_change = self._on_agent_change
        self.photos = PhotoStore(Path(cache_path).parent)
        # 启动时把配置中的色彩增益应用到 framebuffer
        self.sync_color_gain()

    def _on_agent_change(self, changed):
        """任务结束（running -> done/needs_input）时播放提示音；失败静默。"""
        statuses = {status for status, _ in changed.values()}
        finished = [task for task, (status, _) in changed.items() if status != "running"]
        if not finished:
            return
        kind = "attention" if "needs_input" in statuses else "done"
        logging.info("Agent tasks finished (%s): %s", kind, ",".join(finished))
        try:
            controls = self.controls()
            self.audio.notify(
                kind,
                volume=controls["notify_volume"],
                style_done=controls["notify_style_done"],
                style_attention=controls["notify_style_attention"],
            )
        except (subprocess.SubprocessError, OSError) as error:
            logging.debug("Agent notify sound failed: %s", error)

    def test_sound(self):
        return self.audio.test_sound()

    read_cpu = staticmethod(read_cpu)

    def rotation(self):
        angle = self.config.get("html_rotation", 0)
        return angle if type(angle) is int and angle in ANGLES else 0

    def set_rotation(self, angle):
        self.update_controls({"rotation": angle})
        return angle

    @staticmethod
    def validate_control(key, value):
        if key == "rotation":
            return type(value) is int and value in ANGLES
        if key == "right_widget":
            return isinstance(value, str) and value in WIDGETS
        if key == "notify_volume":
            return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value <= 1
        if key in ("notify_style_done", "notify_style_attention"):
            return isinstance(value, str) and value in NOTIFY_STYLES
        if key in ("color_gain_r", "color_gain_g", "color_gain_b"):
            return (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and 0.5 <= value <= 1.5
            )
        return False

    def sync_color_gain(self):
        """把设置里的三通道增益同步到 framebuffer（保存/启动时调用）。"""
        controls = self.controls()
        from .framebuffer import set_color_gain

        set_color_gain(
            [controls["color_gain_r"], controls["color_gain_g"], controls["color_gain_b"]]
        )

    def controls(self):
        result = {}
        for key, (stored, default) in CONTROL_FIELDS.items():
            value = self.config.get(stored, default)
            result[key] = value if self.validate_control(key, value) else default
        return result

    def _save_controls(self, patch):
        settings = read_json(self.settings_path, self.config)
        settings.update({CONTROL_FIELDS[key][0]: value for key, value in patch.items()})
        temporary = self.settings_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(self.settings_path)
        self.config.update(settings)

    def update_controls(self, patch):
        if (
            not isinstance(patch, dict)
            or not patch
            or any(
                key not in CONTROL_FIELDS or not self.validate_control(key, value)
                for key, value in patch.items()
            )
        ):
            raise ValueError("Invalid display settings")
        with self.lock:
            self._save_controls(patch)
        logging.info("Display settings saved: %s", ",".join(patch))

    def render_signature(self):
        # controls 包含 color_gain_*：增益变化会触发浏览器重画与全屏刷新
        return tuple(self.controls().values())

    def payload(self):
        now = datetime.now(ZoneInfo(self.config["timezone"]))
        with self.lock:
            if self.stats_minute != now.strftime("%Y%m%d%H%M"):
                self.stats = {k: None if v is None else round(v) for k, v in metrics().items()}
                current = self.read_cpu()
                total, idle = current[0] - self.cpu_sample[0], current[1] - self.cpu_sample[1]
                self.stats["cpu"] = round(100 * (1 - idle / total)) if total > 0 else 0
                self.cpu_sample = current
                self.stats_minute = now.strftime("%Y%m%d%H%M")
        state = self.weather.snapshot()
        first = now.date().replace(month=1, day=1)
        fraction = (now.date() - first).days / (first.replace(year=first.year + 1) - first).days
        days = []
        for week in calendar.Calendar().monthdayscalendar(now.year, now.month):
            for col, day in enumerate(week):
                days.append({"number": day, "weekend": col >= 5, "today": day == now.day})
        w = state["weather"]
        return {
            "time": now.strftime("%H:%M"),
            "date": now.date().isoformat(),
            "date_label": f"{now.year}年{now.month}月{now.day}日  星期"
            + "一二三四五六日"[now.weekday()],
            "month_label": f"{now.month:02d} / 月历",
            "days": days,
            # 年进度口径：year_percent = 今年已过占比（10月25日约 81%，决定灰条宽度），
            # year_remaining = 剩余占比（约 19%，右侧数字）
            "year_percent": round(fraction * 100),
            "year_remaining": round((1 - fraction) * 100),
            "stats": self.stats,
            "ip": local_ip(),
            "location": state["location"],
            "weather": w,
            "stale": bool(w and (state["error"] or time.time() - w["fetched_at"] > 1800)),
            "error": state["error"],
            "animation": self.config.get("html_animation", True),
            "agents": self.agents.snapshot(),
            "photo_url": photo_url(self.photos),
            **self.controls(),
        }


def server_for(state, host, port):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            push = self.path == "/api/agents-push"
            photo = self.path == "/api/photo"
            if self.path not in (
                "/api/rotation",
                "/api/settings",
                "/api/sound-test",
                "/api/notify-test",
                "/api/agents-push",
                "/api/photo",
            ):
                self.send_error(404)
                return
            if photo:
                # 照片上传：multipart 或原始图片体
                origin = self.headers.get("Origin")
                if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get("Host"):
                    self.send_error(403, "Same-origin requests only")
                    return
                self.handle_photo_upload()
                return
            if push:
                # 跨机推送：凭令牌鉴权，Origin 校验不适用
                expected = state.config.get("agent_push_token", "")
                provided = ""
                authorization = self.headers.get("Authorization", "")
                if authorization.startswith("Bearer "):
                    provided = authorization[7:].strip()
                elif self.headers.get("X-Pidesk-Token"):
                    provided = self.headers.get("X-Pidesk-Token", "").strip()
                if not token_matches(expected, provided):
                    self.send_error(403, "Push token rejected")
                    return
            else:
                origin = self.headers.get("Origin")
                if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get("Host"):
                    self.send_error(403, "Same-origin requests only")
                    return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                limit = 65536 if push else 2048
                if not 0 < length <= limit:
                    raise ValueError("Invalid request size")
                self.connection.settimeout(15)
                content_type = self.headers.get("Content-Type", "").split(";", 1)[0]
                if content_type != "application/json":
                    self.send_error(415, "JSON required")
                    return
                request = json.loads(self.rfile.read(length))
                if push:
                    cleaned = clean_push(request)
                    if not cleaned:
                        raise ValueError("Invalid push payload")
                    save_push(state.agents.push_path, cleaned)
                    state.agents.invalidate()
                    # 立即重算以触发完成提示音
                    state.agents.snapshot()
                    result = {"ok": True, "count": len(cleaned["agents"])}
                elif self.path == "/api/notify-test":
                    # 试听当前（或请求体指定的）提示音设置
                    if not isinstance(request, dict) or set(request) - {"kind"}:
                        raise ValueError("Expected optional kind only")
                    kind = request.get("kind", "done")
                    if kind not in ("done", "attention"):
                        raise ValueError("Unknown kind")
                    controls = state.controls()
                    result = state.audio.notify(
                        kind,
                        volume=controls["notify_volume"],
                        style_done=controls["notify_style_done"],
                        style_attention=controls["notify_style_attention"],
                    )
                elif self.path == "/api/sound-test":
                    if request != {}:
                        raise ValueError("Empty object required")
                    result = state.test_sound()
                elif self.path == "/api/rotation":
                    if not isinstance(request, dict) or set(request) != {"angle"}:
                        raise ValueError("Expected angle only")
                    result = {"angle": state.set_rotation(request["angle"])}
                else:
                    color_before = {
                        k: v for k, v in state.controls().items() if k.startswith("color_gain_")
                    }
                    state.update_controls(request)
                    # 色彩增益变更立即生效（无需重启）
                    color_after = {
                        k: v for k, v in state.controls().items() if k.startswith("color_gain_")
                    }
                    if color_after != color_before:
                        state.sync_color_gain()
                        logging.info("Color gain updated: %s", color_after)
                    result = state.payload()
            except (ValueError, TypeError, KeyError):
                self.send_error(400, "Invalid settings")
                return
            except SoundBusyError:
                self.send_error(409, "Sound test already playing")
                return
            except (subprocess.SubprocessError, OSError) as error:
                if self.path == "/api/sound-test":
                    logging.warning("Sound test failed: %s", error)
                    self.send_error(503, "Audio playback unavailable")
                    return
                logging.exception("Request handling failed: %s", self.path)
                self.send_error(500, "Could not save request")
                return
            body = json.dumps(result, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def handle_photo_upload(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
                limit = 4 * 1024 * 1024 + 8192
                if not 0 < length <= limit:
                    self.send_error(413, "Photo too large")
                    return
                self.connection.settimeout(30)
                body = self.rfile.read(length)
                content_type = self.headers.get("Content-Type", "")
                if content_type.startswith("multipart/form-data"):
                    # 极简 multipart 提取：取第一个文件部分的原始字节
                    boundary = content_type.split("boundary=", 1)[1].strip().encode()
                    parts = body.split(b"--" + boundary)
                    data = None
                    for part in parts:
                        if b"filename=" not in part:
                            continue
                        payload = part.split(b"\r\n\r\n", 1)
                        if len(payload) == 2:
                            data = payload[1]
                            if data.endswith(b"\r\n"):
                                data = data[:-2]
                            break
                    if data is None:
                        self.send_error(400, "No file part")
                        return
                else:
                    data = body
                ok, error = state.photos.save_upload(
                    data, portrait=state.rotation() in (90, 270)
                )
                if not ok:
                    self.send_error(400, error or "Invalid photo")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                result = json.dumps({"ok": True, "url": photo_url(state.photos)})
                self.send_header("Content-Length", str(len(result)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(result.encode())
            except (ValueError, OSError) as error:
                logging.warning("Photo upload failed: %s", error)
                self.send_error(500, "Photo upload failed")

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/state":
                body = json.dumps(state.payload(), ensure_ascii=False).encode()
                mime = "application/json; charset=utf-8"
            elif path == "/photo":
                body = state.photos.read()
                if not body:
                    self.send_error(404, "No photo")
                    return
                mime = "image/jpeg"
            elif path in (
                "/",
                "/index.html",
                "/style.css",
                "/app.js",
                "/font-check.html",
                "/font-check.js",
            ):
                name = "index.html" if path == "/" else path[1:]
                body = (ROOT / name).read_bytes()
                mime = {"html": "text/html", "css": "text/css", "js": "application/javascript"}[
                    name.rsplit(".", 1)[1]
                ] + "; charset=utf-8"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
            )
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--probe", metavar="PNG", help="Render and measure two frames without touching the screen"
    )
    parser.add_argument("--config", default="/etc/pidesk-dashboard.json")
    parser.add_argument("--cache", default="/var/lib/pidesk-dashboard/weather.json")
    parser.add_argument(
        "--web-only", action="store_true", help="Serve UI without browser or framebuffer access"
    )
    parser.add_argument(
        "--offline", action="store_true", help="Use cached weather; no location/weather requests"
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    config = dict(DEFAULT)
    config.update(read_json(args.config, {}))
    state = State(config, args.config, args.cache)
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    server = server_for(state, args.host, args.port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if not args.offline:
        threading.Thread(target=state.weather.worker, args=(stop,), daemon=True).start()
    browser = display = None
    try:
        if args.web_only:
            logging.info("Web preview: http://%s:%s (no framebuffer access)", args.host, args.port)
            while not stop.wait(1):
                pass
            return
        Path("/run/pidesk-html").mkdir(exist_ok=True)
        started = time.monotonic()
        angle = state.rotation()
        browser = Browser(f"http://127.0.0.1:{args.port}/?display=1", angle)
        logging.info("HTML/browser ready in %.2fs", time.monotonic() - started)
        if args.probe:
            results, frames = [], []
            for _ in range(2):
                started = time.monotonic()
                png = browser.screenshot()
                image = Image.open(BytesIO(png)).convert("RGB")
                assert image.size == canvas_size(angle)
                image = orient(image, angle)
                frame = screen_pixels(image)
                results.append(round(time.monotonic() - started, 3))
                frames.append((image, frame))
                if len(frames) == 1:
                    stop.wait(2.2)
            frames[-1][0].save(args.probe)
            changed = sum(
                len(data) // 2 for _, _, data in changed_spans(frames[0][1], frames[1][1])
            )
            print(
                json.dumps(
                    {
                        "frame_seconds": results,
                        "animation_changed_pixels": changed,
                        "difference_box": ImageChops.difference(
                            frames[0][0], frames[1][0]
                        ).getbbox(),
                    }
                )
            )
            return
        display = BrowserFramebuffer()
        previous_png = None
        interval = max(0.5, float(config.get("html_frame_interval", 1)))
        last_log, last_assets_check = 0, 0
        asset_mtime = max(p.stat().st_mtime_ns for p in ROOT.iterdir() if p.is_file())
        signature = state.render_signature()
        while not stop.is_set():
            started = time.monotonic()
            current_angle = state.rotation()
            current_signature = state.render_signature()
            if current_signature != signature:
                if current_angle != angle:
                    browser.viewport(current_angle)
                payload = json.dumps(state.payload(), ensure_ascii=True)
                browser.call(
                    "Runtime.evaluate", expression="window.applyPideskState(" + payload + ")"
                )
                angle = current_angle
                previous_png = None
                signature = current_signature
                logging.info("Display controls applied; rotation=%s", angle)
            if started - last_assets_check > 5:
                stamp = max(p.stat().st_mtime_ns for p in ROOT.iterdir() if p.is_file())
                if stamp != asset_mtime:
                    browser.reload()
                    asset_mtime = stamp
                    logging.info("HTML/CSS/JS reloaded")
                last_assets_check = started
            png = browser.screenshot()
            changed = 0
            if png != previous_png:
                image = Image.open(BytesIO(png)).convert("RGB")
                if image.size != canvas_size(angle):
                    raise RuntimeError("Unexpected browser viewport size")
                image = orient(image, angle)
                changed = display.show(image)
                write_snapshot(image, "/run/pidesk-dashboard.png")
                previous_png = png
            duration = time.monotonic() - started
            if duration > interval * 1.5:
                interval = min(4, max(interval, duration * 1.2))
            if started - last_log >= 30:
                status = {
                    "frame_seconds": round(duration, 3),
                    "frame_interval": round(interval, 3),
                    "changed_pixels": changed,
                    "animation": config.get("html_animation", True),
                }
                Path("/run/pidesk-html/metrics.json").write_text(json.dumps(status))
                logging.info("HTML frame: %s", json.dumps(status))
                last_log = started
            stop.wait(max(0.05, interval - duration))
    finally:
        stop.set()
        if display:
            display.close()
        if browser:
            browser.close()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
