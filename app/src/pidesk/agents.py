"""Aggregate agent task progress from local DSH and Codex session records.

数据来源（均只读、离线解析）：
- 推送：DSH 插件通过 POST /api/agents-push 写入的 JSON（跨机部署的主路径）
- DSH:   ~/.dsh/sessions/<workspace>/session-*/session.v4.jsonl.zstd
- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl

每个任务输出 {id, source, title, detail, status, updated}，status 为
running / done / needs_input。
"""

import hmac
import json
import logging
import os
import re

from pathlib import Path
import subprocess
import time

# 最近有输出的会话视为进行中；超过这个时长当作已完成/待查看
ACTIVE_SECONDS = 5 * 60
# Codex 最近无 task 事件也算完成
CODEX_ACTIVE_SECONDS = 5 * 60
# 超过该秒数的任务不再展示
MAX_AGE_SECONDS = 24 * 60 * 60
# 单次推送允许的任务数与请求体上限
PUSH_MAX_TASKS = 50
QUESTION_END = re.compile(r"[？?][」』\"'\)）\s]*$")


def _mtime(path):
    try:
        return path.stat().st_mtime
    except OSError:
        return 0


def _first_text(content):
    for part in content or []:
        if isinstance(part, dict) and part.get("text"):
            return part["text"]
    return ""


def _summarize(text, limit=120):
    text = " ".join((text or "").split())
    return text[: limit - 1] + "…" if len(text) > limit else text


def _needs_input(text):
    """最后的助手回复以问句结尾 → 视为等待用户回答。"""
    return bool(QUESTION_END.search((text or "").strip()[-40:]))


def _latest_events(path, types):
    """按序读取 jsonl，返回 {type: [payload,...]}，保留每个 type 的全部条目。"""
    results = {t: [] for t in types}
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if len(line) > 2_000_000:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                # Codex 的事件类型在 payload.type，DSH 在顶层 type
                kind = record.get("type")
                payload = record.get("payload")
                if kind == "event_msg" and isinstance(payload, dict):
                    kind = payload.get("type")
                if kind in results:
                    results[kind].append(payload if isinstance(payload, dict) else record)
    except OSError:
        pass
    return results


def _dsh_sessions(home):
    root = Path(home) / ".dsh" / "sessions"
    result = []
    for directory in root.iterdir() if root.is_dir() else []:
        for session_dir in directory.glob("session-*"):
            archive = session_dir / "session.v4.jsonl.zstd"
            if archive.exists():
                result.append((directory.name, session_dir.name, archive))
    return result


def _decompress(archive, cache_dir):
    """zstdcat 解压到缓存目录，按 mtime 去重；失败返回 None。"""
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / (archive.parent.name + ".jsonl")
    stamp = cache_dir / (archive.parent.name + ".stamp")
    current = _mtime(archive)
    if target.exists() and stamp.exists() and stamp.read_text() == str(current):
        return target
    try:
        result = subprocess.run(
            ["zstdcat", str(archive)],
            capture_output=True,
            timeout=20,
            check=True,
        )
    except (OSError, subprocess.SubprocessError) as error:
        logging.debug("zstdcat %s failed: %s", archive, error)
        return None
    target.write_bytes(result.stdout)
    stamp.write_text(str(current))
    return target


def _dsh_tasks(home, cache_dir, now):
    tasks = []
    for workspace, session_id, archive in _dsh_sessions(home):
        plain = _decompress(archive, cache_dir)
        if not plain:
            continue
        events = _latest_events(
            plain, ("session/title", "assistant/message", "turn/start", "turn/end")
        )
        if not events["assistant/message"]:
            continue
        title = ""
        for data in events["session/title"]:
            data = data.get("data", data)
            title = data.get("title") or title
        last_assistant = ""
        for data in events["assistant/message"]:
            data = data.get("data", data)
            text = _first_text(data.get("message", {}).get("content"))
            if text:
                last_assistant = text
        if not title:
            title = _summarize(_first_text_from_user(plain) or session_id, 60)
        stamps = []
        with open(plain, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record.get("time"), (int, float)):
                    stamps.append(record["time"])
        updated = (max(stamps) if stamps else 0) / 1000 or _mtime(archive)
        if not updated or now - updated > MAX_AGE_SECONDS:
            continue
        # turn 有开始无结束 → 正在跑；结束后按最后回复判断完成/待回答
        running = len(events["turn/start"]) > len(events["turn/end"])
        if running and now - updated > ACTIVE_SECONDS:
            running = False
        if running:
            status = "running"
        else:
            status = "needs_input" if _needs_input(last_assistant) else "done"
        tasks.append(
            {
                "id": "dsh:" + session_id,
                "source": "DSH",
                "title": _summarize(title, 60) or session_id,
                "detail": _summarize(last_assistant),
                "status": status,
                "updated": updated,
            }
        )
    return tasks


def _first_text_from_user(plain_path):
    try:
        with open(plain_path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if record.get("type") == "user/message":
                    return _first_text(record.get("data", {}).get("content"))
    except OSError:
        pass
    return ""


def _codex_tasks(home, now, limit=20):
    root = Path(home) / ".codex" / "sessions"
    files = []
    if root.is_dir():
        for archive in root.rglob("rollout-*.jsonl"):
            files.append(archive)
    files.sort(key=_mtime, reverse=True)
    tasks = []
    for archive in files[:limit]:
        events = _latest_events(
            archive, ("session_meta", "task_started", "task_complete")
        )
        if not events["session_meta"]:
            continue
        meta = events["session_meta"][0]
        title = ""
        detail = ""
        updated = 0
        for payload in events["task_started"]:
            updated = max(updated, payload.get("started_at") or 0)
        for payload in events["task_complete"]:
            updated = max(updated, payload.get("completed_at") or 0)
            detail = payload.get("last_agent_message") or detail
        if not updated:
            updated = _mtime(archive)
        if now - updated > MAX_AGE_SECONDS:
            continue
        title = _summarize(title or meta.get("cwd") or meta.get("id") or archive.stem, 60)
        running = (
            len(events["task_started"]) > len(events["task_complete"])
            and now - updated < CODEX_ACTIVE_SECONDS
        )
        if running:
            status = "running"
        else:
            status = "needs_input" if _needs_input(detail) else "done"
        tasks.append(
            {
                "id": "codex:" + (meta.get("id") or archive.stem),
                "source": "Codex",
                "title": title,
                "detail": _summarize(detail),
                "status": status,
                "updated": updated,
            }
        )
    return tasks


def valid_task(task):
    return (
        isinstance(task, dict)
        and isinstance(task.get("id"), str)
        and bool(task["id"])
        and len(task["id"]) <= 128
        and isinstance(task.get("source"), str)
        and task["source"] in ("DSH", "Codex")
        and isinstance(task.get("title"), str)
        and isinstance(task.get("detail"), str)
        and task.get("status") in ("running", "done", "needs_input")
        and isinstance(task.get("updated"), (int, float))
        and 0 <= task["updated"] <= 4_102_444_800
    )


def clean_push(payload):
    """校验并清洗 /api/agents-push 请求体；非法返回 None。"""
    if not isinstance(payload, dict) or set(payload) - {"agents", "pushed_at"}:
        return None
    agents = payload.get("agents")
    if not isinstance(agents, list) or len(agents) > PUSH_MAX_TASKS:
        return None
    pushed_at = payload.get("pushed_at")
    if not isinstance(pushed_at, (int, float)) or not 0 <= pushed_at <= 4_102_444_800:
        return None
    cleaned = []
    seen = set()
    for task in agents:
        if not valid_task(task) or task["id"] in seen:
            return None
        seen.add(task["id"])
        cleaned.append(
            {
                "id": task["id"],
                "source": task["source"],
                "title": _summarize(task["title"], 60),
                "detail": _summarize(task["detail"]),
                "status": task["status"],
                "updated": task["updated"],
            }
        )
    return {"agents": cleaned, "pushed_at": pushed_at}


def save_push(path, payload):
    """原子写入推送快照。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False))
    temporary.replace(path)


class AgentBoard:
    """聚合 DSH 与 Codex 的任务看板，带缓存和状态变化回调。

    push_path 指向 DSH 插件推送的快照文件；本机解析与推送按 id 合并，
    推送侧优先（树莓派上通常只有推送数据）。
    """

    def __init__(self, home=None, cache_dir="/tmp/pidesk-agents", interval=15, push_path=None):
        self.home = home or os.path.expanduser("~")
        self.cache_dir = Path(cache_dir)
        self.interval = interval
        self.push_path = Path(push_path) if push_path else None
        self._cache = None
        self._cache_at = 0
        self._previous = None
        self.on_change = None  # callable(task_status_mapping)

    def invalidate(self):
        """推送到达后调用，让下一次 snapshot 立即重算。"""
        self._cache_at = 0

    def _pushed_tasks(self, now):
        if not self.push_path:
            return []
        try:
            payload = json.loads(self.push_path.read_text())
        except (OSError, ValueError):
            return []
        if not isinstance(payload, dict):
            return []
        return [
            task
            for task in payload.get("agents") or []
            if valid_task(task) and now - task["updated"] <= MAX_AGE_SECONDS
        ]

    def snapshot(self):
        now = time.time()
        if self._cache is not None and now - self._cache_at < self.interval:
            return self._cache
        try:
            tasks = _dsh_tasks(self.home, self.cache_dir, now) + _codex_tasks(self.home, now)
        except Exception as error:  # 解析失败不影响主界面
            logging.warning("Agent board failed: %s", error)
            tasks = self._cache or []
        try:
            pushed = self._pushed_tasks(now)
        except Exception as error:
            logging.warning("Agent push read failed: %s", error)
            pushed = []
        if pushed:
            local_ids = {task["id"] for task in tasks}
            tasks = tasks + [task for task in pushed if task["id"] not in local_ids]
        tasks.sort(key=lambda item: item["updated"], reverse=True)
        self._cache = tasks
        self._cache_at = now
        current = {task["id"]: task["status"] for task in tasks}
        first = self._previous is None
        previous = self._previous or {}
        if current != previous:
            changed = {
                task_id: (status, previous.get(task_id))
                for task_id, status in current.items()
                if previous.get(task_id) != status
            }
            self._previous = current
            # 首次快照只建基线，不当作"新完成"触发提示音
            if changed and not first and self.on_change:
                try:
                    self.on_change(changed)
                except Exception as error:
                    logging.warning("Agent change callback failed: %s", error)
        return self._cache


def token_matches(expected, provided):
    if not expected or not provided:
        return False
    return hmac.compare_digest(expected, provided)
