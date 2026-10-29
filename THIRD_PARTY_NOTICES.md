# 第三方来源

## KeDei 驱动

`driver/kedei/fb_kedei62_linux618.c` 基于 Tong Zhang 的 KeDei V6.2 FBTFT 驱动，
移植到 Linux 6.18 GPIO descriptor 接口，包含变化行内区域刷新支持。
`fbtft.h` 来自 Linux Raspberry Pi FBTFT 接口。保留各文件版权及 SPDX 声明，
许可证见 `driver/kedei/LICENSE`（GPL v2）。

- https://github.com/lzto/FBTFT_KeDei_35_lcd_v62
- https://github.com/lzto/RaspberryPi_KeDei_35_lcd_v62
- https://github.com/raspberrypi/linux

驱动目录内保留上游版权与 GPL-2.0 许可声明；应用和插件采用各自的 MIT 许可证。

## 数据来源

- 天气：Open-Meteo，https://open-meteo.com/ ，CC BY 4.0。
- IP 定位：ipwho.is，https://ipwhois.io/documentation 。

字体来自目标系统安装包：Noto Sans CJK SC、DejaVu Sans/Mono、Unifont。
项目不内嵌字体、Chromium 或 Python 第三方库；它们遵循各自许可证。
