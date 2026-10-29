# 部署与回退

## 已配置好的树莓派

在开发机运行 `make deploy HOST=pi@your-pi.local`。脚本生成发布包，上传到远端
临时目录，再交互执行 `sudo bash ops/scripts/install.sh`。SSH、sudo 自行输入凭据。

也可将源码包复制到 Pi，解压后执行 `sudo bash ops/scripts/install.sh`。
安装过程保留配置和状态目录，不构建或重载驱动。
服务改为从 `/opt/pidesk-dashboard/src` 执行 Python 包。

开始前检查：`make check`，并确认目标是正确的设备。
安装输出 `/var/backups/pidesk-install.XXXXXX` 备份路径。
启动检查包括服务状态、HTTP 状态接口和首次实际渲染后的帧指标。

## 全新设备

1. 使用 Raspberry Pi OS Lite 64 位，配置网络和 SSH，创建 `pi` 用户。
2. 解压本项目发布包，执行 `sudo bash ops/scripts/install-deps.sh` 安装应用依赖。
3. 确认屏幕为 KeDei V6.2；其他屏幕不要使用该驱动。
4. 安装 `build-essential`、`device-tree-compiler` 和与 `uname -r` 完全匹配的内核头文件。
   确认 `/lib/modules/$(uname -r)/build/Makefile` 存在。
5. 执行 `sudo bash ops/scripts/install-driver.sh`。它构建当前内核模块、overlay 和
   辅助工具，备份旧驱动，启用延迟初始化定时器，不编辑 `config.txt`。
6. 执行 `sudo bash ops/scripts/install.sh` 安装应用，首次才复制示例配置。
7. 访问 `http://<pi-address>:8765/`。按需要设置方向及右侧内容，点击声音测试。

应用以 root 运行以访问 framebuffer/tty；Chromium 和 aplay 以普通 pi 用户运行。
该项目沿用已验证的局域网本地页面模型，不用于浏览任意外部页面。

## 维护

```sh
systemctl is-active pidesk-html.service
systemctl is-enabled pidesk-html.service pidesk-kedei.timer
journalctl -u pidesk-html.service -n 50 --no-pager
cat /run/pidesk-html/metrics.json
cat /proc/fb
```

正常更新只需要部署应用。内核升级后，驱动需针对新内核及头文件重新构建：

```sh
sudo /usr/local/sbin/kedei62-rebuild "$(uname -r)"
```

重载驱动会影响显示，应在维护时进行。当前驱动仅验证 Linux 6.18。

## 手动回退应用

自动安装失败会还原旧应用和服务单元。手动回退时，将下面备份路径换为
安装输出的准确目录；回退过程中不覆盖 `/etc/pidesk-dashboard.json`。

```sh
sudo systemctl stop pidesk-html.service
sudo mv /opt/pidesk-dashboard /opt/pidesk-dashboard.failed
sudo cp -a /var/backups/pidesk-install.XXXXXX/application /opt/pidesk-dashboard
sudo cp -a /var/backups/pidesk-install.XXXXXX/pidesk-html.service /etc/systemd/system/pidesk-html.service
sudo systemctl daemon-reload
sudo systemctl start pidesk-html.service
```

首次安装的备份可能没有旧应用/单元，应先检查备份内容。不要复制此回退命令中的
占位符直接执行；若 `.failed` 目录已存在，另选唯一名称。
