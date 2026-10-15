"""Optional read-only resource endpoint for Forge Neo Client.

Copy the parent extension folder into Forge's extensions directory, then restart Forge.
No generation hooks, background process, writes, or extra network port are used.
"""

import subprocess

from modules import script_callbacks


ROUTE = "/forge-neo-client/v1/stats"
VERSION = "0.1.0"


def _number(call):
    try:
        value = call()
        return float(value) if value is not None else None
    except Exception:
        return None


def _gpu_nvml():
    import pynvml

    pynvml.nvmlInit()
    try:
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        info = pynvml.nvmlDeviceGetMemoryInfo(handle)
        name = pynvml.nvmlDeviceGetName(handle)
        return {
            "name": name.decode("utf-8", "replace") if isinstance(name, bytes) else str(name),
            "utilization": _number(lambda: pynvml.nvmlDeviceGetUtilizationRates(handle).gpu),
            "temperature": _number(lambda: pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)),
            "fan_percent": _number(lambda: pynvml.nvmlDeviceGetFanSpeed(handle)),
            "power_watts": _number(lambda: pynvml.nvmlDeviceGetPowerUsage(handle) / 1000),
            "power_limit_watts": _number(lambda: pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000),
            "vram_used": _number(lambda: info.used),
            "vram_total": _number(lambda: info.total),
        }
    finally:
        pynvml.nvmlShutdown()


def _gpu_smi():
    fields = "name,utilization.gpu,temperature.gpu,fan.speed,power.draw,power.limit,memory.used,memory.total"
    result = subprocess.run(
        ["nvidia-smi", f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, check=True, timeout=2,
    )
    line = result.stdout.splitlines()[0]
    cells = [cell.strip() for cell in line.split(",")]
    if len(cells) != 8:
        raise ValueError("Unexpected nvidia-smi output")

    def num(index):
        try:
            return float(cells[index])
        except ValueError:
            return None

    used, total = num(6), num(7)
    return {
        "name": cells[0] or None,
        "utilization": num(1), "temperature": num(2), "fan_percent": num(3),
        "power_watts": num(4), "power_limit_watts": num(5),
        "vram_used": used * 1024 ** 2 if used is not None else None,
        "vram_total": total * 1024 ** 2 if total is not None else None,
    }


def _gpu():
    empty = {key: None for key in (
        "name", "utilization", "temperature", "fan_percent", "power_watts",
        "power_limit_watts", "vram_used", "vram_total",
    )}
    for probe in (_gpu_nvml, _gpu_smi):
        try:
            return probe()
        except Exception:
            pass
    return empty


def stats():
    cpu = None
    ram_used = ram_total = None
    try:
        import psutil

        cpu = _number(lambda: psutil.cpu_percent(interval=None))
        ram = psutil.virtual_memory()
        ram_used, ram_total = ram.used, ram.total
    except Exception:
        pass

    try:
        import torch

        torch_version = str(torch.__version__)
    except Exception:
        torch_version = None

    try:
        from modules_forge import forge_version

        forge_release = getattr(forge_version, "version", None)
        if forge_release is not None:
            forge_release = str(forge_release)
    except Exception:
        forge_release = None

    return {
        "version": VERSION,
        "forge_version": forge_release,
        "torch_version": torch_version,
        "cpu": {"percent": cpu},
        "ram": {"used": ram_used, "total": ram_total},
        "gpu": _gpu(),
    }


def on_app_started(_demo, app):
    app.add_api_route(ROUTE, stats, methods=["GET"])


script_callbacks.on_app_started(on_app_started)
