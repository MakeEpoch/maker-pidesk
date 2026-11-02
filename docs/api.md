# 控制接口

同源 HTTP 服务默认监听 `0.0.0.0:8765`；局域网控制，无账户登录。
写请求必须为 `Content-Type: application/json`，设置接口最多 32768 字节，其余普通控制接口最多 2048 字节；存在 Origin 时
必须与 Host 相同。静态资源和状态禁用缓存。

| 方法 | 路径 | 请求 / 用途 |
|---|---|---|
| GET | `/api/state` | 时间、天气、日历、系统指标及设置 |
| POST | `/api/settings` | 部分更新，如 `{"rotation":180,"right_widget":"calendar"}` |
| POST | `/api/rotation` | 兼容入口，`{"angle":180}` |
| POST | `/api/sound-test` | `{}`，同步播放 1.8 秒测试音，成功 `{"ok":true}` |
| POST | `/api/agents-push` | 跨机推送任务看板，`Bearer` 令牌鉴权，见 [agents.md](agents.md) |

`rotation` 仅接受整数 0、90、180、270；`right_widget` 仅接受
`none`、`calendar`、`forecast`、`agents`、`photo`。未知字段或空设置更新返回 400。
配置原子写入 `/etc/pidesk-dashboard.json`，保留其他字段。

声音测试使用配置文件中的 ALSA `audio_device`；接口不接受文件、命令或设备参数。
并发播放返回 409；不可播放或超时返回 503；成功响应表示播放进程完成，
实物有无声音由使用者确认。该操作不会修改配置。

`/api/agents-push` 是唯一不做同源校验的写接口（跨机部署），改为校验
`agent_push_token`；请求体上限 64 KB，协议与校验规则见
[代理任务看板](agents.md)。

布局字段 `screen_layout` 使用版本 1 的双方向元素映射，保存到 `html_screen_layout`；
字段、边界和兼容规则见 [布局编辑器](layout-editor.md)。它与 `rotation` 可以同一次提交，
校验后原子写入；非法布局不会部分更新其他设置。

`POST /api/notify-test` 接受 `{"kind":"done"}` 或 `{"kind":"attention"}`，
使用当前已保存的通知音量和音效。`notify_volume` 为 0–1 范围内的非零数字，界面允许 5%–100%。
音效允许 `chime` / `double` / `soft` / `rising` / `bell` / `none`。
`color_gain_r/g/b` 允许 0.5–1.5，保存后立即作用于写屏输出。

`POST /api/photo` 支持 multipart 图片或原始图片体（JPG/PNG/WebP/BMP，最大 4MB），
`GET /photo` 获取当前照片。此上传接口独立限制请求体并校验 Origin。
整页背景与画面亮度未提供。
