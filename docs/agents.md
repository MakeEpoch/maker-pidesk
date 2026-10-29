# 代理任务看板

信息屏右侧「智能体任务」模块的数据来源、协议与跨机推送方式。
实现见 `app/src/pidesk/agents.py`（屏幕侧）与 [dsh-plugin-pidesk-sync](https://github.com/MakeEpoch/dsh-plugin-pidesk-sync)（采集与推送侧）。

## 数据来源

看板同时吃三个来源，全部**只读**：

| 来源 | 位置 | 用途 |
|---|---|---|
| 推送快照 | pidesk 的 `push_path`（JSON 文件） | **跨机部署的主路径** |
| DSH 会话 | `~/.dsh/sessions/<workspace>/session-*/session.v4.jsonl.zstd` | 本机 DSH |
| Codex 会话 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 本机 Codex |

树莓派上通常只有推送快照（设备本身不跑 Agent）；工作站上推送与本地解析并存。

### 合并规则

`AgentBoard.snapshot()` 先算本机任务，再并入推送任务：

```python
local_ids = {task["id"] for task in tasks}
tasks = tasks + [task for task in pushed if task["id"] not in local_ids]
```

即 **本机解析优先，推送侧 id 相同的条目被丢弃**。合并后按 `updated` 降序
返回全部任务。

> 注意：`agents.py` 模块 docstring 写的是“推送侧优先”，与上面的实现相反。
> 以代码为准；若要改语义，两处必须同时修正。

## 任务字段

```json
{ "id": "codex:thread-abc", "source": "Codex", "title": "…",
  "detail": "…", "status": "running", "updated": 1698240000 }
```

| 字段 | 约束 |
|---|---|
| `id` | 非空字符串，≤128 字符，**同一批内唯一** |
| `source` | 仅 `DSH` 或 `Codex` |
| `title` | 字符串，落库时截断 60 字符 |
| `detail` | 字符串，落库时截断 120 字符 |
| `status` | 仅 `running` / `done` / `needs_input` |
| `updated` | 数字，Unix 秒，`0 ≤ updated ≤ 4102444800` |

## 状态判定

| 状态 | 判定 |
|---|---|
| `running` | 有未结束的 turn，且最近有输出（窗口内） |
| `done` | 任务已结束，最后一条助手回复**不以问句结尾** |
| `needs_input` | 任务已结束，最后一条助手回复**以问句结尾**（`？`/`?`，可含尾随引号括号） |

关键常量（`app/src/pidesk/agents.py`）：

| 常量 | 值 | 含义 |
|---|---|---|
| `ACTIVE_SECONDS` | 5 分钟 | 最近有输出视为进行中 |
| `CODEX_ACTIVE_SECONDS` | 5 分钟 | Codex 无 task 事件也判完成 |
| `MAX_AGE_SECONDS` | 24 小时 | 超过不再展示 |
| `PUSH_MAX_TASKS` | 50 | 单次推送任务上限 |

`running → done/needs_input` 的**边沿**会触发提示音（`needs_input` 三短音，
`done` 上行双音）。首次快照只建基线，不响。

### 不判断推送方是否断线

看板**不区分“推送方还活着”和“推送方停了”**。`pushed_at` 只作为记录保留，
不参与任何判定；界面不会因为推送停止而显示“同步中断”。

理由：落盘的快照本身就是持久数据，推送停了不代表任务消失。任务的生命周期
只由 `updated` 与 `MAX_AGE_SECONDS` 决定——一条任务过了 24 小时自然隐去，
不需要额外的心跳机制。

直接后果：**单次推送即可长期展示，不要求周期性心跳。** 用 hooks 推一次就行，
不必再配 cron 续命。

## 推送协议

```
POST /api/agents-push
Authorization: Bearer <agent_push_token>
Content-Type: application/json

{ "pushed_at": 1698240000, "agents": [ … ] }
```

- 令牌取设备配置 `agent_push_token`（`/etc/pidesk-dashboard.json`）；
  也接受 `X-Pidesk-Token` 头。未配置令牌时**一律拒绝**。
- 除了 `agents` / `pushed_at` **不接受其他顶层字段**。
- `pushed_at` 只校验类型与合理范围，**不与服务器时间比对**：晚到、补发、
  时钟略有偏差的推送都照收。它不再用于判断推送方是否断线。
- 请求体上限 64 KB；`Content-Type` 非 `application/json` 返回 415。
- 校验在 `clean_push()`，**任一条任务不合法则整批失败**，不是跳过坏条。
- 推送不走同源校验（跨机场景），但仍需令牌。

成功保存后立即重算看板并可能触发提示音。

## 谁来推：三条可选路径

### A. DSH 宿主插件（工作站，推荐）

`dsh-plugin-pidesk-sync` 定时（默认 15 秒）扫描本机 `~/.dsh` 与 `~/.codex`，
聚合成全量快照推给 pidesk。装法与配置项见
[插件说明](https://github.com/MakeEpoch/dsh-plugin-pidesk-sync)。

- 优点：全量、幂等、自带失败重试与缓存；可与 Bark 手机通知共用边沿判定。
- 局限：只读**本机**数据；`pidesk-sync` 是 DSH 插件，纯 Codex 环境无法使用。

### B. Codex hooks（不装插件）

Codex 自带 hooks 机制（`~/.codex/hooks.json` 或 `config.toml` 的 `[[hooks.x]]`）。
与状态相关的三个事件：

| 事件 | 时机 | 输入 | 映射状态 |
|---|---|---|---|
| `UserPromptSubmit` | 提示词提交后、处理前 | `prompt` | `running` |
| `Stop` | 一轮任务结束 | `last_assistant_message`、`stop_hook_active` | 结句是问句 → `needs_input`，否则 `done` |
| `SessionStart` | 会话启动/恢复/压缩 | 启动来源 | 用于标记存活 |

做法：hook 脚本从 stdin 读 JSON，组装上文格式后 `curl` 推送，并把完整快照
落盘。

**必须注意：**

1. 看板不做心跳判定（见「不判断推送方是否断线」），**不需要 cron 续命**。
   一次推送落盘后，任务会一直显示到 `MAX_AGE_SECONDS` 自然过期。
   想让长期停留的任务不残留，可以顺带用 cron 定时重推当前状态，但不是必需。
2. `Stop` hook 若输出 `decision: "block"` 会让 Codex **继续跑**，
   会造成死循环。推送脚本不要输出该字段。
3. hook 拿不到“正在执行中”的中间态，`running` 只在提示词提交那一刻表示。

### C. 多台机器同时推送（当前不支持的场景）

现在的合并是“本机优先 + 同 id 丢弃”，且一次推送是**整批快照**。
两台机器各自推全量会**互相覆盖**——屏幕上只会显示最后到达的那台。

真要做到多机并存，需要同时改两处：

1. 任务 `id` 加机器前缀（如 `<host>:codex:<thread>`），避免跨机撞 id；
2. 快照按来源（机器）分组保存合并，而不是整批覆盖。

改之前先补测试，现有 `tests/` 已覆盖 `clean_push` 的严格校验。

## 手机 / 手表通知

插件侧另有 Bark 通道，在 `running → done/needs_input` 边沿推送到手机，
锁屏时镜像到 Apple Watch。属于旁路：pidesk 不可达时照样推送。
详见[插件说明](https://github.com/MakeEpoch/dsh-plugin-pidesk-sync#手机--手表推送bark)。

## 排障

| 现象 | 检查点 |
|---|---|
| 推送返回 403 | `agent_push_token` 为空或不匹配 |
| 推送返回 400 | 任一任务字段越界（见「任务字段」）；含额外顶层字段 |
| 任务不显示 | 是否超过 `MAX_AGE_SECONDS`；id 是否与本机解析重复被丢弃 |
| 提示音不响 | 首次快照只建基线；`done ↔ needs_input` 抖动不重复触发 |
