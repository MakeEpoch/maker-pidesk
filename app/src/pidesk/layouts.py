"""Strict, versioned layout settings for the fixed-size display canvas."""

import re

ELEMENT_IDS = frozenset((
    "date", "weekday", "clock", "year-label", "year-bar", "year-percent",
    "city", "condition", "temperature", "weather-icon", "range", "humidity", "rain",
    "cpu", "memory", "ip", "calendar", "forecast", "agents", "photo", "pet", "bubble",
    "header-line", "column-line",
))
EMPTY_LAYOUT = {"version": 1, "landscape": {}, "portrait": {}}
_FIELDS = frozenset(("x", "y", "width", "height", "font", "color", "visible", "locked", "z", "align", "overflow", "group", "unit"))


def valid_layout(value):
    if not isinstance(value, dict) or set(value) != set(EMPTY_LAYOUT):
        return False
    if type(value["version"]) is not int or value["version"] != 1:
        return False
    for mode, width, height in (("landscape", 480, 320), ("portrait", 320, 480)):
        elements = value[mode]
        if not isinstance(elements, dict) or set(elements) - ELEMENT_IDS:
            return False
        for element_id, item in elements.items():
            if not isinstance(item, dict) or set(item) - _FIELDS:
                return False
            for key, field in item.items():
                if key in ("visible", "locked"):
                    if type(field) is not bool:
                        return False
                elif key in ("x", "y", "width", "height", "font", "z"):
                    maximum = {"x": width - 1, "y": height - 1, "width": width, "height": height, "font": 96, "z": 100}[key]
                    minimum = 1 if key in ("width", "height") else 8 if key == "font" else 0
                    if type(field) is not int or not minimum <= field <= maximum:
                        return False
                elif key == "unit":
                    if element_id not in ("temperature", "range") or field not in ("c", "f"):
                        return False
                elif key == "color":
                    if not isinstance(field, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", field):
                        return False
                elif key == "align":
                    if field not in ("left", "center", "right"):
                        return False
                elif key == "overflow":
                    if field not in ("ellipsis", "wrap"):
                        return False
                elif key == "group":
                    if not isinstance(field, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", field):
                        return False
            if item.get("x", 0) + item.get("width", 1) > width:
                return False
            if item.get("y", 0) + item.get("height", 1) > height:
                return False
    return True
