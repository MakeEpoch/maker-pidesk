"""Configuration and atomic JSON persistence."""

import copy
import json
from pathlib import Path

DEFAULT = {
    "location_mode": "ip",
    "accepted_country": "CN",
    "fallback": {"city": "南京", "latitude": 32.0617, "longitude": 118.7778},
    "timezone": "Asia/Shanghai",
    "weather_interval": 900,
    "location_interval": 21600,
    "agent_push_token": "",
}


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return copy.deepcopy(default)


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False))
    temporary.chmod(0o600)
    temporary.replace(path)
