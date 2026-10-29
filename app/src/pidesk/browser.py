"""Persistent headless Chromium controlled through loopback CDP."""

import base64
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import subprocess
import time
import urllib.request

import websocket

from .framebuffer import canvas_size


class Browser:
    def __init__(self, url, angle=0, run_as_user="pi"):
        self.process = None
        self.socket = None
        self.request_id = 0
        self.log = None
        profile = Path("/var/lib/pidesk-dashboard/html-browser")
        profile.mkdir(exist_ok=True)
        account = pwd.getpwnam(run_as_user)
        if account.pw_uid == 0:
            raise ValueError("Chromium account must not be root")
        os.chown(profile, account.pw_uid, account.pw_gid)
        profile.chmod(0o700)
        active_port = profile / "DevToolsActivePort"
        active_port.unlink(missing_ok=True)
        binary = shutil.which("chromium-headless-shell")
        if not binary:
            raise RuntimeError("Install chromium-headless-shell first")
        self.log = open("/run/pidesk-html/chromium.log", "a")
        command = [
            "runuser",
            "-u",
            run_as_user,
            "--",
            binary,
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-sync",
            "--no-first-run",
            "--no-default-browser-check",
            "--hide-scrollbars",
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0",
            "--window-size=480,320",
            "--force-device-scale-factor=1",
            "--font-render-hinting=full",
            "--user-data-dir=" + str(profile),
            "about:blank",
        ]
        try:
            self.process = subprocess.Popen(
                command, stdout=self.log, stderr=self.log, start_new_session=True
            )
            deadline = time.monotonic() + 40
            while not active_port.exists():
                if self.process.poll() is not None:
                    raise RuntimeError("Chromium exited; inspect /run/pidesk-html/chromium.log")
                if time.monotonic() > deadline:
                    raise TimeoutError("Chromium startup timed out")
                time.sleep(0.2)
            port = int(active_port.read_text().splitlines()[0])
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/list", timeout=10
            ) as response:
                targets = json.load(response)
            target = next(t for t in targets if t["type"] == "page")
            self.socket = websocket.create_connection(
                target["webSocketDebuggerUrl"],
                timeout=20,
                suppress_origin=True,
                http_proxy_host=None,
            )
            self.call("Page.enable")
            self.viewport(angle)
            self.call("Page.navigate", url=url)
            self.ready()
        except Exception:
            self.close()
            raise

    def call(self, method, **params):
        self.request_id += 1
        request_id = self.request_id
        self.socket.send(json.dumps({"id": request_id, "method": method, "params": params}))
        while True:
            response = json.loads(self.socket.recv())
            if response.get("id") == request_id:
                if "error" in response:
                    raise RuntimeError(f"{method}: {response['error']}")
                return response.get("result", {})

    def ready(self):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = self.call(
                "Runtime.evaluate", expression="window.pideskReady === true", returnByValue=True
            )
            if result.get("result", {}).get("value"):
                self.call(
                    "Runtime.evaluate",
                    expression="document.fonts.ready.then(()=>true)",
                    awaitPromise=True,
                )
                return
            time.sleep(0.2)
        raise TimeoutError("HTML data/font load timed out")

    def screenshot(self):
        result = self.call(
            "Page.captureScreenshot",
            format="png",
            fromSurface=True,
            captureBeyondViewport=False,
            optimizeForSpeed=True,
        )
        return base64.b64decode(result["data"])

    def viewport(self, angle):
        width, height = canvas_size(angle)
        self.call(
            "Emulation.setDeviceMetricsOverride",
            width=width,
            height=height,
            deviceScaleFactor=1,
            mobile=False,
        )

    def reload(self):
        self.call("Page.reload", ignoreCache=True)
        self.ready()

    def close(self):
        if self.socket:
            self.socket.close()
        if self.process and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=6)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=3)
        if self.log:
            self.log.close()
