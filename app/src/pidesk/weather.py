"""IP location, Open-Meteo weather and offline cache."""

import copy
from datetime import datetime
import json
import logging
import math
from pathlib import Path
import threading
import time
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

from .storage import atomic_json, read_json


def get_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "pidesk/1.0"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


class Weather:
    def __init__(self, config, cache):
        self.config = config
        self.cache = Path(cache)
        saved = read_json(cache, {})
        fallback = self.fallback()
        if fallback.get("latitude") is None or fallback.get("longitude") is None:
            fallback["source"] = "unconfigured"
        self.state = {
            "location": saved.get("location", fallback),
            "weather": saved.get("weather"),
            "error": False,
        }
        self.lock = threading.Lock()
        self.location_checked = 0

    def fallback(self):
        location = {"city": "未配置地点", "latitude": None, "longitude": None}
        configured = self.config.get("fallback")
        if isinstance(configured, dict):
            location.update(configured)
        return dict(location, source="fallback")

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.state)

    def refresh(self):
        state = self.snapshot()
        now = time.time()
        if now - self.location_checked >= self.config["location_interval"]:
            location = self.fallback()
            if self.config["location_mode"] == "ip":
                try:
                    geo = get_json(
                        "https://ipwho.is/?fields=success,city,country_code,latitude,longitude&lang=zh-CN"
                    )
                    if (
                        geo.get("success")
                        and (not self.config.get("accepted_country") or geo.get("country_code") == self.config["accepted_country"])
                    ):
                        lat, lon = float(geo["latitude"]), float(geo["longitude"])
                        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                            raise ValueError("Invalid location coordinates")
                        city = str(geo.get("city") or "本地")[:16]
                        location = dict(city=city, latitude=lat, longitude=lon, source="ip")
                    else:
                        logging.info("IP location outside configured country; using fallback city")
                except Exception as error:
                    logging.warning(
                        "Location unavailable (%s); using fallback city", type(error).__name__
                    )
            # A weather cache must always belong to its displayed coordinates.
            previous = state["location"]
            if any(previous.get(k) != location[k] for k in ("latitude", "longitude")):
                state["weather"] = None
            state["location"] = location
            self.location_checked = now
        location = state["location"]
        lat, lon = location.get("latitude"), location.get("longitude")
        try:
            valid_location = (lat is not None and lon is not None and
                              math.isfinite(float(lat)) and math.isfinite(float(lon)) and
                              -90 <= float(lat) <= 90 and -180 <= float(lon) <= 180)
        except (TypeError, ValueError):
            valid_location = False
        if not valid_location:
            state.update(location={"city": "未配置地点", "latitude": None, "longitude": None, "source": "unconfigured"}, weather=None, error=False)
            with self.lock:
                self.state = state
            atomic_json(self.cache, state)
            return
        params = {
            "latitude": location["latitude"],
            "longitude": location["longitude"],
            "current": "temperature_2m,relative_humidity_2m,weather_code",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            "timezone": self.config["timezone"],
            "forecast_days": 4,
        }
        try:
            response = get_json(
                "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params)
            )
            current, daily = response["current"], response["daily"]
            # Select today's row explicitly; midnight must not show yesterday's forecast.
            today = datetime.now(ZoneInfo(self.config["timezone"])).date().isoformat()
            index = daily["time"].index(today)
            weather = {
                "temperature": float(current["temperature_2m"]),
                "humidity": float(current["relative_humidity_2m"]),
                "code": int(current["weather_code"]),
                "low": float(daily["temperature_2m_min"][index]),
                "high": float(daily["temperature_2m_max"][index]),
                "rain": float(daily["precipitation_probability_max"][index]),
                "observed_at": current["time"],
                "fetched_at": now,
                "forecast": [
                    {
                        "date": daily["time"][i],
                        "code": int(daily["weather_code"][i]),
                        "low": float(daily["temperature_2m_min"][i]),
                        "high": float(daily["temperature_2m_max"][i]),
                    }
                    for i in range(index + 1, min(index + 4, len(daily["time"])))
                ],
            }
            if not all(
                math.isfinite(weather[k])
                for k in ("temperature", "humidity", "low", "high", "rain")
            ):
                raise ValueError("Invalid weather values")
            if not all(
                math.isfinite(day[k]) for day in weather["forecast"] for k in ("low", "high")
            ):
                raise ValueError("Invalid forecast values")
            state.update(weather=weather, error=False)
            logging.info("Weather updated for %s", location["city"])
        except Exception as error:
            state["error"] = True
            logging.warning(
                "Weather unavailable (%s); retaining last successful data", type(error).__name__
            )
        with self.lock:
            self.state = state
        atomic_json(self.cache, state)

    def worker(self, stop):
        while not stop.is_set():
            try:
                self.refresh()
            except Exception:
                logging.exception("Weather cache/update failed")
            interval = 180 if self.snapshot()["error"] else self.config["weather_interval"]
            stop.wait(max(60, interval))
