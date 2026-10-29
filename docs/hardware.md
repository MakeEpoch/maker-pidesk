# 硬件与已知问题

当前验证组合：Raspberry Pi 3 Model B V1.2、KeDei V6.2 2016/6/1
SPI TFT，480×320 RGB565，Trixie 64 位、Linux 6.18.50+rpt-rpi-v8。
蓝色 Waveshare LCD(A) V3 不使用此驱动。

SPI 芯片选择 GPIO7，独立 latch GPIO8；SPI 16 MHz。驱动方向固定 0，
网页层完成 0/90/180/270 度无缩放旋转。驱动和应用均仅写变化的行内区域，
全屏刷新仍然明显，`fps=10` 不是实测全屏帧率。

`pidesk-kedei.timer` 开机约 30 秒后加载驱动，先让网络/SSH 有机会启动。
GPIO overlay 不写进早期启动配置。触摸未启用。

3.5mm 输出已由用户确认能出声，设备为 `plughw:CARD=Headphones,DEV=0`。
本地网页的声音按钮在树莓派播放，不在浏览器电脑播放。

暗部照片有明显偏色。RGB565 结果与 framebuffer 回读一致，纯红绿蓝正常。
降低遮罩、改变倾角、临时正常色彩模式和 8 MHz 未改善；已恢复原驱动和
16 MHz。具体控制器/面板原因未定位，不把软件截图当作物理显示正确的证据。
用户已移除照片、背景及画面亮度控制，当前纯黑静态页面。

供电不足曾有日志记录，未证明它是偏色或刷新可见的原因。若出现新问题，
可检查 `vcgencmd get_throttled`、`journalctl -k`，避免仅凭历史记录归因。
