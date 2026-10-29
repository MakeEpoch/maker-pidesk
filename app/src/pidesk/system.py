"""Host metrics; missing Linux interfaces are reported as unavailable."""

from pathlib import Path
import socket


def local_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            # Route selection only; this does not send a packet to this address.
            sock.connect(("198.51.100.1", 80))
            return sock.getsockname()[0]
    except OSError:
        return "离线"


def metrics():
    try:
        temperature = float(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000
    except (OSError, ValueError):
        temperature = None
    try:
        data = {
            line.split(":")[0]: int(line.split()[1])
            for line in Path("/proc/meminfo").read_text().splitlines()
        }
        memory = 100 * (1 - data["MemAvailable"] / data["MemTotal"])
    except (OSError, ValueError, KeyError):
        memory = None
    return {"temperature": temperature, "memory": memory}


def read_cpu():
    try:
        values = [int(v) for v in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]
        return sum(values), values[3] + values[4]
    except (OSError, ValueError, IndexError):
        return 0, 0
