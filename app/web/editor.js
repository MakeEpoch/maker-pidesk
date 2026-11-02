'use strict';

// This controller exists only in the control page. Device rendering uses layout.js + app.js.
if (!document.body.classList.contains('device')) {
  class LayoutEditor {
    constructor() {
      this.L = window.PideskLayout;
      this.doc = null;
      this.base = null;
      this.selected = [];
      this.editGroup = null;
      this.grid = false;
      this.snapping = true;
      this.storageFailed = false;
      this.applying = false;
      this.drag = null;
      this.storageKey = 'pidesk.layout-draft.v1';
      this.contextMenu = $('editor-context-menu');
      this.outline = document.createElement('div');
      this.outline.className = 'selection-overlay';
      this.outline.setAttribute('aria-hidden', 'true');
      $('desk').append(this.outline);
      this.guides = document.createElement('div');
      this.guides.className = 'snap-guides';
      this.guides.setAttribute('aria-hidden', 'true');
      $('desk').append(this.guides);
      this.bind();
    }
    materialize(payload) {
      return {
        rotation: payload.rotation || 0,
        layout: {
          version: 1,
          landscape: this.L.scene(payload.screen_layout, 'landscape', payload.right_widget),
          portrait: this.L.scene(payload.screen_layout, 'portrait', payload.right_widget),
        },
      };
    }
    receive(payload) {
      const fresh = this.materialize(payload);
      if (!this.doc) {
        this.base = this.L.clone(fresh);
        this.doc = this.L.clone(fresh);
        try {
          const stored = JSON.parse(localStorage.getItem(this.storageKey) || 'null');
          if (
            stored?.doc?.layout?.version === 1 &&
            [0, 90, 180, 270].includes(stored.doc.rotation)
          ) {
            this.doc = this.materialize({
              rotation: stored.doc.rotation,
              screen_layout: stored.doc.layout,
            });
            if (stored.base !== JSON.stringify(fresh))
              this.message('设备布局已变化，已恢复的草稿仍保留；应用将替换设备布局。', true);
          }
        } catch (_) {
          this.storageFailed = true;
        }
        this.history = new this.L.History(this.doc);
        this.render();
        return;
      }
      if (JSON.stringify(fresh) === JSON.stringify(this.base)) return;
      if (this.dirty()) {
        this.base = this.L.clone(fresh);
        this.message('设备布局已变化，草稿仍保留；应用将替换设备布局。', true);
      } else {
        this.base = this.L.clone(fresh);
        this.doc = this.L.clone(fresh);
        this.history = new this.L.History(this.doc);
      }
      this.render();
    }
    preview() {
      return this.doc ? { screen_layout: this.doc.layout, rotation: this.doc.rotation } : {};
    }
    orientation() {
      return this.L.mode(this.doc?.rotation);
    }
    elements() {
      return this.doc.layout[this.orientation()];
    }
    dirty() {
      return this.doc && JSON.stringify(this.doc) !== JSON.stringify(this.base);
    }
    hasUnstoredDraft() {
      return this.storageFailed && this.dirty();
    }
    message(value, warning = false) {
      $('editor-conflict').hidden = !value;
      $('editor-conflict').textContent = value;
      $('editor-conflict').classList.toggle('warning', warning);
    }
    store() {
      try {
        if (this.dirty())
          localStorage.setItem(
            this.storageKey,
            JSON.stringify({ doc: this.doc, base: JSON.stringify(this.base) })
          );
        else localStorage.removeItem(this.storageKey);
        this.storageFailed = false;
      } catch (_) {
        this.storageFailed = true;
      }
    }
    commit(operation) {
      if (!this.doc || this.applying) return;
      operation(this.elements());
      if (!this.editingProperty) this.history.push(this.doc);
      this.store();
      this.render();
      renderScreen(shownState());
    }
    select(ids, individual = false) {
      if (!this.doc || this.applying) return;
      this.selected = [...new Set(ids)].filter((id) => this.elements()[id]);
      if (individual)
        this.editGroup = this.selected.length === 1 ? this.elements()[ids[0]].group : null;
      this.render();
    }
    choose(id, shift = false, individual = false) {
      const elements = this.elements(),
        item = elements[id];
      if (!item) return;
      let ids = [id];
      if (!individual && item.group !== 'none' && this.editGroup !== item.group) {
        ids = Object.keys(elements).filter(
          (key) => elements[key].group === item.group && elements[key].visible
        );
      }
      if (shift) {
        const current = new Set(this.selected);
        if (ids.every((key) => current.has(key))) ids.forEach((key) => current.delete(key));
        else ids.forEach((key) => current.add(key));
        ids = [...current];
      }
      this.select(ids, individual);
    }
    render() {
      if (!this.doc) return;
      $('editor-angle').value = String(this.doc.rotation);
      $('editor-apply').disabled = this.applying || !this.dirty();
      $('editor-apply').textContent = this.applying ? '正在应用…' : '应用到屏幕';
      $('editor-undo').disabled = this.applying || this.history.index === 0;
      $('editor-redo').disabled =
        this.applying || this.history.index === this.history.entries.length - 1;
      $('editor-revert').disabled = this.applying || !this.dirty();
      $('editor-draft-status').textContent = this.storageFailed
        ? '浏览器无法保存草稿，请及时应用'
        : this.dirty()
          ? '草稿已保存在此浏览器，尚未应用'
          : '布局与设备一致';
      $('editor-angle').disabled = this.applying;
      $('editor-template').disabled = this.applying;
      $('editor-import').disabled = this.applying;
      this.renderLayers();
      this.renderInspector();
      this.drawSelection();
    }
    renderLayers() {
      const elements = this.elements(),
        filter = $('layer-search').value.trim();
      const root = $('layer-list');
      const scroll = root.scrollTop;
      const focusedLayer = document.activeElement?.dataset.layer;
      root.replaceChildren();
      const grouped = new Map();
      for (const [id, e] of Object.entries(elements)) {
        if (filter && !this.L.names[id].includes(filter)) continue;
        const key =
          e.group === 'none' && ['calendar', 'forecast', 'agents', 'photo'].includes(id)
            ? 'modules'
            : e.group;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(id);
      }
      for (const [group, ids] of grouped) {
        const section = document.createElement('section');
        const heading = document.createElement('button');
        heading.type = 'button';
        heading.className = 'layer-group';
        heading.textContent = `${this.L.groups[group] || '自定义组合'} · ${ids.length}`;
        heading.dataset.groupElements = ids.join(',');
        heading.addEventListener('click', () => {
          this.editGroup = null;
          this.select(ids);
        });
        section.append(heading);
        for (const id of ids.sort((a, b) => elements[b].z - elements[a].z)) {
          const e = elements[id],
            row = document.createElement('div');
          row.className =
            'layer-row' +
            (this.selected.includes(id) ? ' selected' : '') +
            (!e.visible ? ' is-hidden' : '');
          const select = document.createElement('button');
          select.type = 'button';
          select.className = 'layer-select';
          select.dataset.layer = id;
          select.setAttribute('aria-pressed', String(this.selected.includes(id)));
          select.textContent = this.L.names[id];
          select.addEventListener('click', (event) => this.choose(id, event.shiftKey, true));
          const visible = document.createElement('button');
          visible.type = 'button';
          visible.className = 'layer-toggle';
          visible.textContent = e.visible ? '◉' : '○';
          visible.setAttribute('aria-label', `${e.visible ? '隐藏' : '显示'}${this.L.names[id]}`);
          visible.setAttribute('aria-pressed', String(e.visible));
          visible.addEventListener('click', () =>
            this.commit((items) => {
              items[id].visible = !items[id].visible;
            })
          );
          const lock = document.createElement('button');
          lock.type = 'button';
          lock.className = 'layer-toggle';
          lock.textContent = e.locked ? '▣' : '·';
          lock.setAttribute('aria-label', `${e.locked ? '解锁' : '锁定'}${this.L.names[id]}`);
          lock.setAttribute('aria-pressed', String(e.locked));
          lock.addEventListener('click', () =>
            this.commit((items) => {
              items[id].locked = !items[id].locked;
            })
          );
          row.append(select, visible, lock);
          section.append(row);
        }
        root.append(section);
      }
      if (!grouped.size) {
        const p = document.createElement('p');
        p.className = 'layers-help';
        p.textContent = '没有匹配的元素';
        root.append(p);
      }
      root.scrollTop = scroll;
      if (focusedLayer)
        root.querySelector(`[data-layer="${focusedLayer}"]`)?.focus({ preventScroll: true });
      $('layer-count').textContent =
        String(Object.values(elements).filter((e) => e.visible).length) + ' / 24';
    }
    renderInspector() {
      const ids = this.selected.filter((id) => this.elements()[id]);
      $('inspector-empty').hidden = !!ids.length;
      $('element-properties').hidden = !ids.length;
      $('element-properties').disabled = this.applying;
      $('photo-settings').hidden = !ids.includes('photo');
      $('inspector-title').textContent =
        ids.length === 1
          ? this.L.names[ids[0]]
          : ids.length
            ? `已选 ${ids.length} 个元素`
            : '元素属性';
      $('unit-property').hidden =
        !ids.length || !ids.every((id) => ['temperature', 'range'].includes(id));
      this.syncMenuState();
      if (!ids.length) return;
      const elements = this.elements(),
        first = elements[ids[0]],
        box = this.L.bounds(elements, ids);
      $('selection-name').textContent =
        ids.length === 1 ? this.L.names[ids[0]] : `${ids.length} 个元素`;
      $('selection-kind').textContent =
        ids.length === 1
          ? first.group === 'none'
            ? '独立元素'
            : this.L.groups[first.group] || '自定义组'
          : '可整体移动与对齐';
      const [w, h] = this.L.size(this.orientation());
      for (const input of document.querySelectorAll('[data-prop]')) {
        const key = input.dataset.prop;
        if (key === 'x' || key === 'y')
          input.max = String(key === 'x' ? w - box.width : h - box.height);
        if (key === 'width' || key === 'height') input.max = String(key === 'width' ? w : h);
        const value =
          ids.length > 1 && ['x', 'y', 'width', 'height'].includes(key) ? box[key] : first[key];
        if (input.type === 'checkbox') {
          input.checked = ids.every((id) => elements[id][key]);
          input.indeterminate = ids.some((id) => elements[id][key]) && !input.checked;
        } else if (document.activeElement !== input) input.value = String(value);
        input.disabled = this.applying || (['width', 'height'].includes(key) && ids.length > 1);
      }
    }
    syncMenuState() {
      if (!this.doc) return;
      const elements = this.elements();
      const editable = this.selected.filter((id) => elements[id] && !elements[id].locked);
      const disabled = this.applying || !editable.length;
      $('editor-group').disabled = this.applying || editable.length < 2;
      $('editor-ungroup').disabled =
        disabled || editable.every((id) => elements[id].group === 'none');
      for (const id of [
        'editor-front',
        'editor-back',
        'context-layer-trigger',
        'context-arrange-trigger',
        'context-text-trigger',
        'editor-more',
      ])
        $(id).disabled = disabled;
      document.querySelectorAll('[data-align]').forEach((button) => {
        button.disabled =
          disabled || (button.dataset.align.startsWith('distribute') && editable.length < 3);
      });
      document.querySelectorAll('[data-text-align]').forEach((button) => {
        button.disabled = disabled;
        button.setAttribute(
          'aria-checked',
          String(
            editable.length > 0 &&
              editable.every((id) => elements[id].align === button.dataset.textAlign)
          )
        );
      });
      text(
        'context-selection',
        this.selected.length === 1
          ? this.L.names[this.selected[0]]
          : `已选 ${this.selected.length} 个元素`
      );
    }
    closeContextMenu(restoreFocus = false) {
      this.contextMenu.hidden = true;
      this.closeSubmenus();
      $('editor-more').setAttribute('aria-expanded', 'false');
      if (restoreFocus) {
        let origin = this.menuOrigin;
        if (!origin?.isConnected && origin?.dataset.layer)
          origin = document.querySelector(`[data-layer="${origin.dataset.layer}"]`);
        (origin?.isConnected ? origin : $('desk')).focus({ preventScroll: true });
      }
    }
    closeSubmenus(except = null) {
      for (const trigger of this.contextMenu.querySelectorAll('[data-submenu]')) {
        if (trigger.dataset.submenu === except) continue;
        trigger.setAttribute('aria-expanded', 'false');
        $('context-' + trigger.dataset.submenu).hidden = true;
      }
    }
    openSubmenu(trigger, focus = false) {
      if (trigger.disabled) return;
      this.closeSubmenus(trigger.dataset.submenu);
      const menu = $('context-' + trigger.dataset.submenu);
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      menu.style.left = '';
      menu.style.top = '';
      const branch = trigger.parentElement.getBoundingClientRect();
      const width = menu.offsetWidth,
        height = menu.offsetHeight;
      const left =
        branch.right + width + 5 > innerWidth ? branch.left - width + 4 : branch.right - 4;
      menu.style.left = Math.max(8, Math.min(left, innerWidth - width - 8)) - branch.left + 'px';
      menu.style.top =
        Math.min(0, Math.max(-branch.top + 8, innerHeight - branch.top - height - 8)) + 'px';
      if (focus) menu.querySelector('button:not(:disabled)')?.focus();
    }
    openContextMenu(x, y, origin) {
      if (!this.doc || this.applying || !this.selected.length) return;
      this.closeSubmenus();
      this.syncMenuState();
      this.menuOrigin = origin || $('desk');
      this.contextMenu.hidden = false;
      this.contextMenu.style.left =
        Math.max(8, Math.min(x, innerWidth - this.contextMenu.offsetWidth - 8)) + 'px';
      this.contextMenu.style.top =
        Math.max(8, Math.min(y, innerHeight - this.contextMenu.offsetHeight - 8)) + 'px';
      $('editor-more').setAttribute('aria-expanded', 'true');
      this.contextMenu.focus({ preventScroll: true });
    }
    contextEvent(event) {
      if (!this.doc || this.applying || this.drag) return;
      const atom = event.target.closest('[data-element]');
      const row = event.target.closest('.layer-row');
      const heading = event.target.closest('[data-group-elements]');
      const id = atom?.dataset.element || row?.querySelector('[data-layer]')?.dataset.layer;
      if (id && !this.selected.includes(id)) this.choose(id, false, !!row || event.altKey);
      else if (heading) this.select(heading.dataset.groupElements.split(','));
      if (!this.selected.length) return;
      event.preventDefault();
      this.openContextMenu(
        event.clientX,
        event.clientY,
        (id && document.querySelector(`[data-layer="${id}"]`)) || heading || $('desk')
      );
    }
    menuKeydown(event) {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        this.closeContextMenu(true);
        return;
      }
      const item = event.target.closest('button');
      if (event.key === 'ArrowRight' && item?.dataset.submenu) {
        event.preventDefault();
        this.openSubmenu(item, true);
        return;
      }
      const current = item?.closest('[role="menu"]') || this.contextMenu;
      if (event.key === 'ArrowLeft' && current !== this.contextMenu) {
        event.preventDefault();
        const trigger = current.previousElementSibling;
        this.closeSubmenus();
        trigger.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...current.querySelectorAll('button:not(:disabled)')].filter(
        (button) => button.closest('[role="menu"]') === current
      );
      if (!buttons.length) return;
      let index = buttons.indexOf(item);
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = buttons.length - 1;
      else if (index < 0) index = event.key === 'ArrowUp' ? buttons.length - 1 : 0;
      else index = (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[index].focus();
      if (current === this.contextMenu) this.closeSubmenus();
    }
    drawSelection() {
      if (!this.doc) return;
      const elements = this.elements(),
        ids = this.selected.filter((id) => elements[id]?.visible);
      document
        .querySelectorAll('[data-element]')
        .forEach((node) =>
          node.classList.toggle('element-selected', ids.includes(node.dataset.element))
        );
      this.outline.replaceChildren();
      if (!ids.length) return;
      const box = this.L.bounds(elements, ids);
      const border = document.createElement('div');
      border.className = 'selection-box';
      Object.assign(border.style, {
        left: box.x + 'px',
        top: box.y + 'px',
        width: box.width + 'px',
        height: box.height + 'px',
      });
      const label = document.createElement('span');
      label.className = 'selection-caption';
      label.textContent = `${ids.length === 1 ? this.L.names[ids[0]] : ids.length + ' 个元素'} · ${box.x}, ${box.y}`;
      border.append(label);
      this.outline.append(border);
      $('canvas-hint').textContent =
        `${ids.length === 1 ? this.L.names[ids[0]] : ids.length + ' 个元素'} · ${box.width} × ${box.height}px${ids.some((id) => elements[id].locked) ? ' · 含锁定元素' : ''}`;
    }
    property(key, value) {
      this.commit((elements) => {
        const ids = this.selected,
          dimensions = this.L.size(this.orientation()),
          box = this.L.bounds(elements, ids);
        if (!box) return;
        if (key === 'x' || key === 'y') {
          this.L.translate(
            elements,
            ids,
            key === 'x' ? value - box.x : 0,
            key === 'y' ? value - box.y : 0,
            dimensions
          );
          return;
        }
        for (const id of ids) {
          const item = elements[id];
          if (item.locked && !['locked', 'visible'].includes(key)) continue;
          if (key === 'font') value = Math.max(8, Math.min(96, Math.round(value)));
          if (key === 'width' || key === 'height')
            value = Math.max(1, Math.min(dimensions[key === 'width' ? 0 : 1], Math.round(value)));
          if (key === 'unit' && !['temperature', 'range'].includes(id)) continue;
          item[key] = value;
          item.x = Math.min(item.x, dimensions[0] - item.width);
          item.y = Math.min(item.y, dimensions[1] - item.height);
        }
      });
    }
    align(action) {
      this.commit((elements) => {
        const ids = this.selected.filter((id) => !elements[id].locked),
          box = this.L.bounds(elements, ids);
        if (!box) return;
        const [w, h] = this.L.size(this.orientation());
        if (action.startsWith('distribute')) {
          if (ids.length < 3) return;
          const horizontal = action.endsWith('x'),
            axis = horizontal ? 'x' : 'y',
            length = horizontal ? 'width' : 'height';
          ids.sort((a, b) => elements[a][axis] - elements[b][axis]);
          const last = elements[ids.at(-1)];
          const available =
            last[axis] +
            last[length] -
            elements[ids[0]][axis] -
            ids.reduce((sum, id) => sum + elements[id][length], 0);
          let cursor = elements[ids[0]][axis];
          for (const id of ids) {
            elements[id][axis] = Math.round(cursor);
            cursor += elements[id][length] + available / (ids.length - 1);
          }
          return;
        }
        const target = ids.length === 1 ? { x: 0, y: 0, width: w, height: h } : box;
        for (const id of ids) {
          const e = elements[id];
          if (action === 'left') e.x = target.x;
          if (action === 'center') e.x = Math.round(target.x + (target.width - e.width) / 2);
          if (action === 'right') e.x = target.x + target.width - e.width;
          if (action === 'top') e.y = target.y;
          if (action === 'middle') e.y = Math.round(target.y + (target.height - e.height) / 2);
          if (action === 'bottom') e.y = target.y + target.height - e.height;
        }
      });
    }
    showPhoto() {
      this.commit((elements) => {
        elements.photo.visible = true;
      });
      this.select(['photo'], true);
    }
    undo(redo = false) {
      if (!this.doc || this.applying) return;
      this.doc = redo ? this.history.redo() : this.history.undo();
      this.store();
      this.render();
      renderScreen(shownState());
    }
    template(name) {
      if (!name) return;
      this.commit(() => {
        const orientation = this.orientation(),
          p = orientation === 'portrait';
        const elements = this.L.defaults(orientation, name === 'work' ? 'agents' : 'none');
        if (name === 'focus') {
          for (const [id, e] of Object.entries(elements))
            e.visible = [
              'date',
              'weekday',
              'clock',
              'city',
              'condition',
              'temperature',
              'weather-icon',
            ].includes(id);
          Object.assign(elements.clock, {
            x: 20,
            y: p ? 110 : 65,
            width: p ? 280 : 440,
            height: 110,
            font: 96,
            align: 'center',
          });
          Object.assign(elements.temperature, { x: 30, y: p ? 260 : 200, width: 100, height: 80 });
          Object.assign(elements['weather-icon'], { x: p ? 204 : 350, y: p ? 260 : 200 });
          Object.assign(elements.city, { x: p ? 125 : 195, y: p ? 265 : 210 });
          Object.assign(elements.condition, { x: p ? 125 : 195, y: p ? 294 : 239 });
        }
        if (name === 'work') {
          for (const [id, e] of Object.entries(elements))
            e.visible = ['date', 'weekday', 'clock', 'agents', 'cpu', 'memory', 'ip'].includes(id);
          Object.assign(elements.clock, { x: 18, y: p ? 69 : 45, width: 174, height: 67 });
          Object.assign(elements.agents, {
            x: 18,
            y: p ? 155 : 123,
            width: p ? 284 : 444,
            height: p ? 300 : 179,
          });
        }
        this.doc.layout[orientation] = elements;
        this.selected = [];
        this.editGroup = null;
      });
      $('editor-template').value = '';
    }
    async applyLayout() {
      if (!this.dirty() || this.applying) return;
      this.applying = true;
      this.render();
      this.message('');
      const snapshot = this.L.clone(this.doc);
      try {
        await saveBeforePreview();
        const response = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rotation: snapshot.rotation, screen_layout: snapshot.layout }),
        });
        if (!response.ok) throw Error('应用失败，草稿已保留，可再次应用。');
        const payload = await response.json();
        this.base = this.materialize(payload);
        this.doc = this.L.clone(this.base);
        this.history = new this.L.History(this.doc);
        this.store();
        window.applyPideskState(payload);
        this.message('布局已应用到设备。实体屏幕效果请对照设备查看。');
      } catch (error) {
        this.message(
          error instanceof TypeError
            ? '连接失败，草稿已保留，请恢复连接后重试。'
            : error.message || '应用失败，草稿已保留。',
          true
        );
      } finally {
        this.applying = false;
        this.render();
      }
    }
    bind() {
      $('editor-angle').addEventListener('change', (event) =>
        this.commit(() => {
          this.doc.rotation = Number(event.target.value);
          this.selected = [];
          this.editGroup = null;
        })
      );
      $('editor-zoom').addEventListener('change', resizePreview);
      $('editor-grid').addEventListener('click', () => {
        this.grid = !this.grid;
        $('desk').classList.toggle('show-grid', this.grid);
        $('editor-grid').setAttribute('aria-pressed', String(this.grid));
      });
      $('editor-snap').addEventListener('click', () => {
        this.snapping = !this.snapping;
        $('editor-snap').setAttribute('aria-pressed', String(this.snapping));
      });
      $('editor-undo').addEventListener('click', () => this.undo());
      $('editor-redo').addEventListener('click', () => this.undo(true));
      $('editor-template').addEventListener('change', (event) => this.template(event.target.value));
      $('editor-apply').addEventListener('click', () => this.applyLayout());
      $('editor-revert').addEventListener('click', () =>
        this.commit(() => {
          this.doc = this.L.clone(this.base);
          this.selected = [];
          this.message('');
        })
      );
      $('layer-search').addEventListener('input', () => this.renderLayers());
      for (const input of document.querySelectorAll('[data-prop]')) {
        const continuous = input.type === 'number' || input.type === 'color';
        if (continuous) {
          input.addEventListener('focus', () => {
            this.editingProperty = true;
          });
          input.addEventListener('blur', () => {
            this.editingProperty = false;
            if (this.doc) {
              this.history.push(this.doc);
              this.render();
            }
          });
        }
        input.addEventListener(continuous ? 'input' : 'change', () => {
          const value =
            input.type === 'checkbox'
              ? input.checked
              : input.type === 'number'
                ? Number(input.value)
                : input.value;
          if (input.type === 'number' && (!input.value || !Number.isFinite(value))) return;
          this.property(input.dataset.prop, value);
        });
      }
      document
        .querySelectorAll('[data-align]')
        .forEach((button) =>
          button.addEventListener('click', () => this.align(button.dataset.align))
        );
      $('editor-group').addEventListener('click', () =>
        this.commit((elements) => {
          const group = 'g-' + Date.now().toString(36);
          for (const id of this.selected) if (!elements[id].locked) elements[id].group = group;
        })
      );
      $('editor-ungroup').addEventListener('click', () =>
        this.commit((elements) => {
          for (const id of this.selected) if (!elements[id].locked) elements[id].group = 'none';
          this.editGroup = null;
        })
      );
      for (const [id, z] of [
        ['editor-front', 100],
        ['editor-back', 0],
      ])
        $(id).addEventListener('click', () =>
          this.commit((elements) => {
            const ids = Object.keys(elements).sort((a, b) => elements[a].z - elements[b].z);
            const moving = ids.filter(
              (key) => this.selected.includes(key) && !elements[key].locked
            );
            const rest = ids.filter((key) => !moving.includes(key));
            const order = z === 100 ? [...rest, ...moving] : [...moving, ...rest];
            order.forEach((key, index) => {
              elements[key].z = index;
            });
          })
        );
      $('element-reset').addEventListener('click', () =>
        this.commit((elements) => {
          const initial = this.L.defaults(this.orientation(), state.right_widget);
          for (const id of this.selected) if (!elements[id].locked) elements[id] = initial[id];
        })
      );
      for (const button of document.querySelectorAll('[data-text-align]'))
        button.addEventListener('click', () => this.property('align', button.dataset.textAlign));
      for (const surface of [$('desk'), $('layer-list')])
        surface.addEventListener('contextmenu', (event) => this.contextEvent(event));
      $('editor-more').addEventListener('click', () => {
        if (!this.contextMenu.hidden) {
          this.closeContextMenu(true);
          return;
        }
        const rect = $('editor-more').getBoundingClientRect();
        this.openContextMenu(rect.left, rect.bottom + 6, $('editor-more'));
      });
      for (const trigger of this.contextMenu.querySelectorAll('[data-submenu]')) {
        trigger.addEventListener('pointerenter', () => this.openSubmenu(trigger));
        trigger.addEventListener('click', () => this.openSubmenu(trigger, true));
      }
      this.contextMenu.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (button && !button.dataset.submenu) this.closeContextMenu(true);
      });
      this.contextMenu.addEventListener('pointerover', (event) => {
        const button = event.target.closest('button');
        if (
          button &&
          !button.dataset.submenu &&
          button.closest('[role="menu"]') === this.contextMenu
        )
          this.closeSubmenus();
      });
      this.contextMenu.addEventListener('contextmenu', (event) => event.preventDefault());
      this.contextMenu.addEventListener('keydown', (event) => {
        event.stopPropagation();
        this.menuKeydown(event);
      });
      document.addEventListener(
        'pointerdown',
        (event) => {
          if (
            !this.contextMenu.hidden &&
            !this.contextMenu.contains(event.target) &&
            !event.target.closest('#editor-more')
          )
            this.closeContextMenu();
        },
        true
      );
      document.addEventListener(
        'scroll',
        (event) => {
          if (!this.contextMenu.contains(event.target)) this.closeContextMenu();
        },
        true
      );
      window.addEventListener('resize', () => this.closeContextMenu());
      window.addEventListener('blur', () => this.closeContextMenu());
      $('desk').addEventListener('dblclick', (event) => {
        const atom = event.target.closest('[data-element]');
        if (atom) this.select([atom.dataset.element], true);
      });
      $('desk').addEventListener('pointerdown', (event) => this.pointerDown(event));
      $('desk').addEventListener('pointermove', (event) => this.pointerMove(event));
      $('desk').addEventListener('pointerup', (event) => this.pointerUp(event));
      $('desk').addEventListener('pointercancel', (event) => this.pointerUp(event, true));
      window.addEventListener('keydown', (event) => this.keydown(event));
      $('editor-export').addEventListener('click', () => this.export());
      $('editor-import').addEventListener('click', () => $('layout-file').click());
      $('layout-file').addEventListener('change', (event) => this.import(event));
    }
    pointerDown(event) {
      if (!this.doc || this.applying || event.button !== 0) return;
      const atom = event.target.closest('[data-element]');
      if (!atom) {
        this.select([]);
        return;
      }
      event.preventDefault();
      $('desk').focus({ preventScroll: true });
      const id = atom.dataset.element;
      if (event.shiftKey || !this.selected.includes(id))
        this.choose(id, event.shiftKey, event.altKey);
      if (event.shiftKey) return;
      const ids = this.selected.filter(
        (key) => !this.elements()[key].locked && this.elements()[key].visible
      );
      if (!ids.length) return;
      this.drag = {
        ids,
        initial: this.L.clone(this.doc),
        clientX: event.clientX,
        clientY: event.clientY,
        pointerId: event.pointerId,
      };
      $('desk').setPointerCapture(event.pointerId);
      $('desk').classList.add('dragging');
    }
    pointerMove(event) {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      const dimensions = this.L.size(this.orientation()),
        scale = $('desk').getBoundingClientRect().width / dimensions[0];
      let dx = (event.clientX - this.drag.clientX) / scale,
        dy = (event.clientY - this.drag.clientY) / scale;
      this.doc = this.L.clone(this.drag.initial);
      const elements = this.elements();
      this.guides.replaceChildren();
      if (this.snapping && !event.altKey) {
        const snapped = this.L.snap(elements, this.drag.ids, dx, dy, dimensions, 4 / scale);
        dx = snapped.dx;
        dy = snapped.dy;
        for (const guide of snapped.guides) {
          const line = document.createElement('i');
          line.className = 'snap-guide ' + guide.axis;
          line.style[guide.axis === 'x' ? 'left' : 'top'] = guide.at + 'px';
          this.guides.append(line);
        }
      }
      this.L.translate(elements, this.drag.ids, dx, dy, dimensions);
      renderLayout(shownState());
      this.drawSelection();
      this.renderInspector();
    }
    pointerUp(event, cancel = false) {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      if (cancel) this.doc = this.drag.initial;
      const pointerId = this.drag.pointerId;
      this.drag = null;
      if ($('desk').hasPointerCapture(pointerId)) $('desk').releasePointerCapture(pointerId);
      $('desk').classList.remove('dragging');
      this.guides.replaceChildren();
      this.history.push(this.doc);
      this.store();
      this.render();
      renderScreen(shownState());
    }
    keydown(event) {
      if (
        !this.doc ||
        this.applying ||
        event.target.closest('input,select,textarea,[contenteditable="true"]')
      )
        return;
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        if (this.selected.length && event.target.closest('#desk,#layer-list')) {
          event.preventDefault();
          const anchor =
            event.target.closest('[data-layer]') ||
            document.querySelector(`[data-element="${this.selected[0]}"]`) ||
            $('desk');
          const rect = anchor.getBoundingClientRect();
          this.openContextMenu(rect.left, rect.bottom + 4, event.target);
        }
        return;
      }
      const cmd = event.ctrlKey || event.metaKey;
      if (cmd && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        this.undo(event.shiftKey);
        return;
      }
      if (cmd && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        this.undo(true);
        return;
      }
      if (event.key === 'Escape') {
        if (this.drag) {
          const pointerId = this.drag.pointerId;
          this.doc = this.drag.initial;
          this.pointerUp({ pointerId }, true);
        } else {
          this.editGroup = null;
          this.select([]);
        }
        return;
      }
      if (!this.selected.length || !event.target.closest('#desk,#layer-list')) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        this.commit((elements) =>
          this.L.translate(
            elements,
            this.selected,
            event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
            event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
            this.L.size(this.orientation())
          )
        );
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        this.commit((elements) => {
          for (const id of this.selected) if (!elements[id].locked) elements[id].visible = false;
        });
      }
    }
    export() {
      if (!this.doc) return;
      const file = new Blob(
        [
          JSON.stringify(
            {
              format: 'pidesk-layout',
              version: 1,
              rotation: this.doc.rotation,
              screen_layout: this.doc.layout,
            },
            null,
            2
          ),
        ],
        { type: 'application/json' }
      );
      const url = URL.createObjectURL(file),
        a = document.createElement('a');
      a.href = url;
      a.download = 'pidesk-layout.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async import(event) {
      const input = event.target,
        file = input.files?.[0];
      if (!file) return;
      try {
        if (file.size > 32768) throw Error('布局文件不能超过 32KB。');
        const value = JSON.parse(await file.text());
        if (
          value.format !== 'pidesk-layout' ||
          value.version !== 1 ||
          value.screen_layout?.version !== 1 ||
          ![0, 90, 180, 270].includes(value.rotation)
        )
          throw Error('无法读取此布局，请选择 pidesk 导出的布局文件。');
        this.commit(() => {
          this.doc = this.materialize({
            rotation: value.rotation,
            screen_layout: this.L.normalize(value.screen_layout),
          });
          this.selected = [];
        });
        this.message('布局已导入草稿，应用后才会更新设备。');
      } catch (error) {
        this.message(error.message || '布局导入失败。', true);
      } finally {
        input.value = '';
      }
    }
  }
  window.layoutEditor = new LayoutEditor();
  if (state) {
    window.layoutEditor.receive(state);
    renderScreen(shownState());
  }
}
