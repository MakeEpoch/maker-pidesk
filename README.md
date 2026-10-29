# pidesk

树莓派桌面信息屏：时钟、日期、当前天气、年度进度，以及可选的月历或三天天气。
控制网页提供实时预览、四向旋转、右侧模块切换和喇叭声音测试。

当前硬件：Raspberry Pi 3B、KeDei 3.5 寸 V6.2（480×320 SPI）、3.5mm 音频输出。
当前验证系统：Raspberry Pi OS Lite Trixie 64 位，Linux 6.18.50+rpt-rpi-v8。

## 项目结构

```text
app/               树莓派应用（后端与前端同一次发布）
  src/pidesk/        Python 后端
  web/               前端 HTML/CSS/JS
  config/            示例配置
plugin/pidesk-sync/  DSH 宿主插件：聚合 DSH/Codex 任务推送到本屏（独立 npm 包，
                     不进入发布包）
driver/kedei/       实机使用的内核驱动、overlay、维护工具（独立编译安装）
ops/                安装、部署、打包与硬件检查
  scripts/           检查、打包、部署、安装脚本
  deploy/systemd/    应用和驱动启动单元
  tools/             需要树莓派环境的浏览器集成检查
tests/              离线自动化测试
docs/               开发、部署、硬件及接口说明
```

`AGENTS.md` 是给协作者的约束与文档入口，改动前先读。

## 本地开发

Python 3.9 及以上。在项目根目录执行：

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'
make check
make preview
```

打开 `http://127.0.0.1:8765/`。端口占用时用 `make preview PORT=8766`。
预览默认离线，不启动 Chromium、不访问 framebuffer，也不调用天气/IP API。
配置写入被忽略的 `var/config.json`；缺少天气缓存时不伪造天气数据。
Mac 上没有 `/proc` 的指标会显示缺省值；声音按钮需要在树莓派上使用。

## 树莓派部署

现有设备应用更新：

```sh
make check
make deploy HOST=pi@your-pi.local
```

部署脚本使用 SSH/SCP，密码由终端交互输入或使用 SSH 密钥，不在项目保存。
它只安装应用，保留 `/etc/pidesk-dashboard.json`、天气缓存和现有驱动；
安装前备份旧应用及服务单元，启动检查失败时回退。首次安装见
[部署说明](docs/deployment.md)。整理项目本身不会执行远程部署。

服务名继续使用 `pidesk-html.service`。运行目录：

- `/opt/pidesk-dashboard/src/pidesk/`：正式应用与网页
- `/etc/pidesk-dashboard.json`：设备配置，含方向和右侧模块
- `/var/lib/pidesk-dashboard/`：天气缓存、Chromium profile
- `/run/pidesk-html/`：运行日志和帧指标
- `/run/pidesk-dashboard.png`：最后一次写屏前的软件截图

## 常用命令

```sh
make help
make package
sudo systemctl status pidesk-html.service
sudo journalctl -u pidesk-html.service -n 30 --no-pager
```

[开发及模块说明](docs/development.md) · [接口](docs/api.md) ·
[硬件与维护](docs/hardware.md) · [界面说明](docs/ui.md)

## 已知限制

SPI 全屏更新较慢，页面使用静态内容及变化区域刷新；没有动画。
实机暗色照片出现偏色，模式切换及降速未改善，因此照片/背景和画面亮度功能已移除。
触摸未启用。当前网页用于局域网，没有账户登录。

天气来自 Open-Meteo，定位使用已授权的 ipwho.is；只接受配置国家的定位结果，
其余使用示例配置中的南京回退位置；请按实际需要修改 `app/config/pidesk.example.json`（已安装设备修改 `/etc/pidesk-dashboard.json`）。天气不是现场观测或预警信息。

## 来源与许可证

应用代码与自有插件采用 MIT；KeDei 驱动保留 GPL-2.0 声明与原始许可证，
见 [第三方说明](THIRD_PARTY_NOTICES.md)。
