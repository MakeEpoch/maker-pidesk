'use strict';
const $ = (id) => document.getElementById(id);
let state = null;
document.body.classList.toggle(
  'device',
  new URLSearchParams(location.search).get('display') === '1'
);
function text(id, value) {
  if ($(id).textContent !== String(value)) $(id).textContent = value;
}
function weather(code) {
  if (code === 0) return ['sun', '晴'];
  if (code === 1 || code === 2) return ['partly', code === 1 ? '晴间多云' : '多云'];
  if (code === 3) return ['cloud', '阴'];
  if (code === 45 || code === 48) return ['cloud', '有雾'];
  if ([71, 73, 75, 77, 85, 86].includes(code)) return ['snow', '降雪'];
  if ([95, 96, 99].includes(code)) return ['rain', '雷阵雨'];
  return ['rain', '降雨'];
}
function icon(kind) {
  let body = '';
  if (['sun', 'partly'].includes(kind))
    body +=
      '<g class="sun" fill="none" stroke="#f4c56a" stroke-width="3"><circle cx="26" cy="25" r="9" fill="#f4c56a"/>' +
      Array.from(
        { length: 8 },
        (_, i) => `<path d="M26 9V4" transform="rotate(${i * 45} 26 25)"/>`
      ).join('') +
      '</g>';
  if (kind !== 'sun')
    body +=
      '<path class="cloud" fill="#abc6d7" d="M18 47a10 10 0 0 1-1-20 14 14 0 0 1 27-2 11 11 0 0 1 2 22Z"/>';
  if (kind === 'rain')
    body +=
      '<g class="drops" stroke="#6ce0bf" stroke-width="3"><path d="m22 51-3 6m17-6-3 6m17-6-3 6"/></g>';
  if (kind === 'snow')
    body +=
      '<g class="drops" fill="#edf3f5"><circle cx="22" cy="54" r="2"/><circle cx="35" cy="57" r="2"/><circle cx="48" cy="54" r="2"/></g>';
  return `<svg viewBox="0 0 64 64" aria-hidden="true">${body}</svg>`;
}

let draft = {},
  saveTimer = null,
  saving = false;
function shownState() {
  return { ...state, ...draft };
}
function resizePreview() {
  if (document.body.classList.contains('device')) return;
  const desk = $('desk'),
    stage = document.querySelector('.preview-stage'),
    wrap = document.querySelector('.screen-wrap');
  const portrait = desk.classList.contains('portrait'),
    width = portrait ? 320 : 480,
    height = portrait ? 480 : 320;
  const scale = Math.min(1, Math.max(0.2, (stage.clientWidth - 24) / width));
  wrap.style.width = width * scale + 'px';
  wrap.style.height = height * scale + 'px';
  desk.style.transform = `scale(${scale})`;
  text('preview-size', `${width} × ${height}`);
}
function agentAgo(updated) {
  const seconds = Math.max(0, (Date.now() / 1000 - updated) | 0);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return Math.floor(seconds / 60) + '分前';
  if (seconds < 86400) return Math.floor(seconds / 3600) + '时前';
  return Math.floor(seconds / 86400) + '天前';
}
function agentTail(title) {
  // 路径类标题只保留尾部关键部分：/a/b/c/d → c/d
  const parts = String(title || '').split('/').filter(Boolean);
  if (parts.length > 2) return parts.slice(-2).join('/');
  return String(title || '');
}
const AGENT_RANK = { running: 1, needs_input: 2, done: 3 };
function agentWaiting(task) {
  // 「进行中且有提问」：进行中且最新回复以问句结尾
  return task.status === 'running' && task.detail && /[？?]\s*$/.test(task.detail.trim());
}
function renderAgentWidget(root, payload) {
  const key = JSON.stringify(payload.agents || []);
  if (root.dataset.key === key) return;
  root.replaceChildren();
  root.dataset.key = key;
  const box = document.createElement('div');
  box.className = 'right-agents';
  // 优先级：进行中+待回答 > 进行中 > 待回答 > 已完成
  const tasks = [...(payload.agents || [])];
  const priority = (task) =>
    agentWaiting(task) ? 0 : AGENT_RANK[task.status] ?? AGENT_RANK.done;
  tasks.sort((a, b) => priority(a) - priority(b) || b.updated - a.updated);
  if (!tasks.length) {
    const e = document.createElement('p');
    e.className = 'widget-empty';
    e.textContent = '暂无任务';
    box.append(e);
  }
  for (const task of tasks) {
    box.append(agentTaskRow(task));
  }
  root.append(box);
}
function agentTaskRow(task) {
  const row = document.createElement('div');
  row.className = 'agent-task ' + task.status;
  // 第一行：状态圆点 + 来源·时间 + 标题（路径截尾）
  const head = document.createElement('div');
  head.className = 'agent-task-head';
  const dot = document.createElement('i');
  dot.className = 'agent-dot';
  const meta = document.createElement('span');
  meta.className = 'agent-meta';
  meta.textContent = `${task.source} ${agentAgo(task.updated)}`;
  const name = document.createElement('b');
  name.className = 'agent-title';
  name.textContent = agentTail(task.title);
  head.append(dot, meta, name);
  // 第二行：内容摘要，仅一行
  if (task.detail) {
    const detail = document.createElement('small');
    detail.className = 'agent-detail';
    detail.textContent = task.detail;
    row.append(head, detail);
  } else {
    row.append(head);
  }
  return row;
}
function renderWidget(payload) {
  const root = $('right-widget'),
    mode = ['calendar', 'forecast', 'agents', 'photo'].includes(payload.right_widget)
      ? payload.right_widget
      : 'none';
  const key = JSON.stringify([mode, payload.date, payload.weather?.forecast, payload.photo_url]);
  if (root.dataset.key === key) return;
  root.replaceChildren();
  root.dataset.key = key;
  if (mode === 'none') return;
  if (mode === 'photo') {
    if (payload.photo_url) {
      const img = document.createElement('img');
      img.src = payload.photo_url;
      img.alt = '照片';
      img.className = 'right-photo';
      root.append(img);
    } else {
      const e = document.createElement('p');
      e.className = 'widget-empty';
      e.textContent = '未上传照片';
      root.append(e);
    }
    return;
  }
  if (mode === 'calendar') {
    const box = document.createElement('div');
    box.className = 'right-calendar';
    const title = document.createElement('h2');
    title.textContent = payload.date.slice(0, 4) + '年' + Number(payload.date.slice(5, 7)) + '月';
    const grid = document.createElement('div');
    grid.className = 'calendar-grid';
    [...'一二三四五六日'].forEach((name, i) => {
      const e = document.createElement('span');
      e.className = 'weekday' + (i > 4 ? ' weekend' : '');
      e.textContent = name;
      grid.append(e);
    });
    payload.days.forEach((day) => {
      const e = document.createElement('span');
      e.className = 'day' + (day.weekend ? ' weekend' : '') + (day.today ? ' today' : '');
      e.textContent = day.number ? String(day.number).padStart(2, '0') : '';
      grid.append(e);
    });
    box.append(title, grid);
    root.append(box);
    return;
  }
  if (mode === 'agents') {
    renderAgentWidget(root, payload);
    return;
  }
  const box = document.createElement('div');
  box.className = 'right-forecast';
  const title = document.createElement('h2');  title.textContent = '未来三天';
  box.append(title);
  const future = (payload.weather?.forecast || [])
    .filter((day) => day.date > payload.date)
    .slice(0, 3);
  future.forEach((day) => {
    const row = document.createElement('div');
    row.className = 'forecast-item';
    const [kind, description] = weather(day.code);
    const ahead = Math.round(
      (Date.parse(day.date + 'T00:00:00Z') - Date.parse(payload.date + 'T00:00:00Z')) / 86400000
    );
    const name = document.createElement('b');
    name.textContent =
      ahead === 1
        ? '明天'
        : ahead === 2
          ? '后天'
          : '周' + '日一二三四五六'[new Date(day.date + 'T00:00:00Z').getUTCDay()];
    const symbol = document.createElement('span');
    symbol.innerHTML = icon(kind);
    const desc = document.createElement('span');
    desc.className = 'description';
    desc.textContent = description;
    const range = document.createElement('span');
    range.className = 'temperatures';
    range.textContent = `${Math.round(day.low)}/${Math.round(day.high)}°`;
    row.append(name, symbol, desc, range);
    box.append(row);
  });
  if (!future.length) {
    const e = document.createElement('p');
    e.className = 'widget-empty';
    e.textContent = '预报暂不可用';
    box.append(e);
  }
  root.append(box);
}
function renderPet(payload) {
  const pet = $('pet');
  const tasks = payload.agents || [];
  const runningTask = tasks.find((task) => task.status === 'running');
  const attention = tasks.some(
    (task) => task.status !== 'running' && task.detail && /[？?]\s*$/.test(task.detail.trim())
  );
  const mood = runningTask ? 'working' : attention ? 'alert' : 'idle';
  // 气泡只在进行中显示对话标题；空闲/待回答不显示标题
  const bubbleText = runningTask ? agentTail(runningTask.title) : '';
  const renderKey = mood + '|' + bubbleText;
  if (pet.dataset.renderKey !== renderKey) {
    pet.dataset.renderKey = renderKey;
    pet.dataset.mood = mood;
    pet.replaceChildren();
    const body = document.createElement('span');
    body.className = 'pet-body';
    const face = document.createElement('span');
    face.className = 'pet-face';
    face.textContent = runningTask ? '◔ ◔' : attention ? '◉ ◉' : '· ·';
    body.append(face);
    if (bubbleText) {
      const bubble = document.createElement('i');
      bubble.className = 'pet-bubble';
      bubble.textContent = bubbleText;
      bubble.title = bubbleText;
      pet.append(body, bubble);
    } else {
      pet.append(body);
    }
  }
}
function renderScreen(payload) {
  const desk = $('desk'),
    angle = payload.rotation || 0;
  desk.dataset.motion = 'off';
  desk.classList.toggle('portrait', angle === 90 || angle === 270);
  const statusKey = JSON.stringify([payload.stats.cpu, payload.stats.memory, payload.ip]);
  if ($('system').dataset.key !== statusKey) {
    const chip =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1"/><path d="M8 1v4m8-4v4M8 19v4m8-4v4M1 8h4m-4 8h4m14-8h4m-4 8h4"/></svg>';
    const ram =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 5h20v12H2Zm4 3v6m6-6v6m6-6v6M5 17v4m7-4v4m7-4v4"/></svg>';
    const wifi =
      '<svg class="wifi" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 8a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0m-11 4a5 5 0 0 1 8 0"/><circle cx="12" cy="20" r="1"/></svg>';
    const cpu = document.createElement('span');
    cpu.innerHTML = chip;
    cpu.append(`CPU ${payload.stats.cpu ?? '--'}%`);
    const memory = document.createElement('span');
    memory.innerHTML = ram;
    memory.append(`内存${payload.stats.memory ?? '--'}%`);
    const address = document.createElement('span');
    address.innerHTML = wifi;
    address.append(payload.ip);
    $('system').replaceChildren(cpu, memory, address);
    $('system').dataset.key = statusKey;
  }
  text('clock', payload.time);
  text('date', payload.date_label.replace(/\s+/, ' '));
  // 灰条宽度 = 今年已过占比；右侧数字 = 剩余占比
  $('year-fill').style.width = payload.year_percent + '%';
  text('year-percent', payload.year_remaining + '%');
  text('city', payload.location.city);
  const w = payload.weather;
  if (w) {
    const [kind, label] = weather(w.code);
    text('temperature-value', Math.round(w.temperature));
    text('humidity', Math.round(w.humidity) + '%');
    text('rain', Math.round(w.rain) + '%');
    text('condition', label);
    text('range', `${Math.round(w.low)}°/${Math.round(w.high)}°`);
    if ($('weather-icon').dataset.kind !== kind) {
      $('weather-icon').innerHTML = icon(kind);
      if (kind === 'sun')
        $('weather-icon').querySelector('svg').setAttribute('viewBox', '0 0 52 50');
      $('weather-icon').dataset.kind = kind;
    }
    text('stale', payload.stale ? '缓存' : '');
  } else {
    text('condition', payload.location.source === 'unconfigured' ? '请配置地点' : (payload.error ? '天气暂不可用' : '正在获取天气'));
    text('stale', '');
  }
  renderWidget(payload);
  renderPet(payload);
  resizePreview();
}
const GAIN_FIELDS = [
  ['gain-r', 'color_gain_r'],
  ['gain-g', 'color_gain_g'],
  ['gain-b', 'color_gain_b'],
];

function syncControls(payload) {
  document.querySelectorAll('[data-angle]').forEach((button) => {
    const selected = Number(button.dataset.angle) === (payload.rotation || 0);
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('[data-widget]').forEach((button) => {
    const selected = button.dataset.widget === (payload.right_widget || 'none');
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  // 提示音：后端存 0-1 小数，滑块显示 5-100 整数百分比
  const volume = Math.round(
    Math.min(1, Math.max(0.05, Number(payload.notify_volume) || 0.18)) * 100
  );
  const slider = $('notify-volume');
  if (Number(slider.value) !== volume) slider.value = String(volume);
  text('notify-volume-value', volume + '%');
  const styleDefaults = { notify_style_done: 'chime', notify_style_attention: 'bell' };
  document.querySelectorAll('[data-style-field]').forEach((button) => {
    const field = button.dataset.styleField;
    const selected = button.dataset.style === (payload[field] || styleDefaults[field]);
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  // 屏幕色彩增益滑块同步
  const gainDefaults = { color_gain_r: 1, color_gain_g: 0.98, color_gain_b: 0.97 };
  for (const [id, field] of GAIN_FIELDS) {
    const value = Number(payload[field]) || gainDefaults[field];
    const slider = $(id);
    if (Number(slider.value) !== value) slider.value = String(value);
    text(id + '-value', value.toFixed(2));
  }
}
function apply(payload) {
  state = payload;
  const shown = document.body.classList.contains('device') ? payload : shownState();
  renderScreen(shown);
  syncControls(shown);
  text('connection', '已连接');
  window.pideskReady = true;
}
async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw Error('state unavailable');
    apply(await response.json());
  } catch (error) {
    console.warn(error);
    text('connection', '连接中断');
    if (state) text('stale', '离线');
  }
}
function change(key, value) {
  if (!state) return;
  draft[key] = value;
  apply(state);
  text('control-status', '更改待保存…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 450);
}
async function persist() {
  clearTimeout(saveTimer);
  if (saving || !Object.keys(draft).length) return;
  const patch = { ...draft };
  saving = true;
  $('save-settings').disabled = true;
  text('control-status', '正在保存…');
  let success = false;
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw Error('保存失败，请点立即保存重试');
    const payload = await response.json();
    Object.entries(patch).forEach(([key, value]) => {
      if (draft[key] === value) delete draft[key];
    });
    apply(payload);
    success = true;
    text('control-status', Object.keys(draft).length ? '还有更改待保存…' : '已保存，已同步到小屏');
  } catch (error) {
    text('control-status', error.message || '保存失败，请重试');
  } finally {
    saving = false;
    $('save-settings').disabled = false;
    if (success && Object.keys(draft).length) saveTimer = setTimeout(persist, 100);
  }
}
$('save-settings').addEventListener('click', persist);
$('sound-test').addEventListener('click', async () => {
  const button = $('sound-test');
  button.disabled = true;
  button.textContent = '正在播放…';
  text('sound-status', '请听树莓派喇叭');
  try {
    const response = await fetch('/api/sound-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok)
      throw Error(
        response.status === 409 ? '正在播放，请稍后再试' : '播放失败，请检查喇叭连接后重试'
      );
    const result = await response.json();
    if (!result.ok) throw Error('播放失败，请重试');
    text('sound-status', '提示音已播放');
  } catch (error) {
    text('sound-status', error.message || '连接失败，请重试');
  } finally {
    button.disabled = false;
    button.textContent = '测试声音';
  }
});
for (const button of document.querySelectorAll('[data-angle]'))
  button.addEventListener('click', () => change('rotation', Number(button.dataset.angle)));
for (const button of document.querySelectorAll('[data-widget]'))
  button.addEventListener('click', () => change('right_widget', button.dataset.widget));
// 提示音音量：滑块百分比 → 后端 0-1 小数
$('notify-volume').addEventListener('input', (event) => {
  const percent = Number(event.target.value);
  text('notify-volume-value', percent + '%');
  change('notify_volume', percent / 100);
});
// 屏幕色彩：三个通道增益滑块（0.5-1.5，步进 0.01）
for (const [id, field] of GAIN_FIELDS) {
  $(id).addEventListener('input', (event) => {
    const value = Number(event.target.value);
    text(id + '-value', value.toFixed(2));
    change(field, value);
    text('gain-status', '已调整，立即生效');
  });
}
$('gain-reset').addEventListener('click', () => {
  $('gain-r').value = '1';
  $('gain-g').value = '1.00';
  $('gain-b').value = '1.00';
  text('gain-r-value', '1.00');
  text('gain-g-value', '1.00');
  text('gain-b-value', '1.00');
  change('color_gain_r', 1);
  change('color_gain_g', 1);
  change('color_gain_b', 1);
  text('gain-status', '已恢复默认');
});
// 照片上传
$('photo-upload').addEventListener('click', () => $('photo-file').click());
$('photo-file').addEventListener('change', async () => {
  const input = $('photo-file');
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    text('photo-status', '超过 4MB，请压缩后重试');
    input.value = '';
    return;
  }
  const button = $('photo-upload');
  button.disabled = true;
  button.textContent = '上传中…';
  text('photo-status', file.name);
  try {
    const form = new FormData();
    form.append('photo', file, file.name);
    const response = await fetch('/api/photo', { method: 'POST', body: form });
    if (!response.ok) throw Error('上传失败（格式或大小不符）');
    const result = await response.json();
    text('photo-status', '已上传');
    // 立即刷新页面里的照片（不必等轮询）
    if (state) {
      state.photo_url = result.url;
      if (state.right_widget !== 'photo') change('right_widget', 'photo');
      else {
        const widget = $('right-widget');
        delete widget.dataset.key;
        renderWidget(document.body.classList.contains('device') ? state : shownState());
      }
    }
  } catch (error) {
    text('photo-status', error.message || '上传失败，请重试');
  } finally {
    button.disabled = false;
    button.textContent = '选择照片';
    input.value = '';
  }
});
// 任务完成 / 待回答音效
for (const button of document.querySelectorAll('[data-style-field]'))
  button.addEventListener('click', () =>
    change(button.dataset.styleField, button.dataset.style)
  );
async function previewNotify(kind) {
  const button = $('notify-test-' + kind);
  const status = 'notify-status-' + kind;
  button.disabled = true;
  button.textContent = '播放中…';
  text(status, '请听树莓派喇叭');
  try {
    const response = await fetch('/api/notify-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    if (!response.ok)
      throw Error(
        response.status === 409 ? '正在播放，请稍后再试' : '播放失败，请检查喇叭连接后重试'
      );
    const result = await response.json();
    if (!result.ok)
      throw Error(result.busy ? '正在播放，请稍后再试' : '播放失败，请重试');
    text(status, result.silent ? '当前为静音音效' : '提示音已播放');
  } catch (error) {
    text(status, error.message || '连接失败，请重试');
  } finally {
    button.disabled = false;
    button.textContent = '试听';
  }
}
$('notify-test-done').addEventListener('click', () => previewNotify('done'));
$('notify-test-attention').addEventListener('click', () => previewNotify('attention'));
window.applyPideskState = apply;
window.addEventListener('resize', resizePreview);
refresh();
setInterval(refresh, 10000);
