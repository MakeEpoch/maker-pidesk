/**
 * 手动验证手机/手表推送是否接通（不经过插件，不读会话）。
 *
 * 用法（Bark 公共实例，默认）：
 *   node tools/bark-test.mjs --key <BarkKey>
 *   node tools/bark-test.mjs --key <BarkKey> --level timeSensitive
 *
 * 自托管 bark-server：
 *   node tools/bark-test.mjs --server https://bark.example.com --key <BarkKey>
 *
 * 兜底 Webhook 通道：
 *   node tools/bark-test.mjs --webhook https://hook.example.com/x
 *
 * 参数也可从环境变量读：PIDESK_BARK_KEY / PIDESK_BARK_SERVER / PIDESK_WEBHOOK。
 * key 只从命令行或环境读取，不写入任何配置文件。
 */

import { parseArgs } from 'node:util'
import { barkPayload, barkUrl, sendNotice, webhookPayload } from '../host/notify.js'

const { values } = parseArgs({
  options: {
    key: { type: 'string' },
    server: { type: 'string' },
    webhook: { type: 'string' },
    level: { type: 'string' },
    help: { type: 'boolean' },
  },
})

const key = values.key ?? process.env.PIDESK_BARK_KEY ?? ''
const server = values.server ?? process.env.PIDESK_BARK_SERVER ?? 'https://api.day.app'
const webhook = values.webhook ?? process.env.PIDESK_WEBHOOK ?? ''
const level = values.level ?? 'timeSensitive'

if (values.help || (!key && !webhook)) {
  console.log(`用法: node tools/bark-test.mjs --key <BarkKey> [--server <URL>] [--level active|timeSensitive|critical]
     node tools/bark-test.mjs --webhook <URL>

装好 Bark App 后从首页复制 key。发送一条测试通知，手机锁屏时配对的 Apple Watch
会同步收到——如果手表没动静，先看 iPhone 是否亮屏在用（此时系统只给手机）。`)
  process.exit(values.help ? 0 : 1)
}

const task = {
  id: 'test',
  source: 'pidesk',
  title: '推送通道已接通',
  detail: '这条通知由 pidesk-sync 发出；手表能看到说明 APNs 链路正常。',
}

const payload = barkPayload(task, 'needs_input', { level })
const url = webhook ? webhook : barkUrl(server, key)
const body = webhook ? webhookPayload(task, 'needs_input', payload) : payload

console.log(`POST ${url}`)
console.log(JSON.stringify(body, null, 2))
const result = await sendNotice({ url, payload: body })
if (result.ok) {
  console.log('✅ 已发送（HTTP 200）。手机锁屏时看手表；没收到检查 App 通知权限与专注模式。')
} else {
  console.error(`❌ 发送失败：${result.error ?? `HTTP ${result.status}`}`)
  process.exit(1)
}
