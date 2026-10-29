import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from pidesk.agents import (
    AgentBoard,
    _codex_tasks,
    _dsh_tasks,
    clean_push,
    save_push,
    token_matches,
)


def write_lines(path, lines):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.now = time.time()

    def tearDown(self):
        self.directory.cleanup()

    def test_dsh_running_and_done(self):
        session = self.root / ".dsh" / "sessions" / "ws" / "session-abc"
        archive = session / "session.v4.jsonl.zstd"
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b"zstd")
        with patch("pidesk.agents.subprocess.run") as run:
            run.return_value.returncode = 0
            plain = self.root / "plain.jsonl"
            write_lines(
                plain,
                [
                    {"type": "session", "time": 1, "data": {"id": "session-abc"}},
                    {
                        "type": "user/message",
                        "data": {"content": [{"type": "text", "text": "帮我修 bug"}]},
                    },
                    {"type": "session/title", "data": {"title": "修 bug"}},
                    {"type": "turn/start", "time": int((self.now - 10) * 1000)},
                    {
                        "type": "assistant/message",
                        "time": int((self.now - 10) * 1000),
                        "data": {
                            "message": {
                                "role": "assistant",
                                "content": [{"type": "text", "text": "正在修"}],
                            }
                        },
                    },
                ],
            )
            run.return_value.stdout = plain.read_bytes()
            tasks = _dsh_tasks(self.root, self.root / "cache", self.now)
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["status"], "running")
        self.assertEqual(tasks[0]["title"], "修 bug")
        self.assertEqual(tasks[0]["detail"], "正在修")

    def test_dsh_closed_turn_with_question_is_needs_input(self):
        session = self.root / ".dsh" / "sessions" / "ws" / "session-q"
        archive = session / "session.v4.jsonl.zstd"
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b"zstd")
        with patch("pidesk.agents.subprocess.run") as run:
            plain = self.root / "plain.jsonl"
            write_lines(
                plain,
                [
                    {"type": "session/title", "data": {"title": "确认"}},
                    {"type": "turn/start", "time": int((self.now - 60) * 1000)},
                    {
                        "type": "assistant/message",
                        "time": int((self.now - 60) * 1000),
                        "data": {
                            "message": {
                                "role": "assistant",
                                "content": [{"type": "text", "text": "要用方案A还是方案B？"}],
                            }
                        },
                    },
                    {"type": "turn/end", "time": int((self.now - 60) * 1000)},
                ],
            )
            run.return_value.stdout = plain.read_bytes()
            tasks = _dsh_tasks(self.root, self.root / "cache", self.now)
        self.assertEqual(tasks[0]["status"], "needs_input")

    def test_dsh_idle_session_is_done(self):
        session = self.root / ".dsh" / "sessions" / "ws" / "session-old"
        archive = session / "session.v4.jsonl.zstd"
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b"zstd")
        with patch("pidesk.agents.subprocess.run") as run:
            plain = self.root / "plain.jsonl"
            write_lines(
                plain,
                [
                    {"type": "session/title", "data": {"title": "旧任务"}},
                    {
                        "type": "assistant/message",
                        "time": int((self.now - 3600) * 1000),
                        "data": {
                            "message": {
                                "role": "assistant",
                                "content": [{"type": "text", "text": "完成"}],
                            }
                        },
                    },
                ],
            )
            run.return_value.stdout = plain.read_bytes()
            tasks = _dsh_tasks(self.root, self.root / "cache", self.now)
        self.assertEqual(tasks[0]["status"], "done")

    def test_codex_task_progress(self):
        rollout = self.root / ".codex" / "sessions" / "2026" / "10" / "25" / "rollout-x.jsonl"
        write_lines(
            rollout,
            [
                {"type": "session_meta", "payload": {"id": "cx1", "cwd": "/work/project"}},
                {
                    "type": "event_msg",
                    "payload": {"type": "task_started", "started_at": self.now - 30},
                },
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "task_complete",
                        "completed_at": self.now - 20,
                        "last_agent_message": "全部测试通过",
                    },
                },
            ],
        )
        tasks = _codex_tasks(self.root, self.now)
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["status"], "done")
        self.assertEqual(tasks[0]["detail"], "全部测试通过")

    def test_codex_open_task_is_running(self):
        rollout = self.root / ".codex" / "sessions" / "2026" / "10" / "25" / "rollout-y.jsonl"
        write_lines(
            rollout,
            [
                {"type": "session_meta", "payload": {"id": "cx2", "cwd": "/work/other"}},
                {
                    "type": "event_msg",
                    "payload": {"type": "task_started", "started_at": self.now - 30},
                },
            ],
        )
        tasks = _codex_tasks(self.root, self.now)
        self.assertEqual(tasks[0]["status"], "running")

    def test_codex_question_final_message_is_needs_input(self):
        rollout = self.root / ".codex" / "sessions" / "2026" / "10" / "25" / "rollout-z.jsonl"
        write_lines(
            rollout,
            [
                {"type": "session_meta", "payload": {"id": "cx3", "cwd": "/work/ask"}},
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "task_complete",
                        "completed_at": self.now - 20,
                        "last_agent_message": "要继续执行吗？",
                    },
                },
            ],
        )
        tasks = _codex_tasks(self.root, self.now)
        self.assertEqual(tasks[0]["status"], "needs_input")

    def test_board_first_snapshot_does_not_notify(self):
        board = AgentBoard(home=str(self.root), cache_dir=self.root / "cache", interval=0)
        events = []
        board.on_change = lambda changed: events.append(changed)
        with patch("pidesk.agents._dsh_tasks", return_value=[]), patch(
            "pidesk.agents._codex_tasks", return_value=[]
        ):
            board.snapshot()
        self.assertEqual(events, [])

    def test_board_notifies_on_transition_to_done(self):
        board = AgentBoard(home=str(self.root), cache_dir=self.root / "cache", interval=0)
        events = []
        board.on_change = lambda changed: events.append(changed)
        running = [
            {
                "id": "t1",
                "source": "DSH",
                "title": "x",
                "detail": "",
                "status": "running",
                "updated": 1,
            }
        ]
        done = [
            {
                "id": "t1",
                "source": "DSH",
                "title": "x",
                "detail": "",
                "status": "done",
                "updated": 2,
            }
        ]
        with patch("pidesk.agents._dsh_tasks", return_value=running), patch(
            "pidesk.agents._codex_tasks", return_value=[]
        ):
            board.snapshot()
        with patch("pidesk.agents._dsh_tasks", return_value=done), patch(
            "pidesk.agents._codex_tasks", return_value=[]
        ):
            board.snapshot()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["t1"][0], "done")

    def test_board_merges_pushed_tasks(self):
        push_path = self.root / "push.json"
        save_push(
            push_path,
            {
                "pushed_at": self.now - 5,
                "agents": [
                    {
                        "id": "codex:remote",
                        "source": "Codex",
                        "title": "远程任务",
                        "detail": "来自插件",
                        "status": "running",
                        "updated": self.now - 5,
                    }
                ],
            },
        )
        board = AgentBoard(
            home=str(self.root), cache_dir=self.root / "cache", interval=0, push_path=push_path
        )
        local = [
            {
                "id": "dsh:local",
                "source": "DSH",
                "title": "本地",
                "detail": "",
                "status": "done",
                "updated": self.now - 1,
            }
        ]
        with patch("pidesk.agents._dsh_tasks", return_value=local), patch(
            "pidesk.agents._codex_tasks", return_value=[]
        ):
            tasks = board.snapshot()
        self.assertEqual({task["id"] for task in tasks}, {"dsh:local", "codex:remote"})

    def test_board_keeps_tasks_after_push_goes_quiet(self):
        """推送停了也继续展示已有任务：不再判断客户端是否断线。"""
        push_path = self.root / "push.json"
        save_push(
            push_path,
            {
                "pushed_at": self.now - 3600,
                "agents": [
                    {
                        "id": "codex:remote",
                        "source": "Codex",
                        "title": "远端",
                        "detail": "",
                        "status": "done",
                        "updated": self.now - 60,
                    }
                ],
            },
        )
        board = AgentBoard(
            home=str(self.root), cache_dir=self.root / "cache", interval=0, push_path=push_path
        )
        with patch("pidesk.agents._dsh_tasks", return_value=[]), patch(
            "pidesk.agents._codex_tasks", return_value=[]
        ):
            tasks = board.snapshot()
        self.assertEqual([task["id"] for task in tasks], ["codex:remote"])

    def test_clean_push_validation(self):
        good = {
            "pushed_at": self.now,
            "agents": [
                {
                    "id": "dsh:x",
                    "source": "DSH",
                    "title": "t",
                    "detail": "d",
                    "status": "running",
                    "updated": self.now - 1,
                }
            ],
        }
        self.assertEqual(clean_push(good)["agents"][0]["id"], "dsh:x")
        self.assertIsNone(clean_push({"agents": []}))  # 缺 pushed_at
        self.assertIsNone(clean_push({**good, "extra": 1}))  # 多余字段
        # 晚到的推送照收：不再用与服务器时间的偏差窗口拒绝
        self.assertIsNotNone(clean_push({**good, "pushed_at": self.now - 9999}))
        bad_status = {
            "pushed_at": self.now,
            "agents": [
                {
                    "id": "dsh:x",
                    "source": "DSH",
                    "title": "t",
                    "detail": "d",
                    "status": "paused",
                    "updated": self.now,
                }
            ],
        }
        self.assertIsNone(clean_push(bad_status))
        bad_source = {
            "pushed_at": self.now,
            "agents": [
                {
                    "id": "x",
                    "source": "Other",
                    "title": "t",
                    "detail": "d",
                    "status": "done",
                    "updated": self.now,
                }
            ],
        }
        self.assertIsNone(clean_push(bad_source))
        duplicate = {
            "pushed_at": self.now,
            "agents": [good["agents"][0], good["agents"][0]],
        }
        self.assertIsNone(clean_push(duplicate))

    def test_token_matches(self):
        self.assertTrue(token_matches("secret", "secret"))
        self.assertFalse(token_matches("secret", "wrong"))
        self.assertFalse(token_matches("", "x"))
        self.assertFalse(token_matches("secret", ""))


if __name__ == "__main__":
    unittest.main()
