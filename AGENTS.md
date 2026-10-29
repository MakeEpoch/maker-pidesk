# AGENTS.md

本文件只放**约束**与**文档索引**。具体实现细节、协议、参数一律写在 `docs/`，
新增知识请补到对应文档并在下方索引登记，不要把细节堆在这里。

## 项目是什么

树莓派桌面信息屏（Raspberry Pi 3B + KeDei 3.5 寸 480×320 SPI 屏）。
Python 应用渲染网页并写 framebuffer；右侧「智能体任务」模块展示 DSH / Codex
的任务进度。硬件、屏幕、驱动相关见 [docs/hardware.md](docs/hardware.md)。

## 目录约定

按**可独立交付的单元**划分，不要按“后端/前端”这类内部概念再拆：

| 目录 | 是什么 | 交付方式 |
|---|---|---|
| `app/` | 树莓派应用：`src/pidesk/` 后端 + `web/` 前端 + `config/` 示例配置 | 同一次发布，`make deploy` |
| `driver/kedei/` | 内核驱动、overlay、维护工具 | 独立编译安装，与 Python 无关 |
| `ops/` | 安装、部署、打包、硬件检查脚本与 systemd 单元 | 只在开发机/部署时运行 |
| `tests/` | 应用离线测试 | — |
| `docs/` | 开发、部署、硬件、接口说明 | — |

约束：

- 前端 `app/web/` 源码在 Python 包外，但**与后端同一次发布**。安装脚本把它
  放进包内 `pidesk/web`；`app.py` 的 `_asset_root()` 兼顾两种布局。不要为此
  拆成两个发布流程。
- 新增可独立交付的单元就新建顶层目录，不要塞进 `ops/` 或 `app/`。
- 运行时产物（`var/`、`dist/`）不入库。

### DSH 插件

DSH 同步插件独立维护在 [dsh-plugin-pidesk-sync](https://github.com/MakeEpoch/dsh-plugin-pidesk-sync)；请在该仓库打包安装和测试，不要链接源码到 profile。

## 硬约束

### 运行时

- **Python 3.9+**；树莓派运行态依赖 Pillow、NumPy、websocket-client 和本项目。
  Node / Prettier / Ruff **只是开发工具**，不得成为设备运行依赖。
- 网页无前端构建、无外部 CDN，纯静态 HTML/CSS/JS。
- 树莓派上服务名固定 `pidesk-html.service`，配置在 `/etc/pidesk-dashboard.json`。

### 代理任务看板（最容易踩错的一块）

- 看板数据是**只读聚合**：解析会话文件 + 读取推送快照，**绝不写回** DSH/Codex 目录。
- 任务状态只有三个值：`running` / `done` / `needs_input`；`source` 只有 `DSH` / `Codex`。
  pidesk 侧校验是**整批严格**的——任一字段不合法，整批被拒（`clean_push`）。
- 合并规则以代码为准：**本机解析优先，推送侧同 id 被丢弃**（`AgentBoard.snapshot`）。
  docstring 里“推送侧优先”的说法与实现不符，改动前先确认哪个是期望行为。
- **看板不判断推送方是否断线。** `pushed_at` 不参与任何判定，也不与服务器时间
  比对；任务生命周期只由 `updated` 与 `MAX_AGE_SECONDS` 决定。不要再加回
  “同步中断”之类的超时提示或心跳要求。

### 改动纪律

- **有逻辑变更必须同步更新文档。** 改行为、协议、常量、配置项、默认值、
  判定规则时，同一次改动里更新 `docs/` 对应文件；新增子系统要新建文档并在
  下方索引登记。代码与文档不一致视为未完成。
- 只改文档措辞、注释、格式而无行为变化的，不需要动 `docs/`。
- 改完必须跑 `make check`（语法 + 示例配置 + 离线单元/HTTP 测试）。
- 测试**不得访问**外部 API、物理屏、喇叭、真实 /proc 之外的硬件。
- 本地预览用 `make preview`（离线、`--web-only`），**不碰** GPIO/framebuffer/Chromium。
- 部署走 `make deploy HOST=pi@<ip>`；脚本保留设备配置与天气缓存，失败会回退。
  **不要**在整理或改代码时顺手执行远程部署。
- 不要在仓库里保存密码/token；设备 token 在设备配置里，插件侧是 secret 字段。

## 文档索引

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 项目概览、结构、常用命令、已知限制 |
| [docs/development.md](docs/development.md) | 模块边界、本地预览、验证方式、代码格式 |
| [docs/api.md](docs/api.md) | 控制接口（`/api/state`、`/api/settings`、声音测试等） |
| [docs/agents.md](docs/agents.md) | **代理任务看板**：数据来源、推送协议、状态判定、跨机推送 |
| [docs/deployment.md](docs/deployment.md) | 首次安装与部署 |
| [docs/hardware.md](docs/hardware.md) | 硬件、驱动、维护 |
| [docs/ui.md](docs/ui.md) | 界面说明 |
| [docs/verification.md](docs/verification.md) | 验证流程 |
| [dsh-plugin-pidesk-sync](https://github.com/MakeEpoch/dsh-plugin-pidesk-sync) | 独立 DSH 宿主插件：聚合与推送、Bark 手机通知、配置项 |

## 已知问题

- `agents.py` 模块 docstring 声称“推送侧优先”，实现是“本机优先”。以代码为准，
  改语义时两处一起改。
- 多台机器同时推送会互相覆盖（一次推送是整批快照），当前不支持，
  改造方案见 [docs/agents.md](docs/agents.md#c-多台机器同时推送当前不支持的场景)。

跨机推送相关问题**先读 [docs/agents.md](docs/agents.md)**，再回答，不要凭印象。
