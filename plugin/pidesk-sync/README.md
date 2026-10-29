# @dsh/pidesk-sync

DSH 会话任务看板推送：聚合本机 **DSH** 与 **Codex** 的任务进度，定时推送到
[PiDesk](https://github.com/MakeEpoch/maker-pidesk) 桌面信息屏（右侧「智能体任务」模块）。

## 数据来源（只读）

- **DSH**：优先宿主 `sessionQuery` 服务（精确、实时）；不可用时回退直读
  `~/.dsh/sessions/<workspace>/session-*/session.v4.jsonl.zstd`（Node 内建 zstd
  解压，按 mtime+size 缓存摘要，未变化的会话不重复解压）。
- **Codex**：`~/.codex/sessions/**/rollout-*.jsonl` 的 `task_started` /
  `task_complete` 事件（取最近修改的 20 个文件）。

## 任务状态

| 状态 | 判定 |
| --- | --- |
| `running` | turn 开始未结束（DSH）/ started 多于 complete（Codex），且 5 分钟内有输出 |
| `done` | 任务结束，最后回复非问句 |
| `needs_input` | 任务结束，最后回复以问句结尾（等待用户回答） |

超过 24 小时的任务不再推送；单次上限 50 个（与 pidesk 侧校验一致）。

## 推送协议

`POST <pidesk>/api/agents-push`，`Authorization: Bearer <token>`：

```json
{ "pushed_at": 1698240000, "agents": [ { "id": "dsh:session-x", "source": "DSH", "title": "…", "detail": "…", "status": "running", "updated": 1698239990 } ] }
```

pidesk 收到后立即重算看板；`running → done/needs_input` 的转变会触发提示音
（`needs_input` 播放三短音注意力音，`done` 播放上行双音）。
看板不对推送做心跳判定：推送停了界面不会报“同步中断”，已有任务继续显示到
超过 24 小时自然隐去。协议细节见 [docs/agents.md](https://github.com/MakeEpoch/maker-pidesk/blob/main/docs/agents.md)。

## 手机 / 手表推送（Bark）

任务结束（`running → done/needs_input`）时额外推一条通知到手机，锁屏时配对的
Apple Watch 会同步收到。

**为什么是 Bark**：Apple Watch 没有独立推送通道，通知只能经 APNs 到 iPhone 再
由系统镜像到手表，而 APNs 的推送凭据是绕不开的卡点。Bark 把它做掉了——公共实例
`https://api.day.app` 直接用，不需要 Apple 开发者账号；自托管
[bark-server](https://github.com/Finb/bark-server) 也硬编码了它自己的
topic/keyID/teamID 与 .p8，同样不需要你的账号，改 `notifyServer` 地址即可。

准备：iPhone 装 [Bark](https://apps.apple.com/cn/app/id1403753865)，首页复制 key。
手表端无需安装任何东西；通知在 iPhone 锁屏/息屏时镜像过去（iPhone 正亮屏在用则
只给手机）。自定义铃声和图标在手表上会退化，属正常现象。

## 配置（dsh 设置面板 → pidesk-sync）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 启用推送 |
| `url` | 空 | 填写设备的 `http://<pi-address>:8765/api/agents-push` 后再启用 |
| `token` | 空 | 推送令牌（secret，只写不回显）；需与 pidesk 配置 `agent_push_token` 一致 |
| `intervalSeconds` | `15` | 推送间隔（5-3600 秒） |
| `dshHome` | `~/.dsh` | DSH 数据目录 |
| `codexHome` | `~/.codex` | Codex 数据目录 |
| `notifyEnabled` | `false` | 任务结束时推到手机/手表 |
| `notifyChannel` | `bark` | `bark` 或 `webhook` |
| `notifyServer` | `https://api.day.app` | Bark 服务地址（公共实例或自托管） |
| `notifyKey` | 空 | Bark device key（secret，只写不回显） |
| `notifyWebhook` | 空 | `notifyChannel=webhook` 时的地址 |
| `notifyEvents` | `needs_input,done` | 触发事件，`done` / `needs_input` 逗号分隔 |
| `notifyLevel` | `timeSensitive` | `active` / `timeSensitive` / `passive` / `critical` |
| `notifyGroup` | `pidesk` | Bark 消息分组（手表上折叠成一堆） |

`timeSensitive` 能穿透专注模式；`critical` 连静音也能响，但需在 Bark App 内授权
「重要警告」，未授权会自动降级成普通通知。

先验证通道再启用：

```sh
node tools/bark-test.mjs --key <你的BarkKey>
# 自托管：--server https://bark.example.com
# 兜底通道：--webhook https://hook.example.com/x
```

推送行为：

- 只在 `running → done/needs_input` 的边沿触发；`done ↔ needs_input` 的抖动不重复打扰。
- 通道刚启用时先建一轮基线，不会把历史已完成任务补推一遍。
- 单轮最多 3 条；连续失败 3 次暂停该通道，成功后自动恢复。失败只记日志，不影响屏幕推送。

## 安装（DSH Web profile）

**打包安装，不要软链源码。** `link:` 会让 profile 直接读工作树，源码一改就
影响运行中的插件；打包后 `.dsh` 里是独立快照，工作树怎么改都不影响它。

```sh
cd plugin/pidesk-sync
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
# 打包（需要可写 npm 缓存，环境默认缓存只读时用 npm_config_cache 指到临时目录）
npm_config_cache=$(mktemp -d) npm pack --pack-destination ../../dist

# 装进 profile，替换旧条目；不要在 profile 的 package.json 里手写 link:
mkdir -p "$DSH_HOME/profiles/web/.plugin-manager/packages"
cp ../../dist/dsh-pidesk-sync-0.1.0.tgz "$DSH_HOME/profiles/web/.plugin-manager/packages/"
dsh plugin --profile web add "$DSH_HOME/profiles/web/.plugin-manager/packages/dsh-pidesk-sync-0.1.0.tgz" \
  --offline --ignore-scripts
# 重启 DSH Web 进程后生效
```

发新版本前 bump `package.json` 的 `version`，否则 `.plugin-manager` 里同名
tgz 难以区分。

开发时若需解析 peer 依赖（schemastery）跑测试，链接 profile 的
`node_modules` 到插件目录是**测试用**的临时手段；不要把该链接提交，也不要把
插件本身以 `link:` 方式装进 profile。

## 测试

```sh
cd plugin/pidesk-sync && node --test tests/run.mjs
# 用例覆盖：状态判定、线程归并、空会话/teammate 过滤、多帧 zstd、
# 手机推送边沿判定与端到端、生命周期、故障隔离
```

## 行为边界

- 单轮聚合或推送失败只记 warning，下一轮重试；连续失败不影响宿主。
- `dispose` 清理定时器、中止进行中的请求并清空缓存；清理可重复调用。
- 配置无效时暂停推送（记日志），不卸载插件。
- 手机推送是尽力而为的旁路：网络不通、key 失效只记日志，屏幕推送不受影响。
- 无浏览器半边（纯 host 定时任务），不占用 GUI 资源。
