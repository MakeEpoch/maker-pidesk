#!/usr/bin/env python3
"""Integration check on Pi: isolated settings storage and a real browser tab."""

import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.error

import websocket

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from pidesk import app as m


def request(base, path, value=None, raw=None, mime="application/json", origin=None):
    headers = {"Content-Type": mime}
    if origin:
        headers["Origin"] = origin
    data = raw if raw is not None else (json.dumps(value).encode() if value is not None else None)
    req = urllib.request.Request(base + path, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as response:
        body = response.read()
        return (
            json.loads(body)
            if "application/json" in response.headers.get("Content-Type", "")
            else body
        )


def wait_for(predicate, message):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.2)
    raise AssertionError(message)


with tempfile.TemporaryDirectory(prefix="pidesk-controls-test-") as directory:
    root = Path(directory)
    root.chmod(0o755)
    config = dict(m.DEFAULT, html_rotation=0, html_animation=False)
    settings = root / "settings.json"
    settings.write_text(json.dumps(config))
    state = m.State(config, settings)
    server = m.server_for(state, "127.0.0.1", 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:" + str(server.server_address[1])
    try:
        for invalid in (
            {"brightness": -1},
            {"brightness": 101},
            {"brightness": True},
            {"rotation": 45},
            {"right_widget": "unknown"},
            {"command": "invalid"},
        ):
            try:
                request(base, "/api/settings", invalid)
                raise AssertionError("Invalid settings accepted")
            except urllib.error.HTTPError as error:
                assert error.code == 400
        try:
            request(base, "/api/settings", {"rotation": 0}, origin="http://outside.invalid")
            raise AssertionError("Cross-origin settings accepted")
        except urllib.error.HTTPError as error:
            assert error.code == 403
        print("Settings validation and same-origin guard: OK", flush=True)

        # Use an isolated tab and HTTP server; the physical screen is not changed.
        profile = Path("/var/lib/pidesk-dashboard/html-browser/DevToolsActivePort")
        port = int(profile.read_text().splitlines()[0])

        def targets():
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list") as response:
                return json.load(response)

        def client(target):
            b = m.Browser.__new__(m.Browser)
            b.request_id = 0
            b.socket = websocket.create_connection(
                target["webSocketDebuggerUrl"], timeout=20, suppress_origin=True
            )
            return b

        parent = client(next(t for t in targets() if t["type"] == "page"))
        tid = parent.call("Target.createTarget", url="about:blank")["targetId"]
        browser = client(next(t for t in targets() if t["id"] == tid))

        def js(expression):
            result = browser.call(
                "Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True
            )
            if result.get("exceptionDetails"):
                raise AssertionError(result["exceptionDetails"])
            return result.get("result", {}).get("value")

        try:
            browser.call(
                "Emulation.setDeviceMetricsOverride",
                width=1280,
                height=1400,
                deviceScaleFactor=1,
                mobile=False,
            )
            browser.call("Page.navigate", url=base + "/")
            time.sleep(0.5)
            browser.ready()
            assert js(
                'document.querySelector(".preview-panel").getBoundingClientRect().right < document.getElementById("controls").getBoundingClientRect().left'
            )
            for widget in ("calendar", "forecast", "none"):
                js(f'document.querySelector("[data-widget={widget}]").click()')
                wait_for(lambda: state.controls()["right_widget"] == widget, "Widget not saved")
                if widget == "calendar":
                    assert js('document.querySelectorAll(".right-calendar .today").length') == 1
                elif widget == "forecast":
                    assert js('document.querySelectorAll(".forecast-item").length') == 3
            for angle in (90, 180, 270, 0):
                js(
                    f'Array.from(document.querySelectorAll("[data-angle]")).find(b=>Number(b.dataset.angle)==={angle}).click()'
                )
                wait_for(lambda: state.rotation() == angle, "Rotation button not saved")
                assert js('document.getElementById("desk").classList.contains("portrait")') == (
                    angle in (90, 270)
                )
            Path("/home/pi/pidesk-control-panel-check.png").write_bytes(browser.screenshot())
            browser.call(
                "Emulation.setDeviceMetricsOverride",
                width=390,
                height=844,
                deviceScaleFactor=1,
                mobile=False,
            )
            time.sleep(0.3)
            assert js("document.documentElement.scrollWidth <= innerWidth")
            print(
                "Real browser: preview/control split, widgets, angles, mobile layout: OK",
                flush=True,
            )
        finally:
            browser.socket.close()
            parent.call("Target.closeTarget", targetId=tid)
            parent.socket.close()
    finally:
        server.shutdown()
        server.server_close()
