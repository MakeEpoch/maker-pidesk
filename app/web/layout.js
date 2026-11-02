/* Shared layout model: used by the editor, device renderer and offline tests. */
(function (root) {
  'use strict';
  const names = {
    date: '日期',
    weekday: '星期',
    clock: '时钟',
    'year-label': '进度标签',
    'year-bar': '年度进度条',
    'year-percent': '年度百分比',
    city: '城市',
    condition: '天气状况',
    temperature: '温度',
    'weather-icon': '天气图标',
    range: '高低温',
    humidity: '湿度',
    rain: '降水概率',
    cpu: 'CPU',
    memory: '内存',
    ip: 'IP 地址',
    calendar: '月历',
    forecast: '三天天气',
    agents: '任务列表',
    photo: '照片',
    pet: '宠物',
    bubble: '宠物气泡',
    'header-line': '顶部横线',
    'column-line': '分栏竖线',
  };
  const groups = {
    time: '时间与进度',
    weather: '天气',
    system: '设备指标',
    modules: '展示模块',
    pet: '宠物',
    decoration: '分隔线',
    none: '未分组',
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const mode = (angle) => (angle === 90 || angle === 270 ? 'portrait' : 'landscape');
  const size = (orientation) => (orientation === 'portrait' ? [320, 480] : [480, 320]);
  function defaults(orientation, widget = 'none') {
    const p = orientation === 'portrait';
    const elements = {};
    function put(id, x, y, width, height, font, group, color = '#f0f7fa', visible = true) {
      elements[id] = {
        x,
        y,
        width,
        height,
        font,
        group,
        color,
        visible,
        locked: false,
        z: 1,
        align: 'left',
        overflow: 'ellipsis',
      };
    }
    put('date', 18, 15, 110, 23, 14, 'time');
    put('weekday', 132, 15, 65, 23, 14, 'time');
    put('clock', p ? 74 : 18, p ? 77 : 45, 174, 67, 56, 'time');
    put('year-label', p ? 74 : 18, p ? 151 : 113, 27, 18, 11, 'time', '#b3c8df');
    put('year-bar', p ? 105 : 49, p ? 158 : 120, 112, 4, 11, 'time', '#06bde9');
    put('year-percent', p ? 224 : 168, p ? 151 : 113, 29, 18, 11, 'time', '#b3c8df');
    put('city', p ? 74 : 18, p ? 182 : 138, 78, 24, 17, 'weather');
    put('condition', p ? 156 : 100, p ? 184 : 140, 90, 22, 13, 'weather', '#b3c8df');
    put('temperature', p ? 74 : 18, p ? 216 : 169, 100, 78, 60, 'weather');
    put('weather-icon', p ? 175 : 119, p ? 218 : 171, 72, 72, 14, 'weather', '#f4c56a');
    put('range', p ? 74 : 18, p ? 294 : 247, 70, 20, 11, 'weather');
    put('humidity', p ? 146 : 90, p ? 294 : 247, 56, 20, 11, 'weather');
    put('rain', p ? 204 : 148, p ? 294 : 247, 50, 20, 11, 'weather');
    put('cpu', p ? 18 : 271, p ? 42 : 18, 54, 15, 9, 'system', '#b3c8df');
    put('memory', p ? 78 : 329, p ? 42 : 18, 53, 15, 9, 'system', '#b3c8df');
    put('ip', p ? 139 : 387, p ? 42 : 18, 83, 15, 9, 'system', '#b3c8df');
    for (const id of ['calendar', 'forecast', 'agents', 'photo']) {
      put(
        id,
        p ? 18 : 208,
        p ? 326 : 50,
        p ? 284 : 256,
        p ? 128 : 246,
        14,
        'none',
        '#f0f7fa',
        widget === id
      );
    }
    put('pet', 18, p ? 450 : 288, 30, 26, 10, 'pet');
    put('bubble', 55, p ? 453 : 291, 135, 21, 10, 'pet', '#b3c8df');
    put('header-line', 6, p ? 65 : 44, p ? 308 : 468, 1, 8, 'decoration', '#174357');
    put('column-line', 199, 50, 1, 246, 8, 'decoration', '#123542', !p);
    elements.temperature.unit = 'c';
    elements.range.unit = 'c';
    return elements;
  }
  function normalize(layout) {
    // Local drafts/imports pass through the same narrow field allow-list as server settings.
    const result = { version: 1, landscape: {}, portrait: {} };
    if (!layout || layout.version !== 1) return result;
    for (const orientation of ['landscape', 'portrait']) {
      const [w, h] = size(orientation);
      for (const id of Object.keys(names)) {
        const item = layout[orientation]?.[id];
        if (!item || typeof item !== 'object') continue;
        const out = {};
        for (const key of ['x', 'y', 'width', 'height', 'font', 'z']) {
          const v = item[key],
            max = { x: w - 1, y: h - 1, width: w, height: h, font: 96, z: 100 }[key];
          if (Number.isInteger(v))
            out[key] = Math.max(
              key === 'font' ? 8 : ['width', 'height'].includes(key) ? 1 : 0,
              Math.min(max, v)
            );
        }
        for (const key of ['visible', 'locked'])
          if (typeof item[key] === 'boolean') out[key] = item[key];
        if (/^#[0-9a-f]{6}$/i.test(item.color || '')) out.color = item.color;
        if (/^[a-z][a-z0-9-]{0,31}$/.test(item.group || '')) out.group = item.group;
        if (['temperature', 'range'].includes(id) && ['c', 'f'].includes(item.unit))
          out.unit = item.unit;
        if (['left', 'center', 'right'].includes(item.align)) out.align = item.align;
        if (['ellipsis', 'wrap'].includes(item.overflow)) out.overflow = item.overflow;
        result[orientation][id] = out;
      }
    }
    return result;
  }
  function scene(layout, orientation, widget) {
    const result = defaults(orientation, widget),
      [w, h] = size(orientation);
    const overrides = normalize(layout)[orientation];
    for (const id of Object.keys(result)) {
      Object.assign(result[id], overrides[id] || {});
      const e = result[id];
      e.width = Math.min(w, e.width);
      e.height = Math.min(h, e.height);
      e.x = Math.min(w - e.width, e.x);
      e.y = Math.min(h - e.height, e.y);
    }
    return result;
  }
  function bounds(elements, ids) {
    const list = ids.map((id) => elements[id]).filter(Boolean);
    if (!list.length) return null;
    const x = Math.min(...list.map((e) => e.x)),
      y = Math.min(...list.map((e) => e.y));
    return {
      x,
      y,
      width: Math.max(...list.map((e) => e.x + e.width)) - x,
      height: Math.max(...list.map((e) => e.y + e.height)) - y,
    };
  }
  function translate(elements, ids, dx, dy, dimensions) {
    const movable = ids.filter((id) => !elements[id].locked),
      box = bounds(elements, movable);
    if (!box) return;
    dx = Math.max(-box.x, Math.min(dimensions[0] - box.x - box.width, Math.round(dx)));
    dy = Math.max(-box.y, Math.min(dimensions[1] - box.y - box.height, Math.round(dy)));
    for (const id of movable) {
      elements[id].x += dx;
      elements[id].y += dy;
    }
  }
  function snap(elements, ids, dx, dy, dimensions, threshold = 4) {
    const box = bounds(elements, ids),
      guides = [];
    if (!box) return { dx, dy, guides };
    for (const [axis, length, delta] of [
      ['x', 'width', dx],
      ['y', 'height', dy],
    ]) {
      const dimension = dimensions[axis === 'x' ? 0 : 1];
      const targets = [0, dimension / 2, dimension];
      for (const [id, e] of Object.entries(elements))
        if (e.visible && !ids.includes(id))
          targets.push(e[axis], e[axis] + e[length] / 2, e[axis] + e[length]);
      let best = threshold + 1,
        correction = 0,
        target = null;
      for (const point of [
        box[axis] + delta,
        box[axis] + delta + box[length] / 2,
        box[axis] + delta + box[length],
      ])
        for (const t of targets) {
          if (Math.abs(t - point) < best) {
            best = Math.abs(t - point);
            correction = t - point;
            target = t;
          }
        }
      if (best <= threshold) {
        if (axis === 'x') dx += correction;
        else dy += correction;
        guides.push({ axis, at: target });
      }
    }
    return { dx, dy, guides };
  }
  class History {
    constructor(initial) {
      this.entries = [clone(initial)];
      this.index = 0;
    }
    push(value) {
      if (JSON.stringify(value) === JSON.stringify(this.entries[this.index])) return;
      this.entries = this.entries.slice(0, this.index + 1);
      this.entries.push(clone(value));
      if (this.entries.length > 80) this.entries.shift();
      this.index = this.entries.length - 1;
    }
    undo() {
      this.index = Math.max(0, this.index - 1);
      return clone(this.entries[this.index]);
    }
    redo() {
      this.index = Math.min(this.entries.length - 1, this.index + 1);
      return clone(this.entries[this.index]);
    }
  }
  const api = {
    names,
    groups,
    clone,
    mode,
    size,
    defaults,
    normalize,
    scene,
    bounds,
    translate,
    snap,
    History,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PideskLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
