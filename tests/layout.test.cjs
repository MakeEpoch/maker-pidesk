const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../app/web/layout.js');

test('group translation preserves spacing, clamps to canvas and skips locked atoms', () => {
  const scene = L.defaults('landscape');
  const original = L.clone(scene);
  scene.weekday.locked = true;
  L.translate(scene, ['date', 'weekday', 'clock'], 1000, -1000, [480, 320]);
  assert.equal(scene.weekday.x, original.weekday.x);
  assert.equal(scene.date.y, 0);
  assert.equal(scene.clock.x - scene.date.x, original.clock.x - original.date.x);
  assert.ok(scene.clock.x + scene.clock.width <= 480);
});
test('snapping finds shared centers and leaves far movements unchanged', () => {
  const scene = {
    a: { x: 10, y: 10, width: 20, height: 20, visible: true },
    b: { x: 100, y: 100, width: 20, height: 20, visible: true },
  };
  const near = L.snap(scene, ['a'], 87, 89, [480, 320], 4);
  assert.equal(near.dx, 90);
  assert.equal(near.dy, 90);
  assert.equal(near.guides.length, 2);
  const far = L.snap(scene, ['a'], 35, 35, [480, 320], 1);
  assert.equal(far.dx, 35);
  assert.equal(far.dy, 35);
});
test('undo and redo preserve both orientations; a new edit discards redo history', () => {
  const initial = {
    rotation: 0,
    layout: { landscape: { clock: { x: 18 } }, portrait: { clock: { x: 74 } } },
  };
  const history = new L.History(initial),
    next = L.clone(initial);
  next.layout.landscape.clock.x = 80;
  history.push(next);
  next.rotation = 90;
  next.layout.portrait.clock.x = 100;
  history.push(next);
  assert.equal(history.undo().rotation, 0);
  assert.equal(history.undo().layout.landscape.clock.x, 18);
  assert.equal(history.redo().layout.landscape.clock.x, 80);
  next.layout.landscape.clock.x = 140;
  history.push(next);
  assert.equal(history.redo().layout.landscape.clock.x, 140);
});
test('normalized imported overrides cannot inject CSS or hide with nonboolean values', () => {
  const layout = {
    version: 1,
    landscape: {
      clock: {
        x: -100,
        width: 9999,
        color: 'url(secret)',
        visible: 'false',
        group: '<script>',
        unknown: 1,
      },
    },
    portrait: {},
  };
  const scene = L.scene(layout, 'landscape');
  assert.equal(scene.clock.x, 0);
  assert.equal(scene.clock.width, 480);
  assert.equal(scene.clock.visible, true);
  assert.equal(scene.clock.color, '#f0f7fa');
  assert.equal(scene.clock.unknown, undefined);
  assert.equal(L.mode(270), 'portrait');
  assert.equal(L.mode(180), 'landscape');
});
test('legacy right widget is used when no custom layout exists; custom scenes can show multiple modules', () => {
  const empty = { version: 1, landscape: {}, portrait: {} };
  assert.equal(L.scene(empty, 'landscape', 'agents').agents.visible, true);
  const custom = {
    version: 1,
    landscape: { calendar: { visible: true }, agents: { visible: true } },
    portrait: {},
  };
  const scene = L.scene(custom, 'landscape', 'none');
  assert.equal(scene.calendar.visible, true);
  assert.equal(scene.agents.visible, true);
});
