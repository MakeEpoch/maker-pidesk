# KeDei V6.2 驱动

这里是正式版本，仅保留当前实机使用的 Linux 6.18 GPIO descriptor 移植、
overlay、头文件、Makefile 和维护工具。文件来源和许可证见根目录
`THIRD_PARTY_NOTICES.md` 与本目录 `LICENSE`。

- `fb_kedei62_linux618.c`：变化行内区域刷新，16-bit RGB565
- `kedei62-native.dts`：GPIO7 CS、GPIO8 latch、16 MHz、驱动方向 0
- `bin/kedei62-console`：按驱动名绑定虚拟控制台并关闭光标闪烁
- `bin/pidesk-kedei-start`：正常启动之后加载驱动及 runtime overlay
- `bin/kedei62-rebuild`：用指定内核的已安装头文件重新构建模块

首次安装由项目根目录 `ops/scripts/install-driver.sh` 执行，应用更新不调用它。
上游版本及来源见仓库根目录的第三方说明。
不将试验驱动编译产物放进正式目录。
