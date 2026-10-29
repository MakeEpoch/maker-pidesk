# 开发说明

## 模块边界

| 路径 | 职责 |
|---|---|
| `app/src/pidesk/app.py` | 命令入口、状态与设置、HTTP、主渲染循环 |
| `app/src/pidesk/browser.py` | Chromium 生命周期、CDP、页面就绪与截图 |
| `app/src/pidesk/framebuffer.py` | RGB565、无缩放旋转、变化区域写屏 |
| `app/src/pidesk/weather.py` | IP 定位、天气获取、缓存及后台刷新 |
| `app/src/pidesk/storage.py` | 默认配置及 JSON 读写 |
| `app/src/pidesk/system.py` | CPU、内存、温度及 IP |
| `app/src/pidesk/audio.py` | 内存生成提示音、ALSA 播放及并发保护 |
| `app/src/pidesk/agents.py` | 代理任务看板：聚合 DSH/Codex 会话与推送快照，见 [agents.md](agents.md) |
| `app/web/` | HTML/CSS/JS，无前端构建或外部 CDN |

使用 `python -m pidesk` 或安装后的 `pidesk` 命令。
`python -m pidesk --help` 查看参数。

## 本地预览

`make preview` 等价于使用独立 `var/` 配置和缓存，运行
`PYTHONPATH=src python3 -m pidesk --web-only --offline --host 127.0.0.1 ...`。
它不初始化 GPIO、framebuffer、Chromium 或 Pi 用户账户；适用于 Mac/Linux。
离线模式不启动定位及天气线程。可放入真实天气缓存到 `var/weather.json`。

`--web-only` 单独使用会启动天气刷新，请先审阅自己的定位配置。
本机没有 ALSA 时声音测试会明确失败，不会模拟播放成功。

## 验证

`make check` 检查 Python/JS/shell 语法、示例 JSON，并执行离线单元及 HTTP 测试。
测试使用临时配置、模拟天气响应及模拟音频进程，不访问外部 API、物理屏或喇叭。

在树莓派上，`make hardware-check` 使用现有 Chromium 的独立标签和临时 HTTP
服务测试控制区、月历、预报、方向和手机宽度，不修改正在运行的页面或生产配置。
它只读已有天气缓存；缓存不存在时预报条目数量检查可能无法通过。
声音实物验收通过真实控制页按钮进行；这会播放 1.8 秒测试音。

`python -m pidesk --probe /tmp/pidesk-probe.png` 仅跳过 framebuffer 写入，
仍需树莓派的 Chromium、目录权限及 pi 账户。它使用生产 profile/端口，
运行前应停服务或安排维护，不能把它当作本地离线预览。

修改网页后，实机约 5 秒自动重载；电脑控制网页手动刷新。

## 迁移说明

原 `dashboard/html_display.py` 已拆为 `app/src/pidesk/` 包；旧 `pidesk.py` 的共用逻辑
提取到独立模块，旧 Pillow 绘图留在归档。运行时配置、缓存路径、服务名及 API 保持。
历史试验资料不包含在公开仓库中。

## 代码格式

Python 使用 pyproject.toml 中的 Ruff 配置；网页使用固定版本 Prettier，配置为
`.prettierrc.json`，依赖锁定于 package-lock.json。开发环境执行
`python -m pip install -e '.[dev]'`、`npm ci` 后可用 `make format`。
Node 和格式化工具只用于开发，不是树莓派运行依赖。
