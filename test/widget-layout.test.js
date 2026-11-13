'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { create } = require('../lib/widget-layout');
function fixture({
  height = 587.4,
  viewport = 600,
  observer = true,
  missing = false,
  setHeight = true,
} = {}) {
  const calls = [],
    attributes = {},
    frames = [],
    events = new Map(),
    visualEvents = new Map();
  let observerCallback,
    observations = 0,
    disconnected = false;
  const box = { height },
    element = { getBoundingClientRect: () => ({ height: box.height }) };
  const view = {
    innerHeight: viewport,
    visualViewport: {
      height: viewport,
      addEventListener: (key, fn) => visualEvents.set(key, fn),
      removeEventListener: (key) => visualEvents.delete(key),
    },
    addEventListener: (key, fn) => events.set(key, fn),
    removeEventListener: (key) => events.delete(key),
    requestAnimationFrame: (fn) => frames.push(fn),
  };
  if (observer)
    view.ResizeObserver = class {
      constructor(callback) {
        observerCallback = callback;
      }
      observe(target) {
        assert.equal(target, element);
        observations++;
      }
      disconnect() {
        disconnected = true;
      }
    };
  let reject = false,
    throwSync = false;
  const Homey = { ready: (opts) => calls.push(['ready', opts?.height]) };
  if (setHeight)
    Homey.setHeight = (height) => {
      calls.push(['height', height]);
      if (throwSync) throw new Error('host failed');
      return reject ? Promise.reject(new Error('host rejected')) : Promise.resolve();
    };
  const document = {
    body: { scrollHeight: 2000 },
    documentElement: { setAttribute: (key, value) => (attributes[key] = value) },
    getElementById: () => (missing ? null : element),
    fonts: { ready: Promise.resolve() },
  };
  const layout = create(Homey, { document, view });
  return {
    layout,
    calls,
    attributes,
    box,
    view,
    events,
    visualEvents,
    frames,
    resize: () => observerCallback(),
    flush() {
      while (frames.length) frames.shift()();
    },
    get observations() {
      return observations;
    },
    get disconnected() {
      return disconnected;
    },
    set reject(value) {
      reject = value;
    },
    set throwSync(value) {
      throwSync = value;
    },
  };
}
test('intrinsic content, not the old viewport/body, determines initial height with rounding slack', () => {
  assert.equal(
    fs.readFileSync(path.join(__dirname, '../lib/widget-layout.js'), 'utf8'),
    fs.readFileSync(
      path.join(__dirname, '../widgets/energy-overview/public/widget-layout.js'),
      'utf8',
    ),
  );
  const v = fixture();
  v.layout.refresh();
  assert.deepEqual(v.calls, [['ready', 590]]);
  assert.equal(v.attributes['data-widget-fits'], 'true');
  assert.equal(v.observations, 1);
  v.layout.refresh();
  assert.equal(v.calls.length, 1); // no feedback loop from a larger cached frame
});
test('content changes, font readiness and viewport changes resize without losing genuine overflow', async () => {
  const v = fixture();
  v.layout.refresh();
  await Promise.resolve();
  v.flush();
  v.box.height = 900.25;
  v.resize();
  v.resize();
  assert.equal(v.frames.length, 1);
  v.flush();
  assert.deepEqual(v.calls.at(-1), ['height', 903]);
  assert.equal(v.attributes['data-widget-fits'], 'false');
  v.view.innerHeight = 903;
  v.view.visualViewport.height = 903;
  v.events.get('resize')();
  v.flush();
  assert.equal(v.attributes['data-widget-fits'], 'true');
  assert.equal(v.calls.length, 2);
  v.view.visualViewport.height = 450;
  v.visualEvents.get('resize')();
  v.flush();
  assert.equal(v.attributes['data-widget-fits'], 'false'); // pinch zoom keeps content reachable
  v.box.height = 200;
  v.resize();
  v.flush();
  assert.deepEqual(v.calls.at(-1), ['height', 202]);
  assert.equal(v.attributes['data-widget-fits'], 'true');
});
test('rejected or absent host resizing keeps the overflow fallback and allows retry', async () => {
  const v = fixture({ viewport: 300, height: 200 });
  v.layout.refresh();
  v.box.height = 600;
  v.reject = true;
  v.layout.refresh();
  await Promise.resolve();
  assert.equal(v.attributes['data-widget-fits'], 'false');
  v.reject = false;
  v.layout.refresh();
  assert.equal(v.calls.filter((c) => c[0] === 'height').length, 2);
  v.throwSync = true;
  v.box.height = 700;
  assert.doesNotThrow(() => v.layout.refresh());
  assert.equal(v.attributes['data-widget-fits'], 'false');
  const oldHost = fixture({ viewport: 300, height: 200, setHeight: false });
  oldHost.layout.refresh();
  oldHost.box.height = 600;
  oldHost.layout.refresh();
  assert.equal(oldHost.attributes['data-widget-fits'], 'false');
});
test('legacy observer fallback, missing geometry and disposal remain safe', async () => {
  const v = fixture({ observer: false });
  delete v.view.requestAnimationFrame;
  v.layout.refresh();
  v.box.height = 700;
  v.events.get('resize')();
  await Promise.resolve();
  assert.deepEqual(v.calls.at(-1), ['height', 702]);
  const missing = fixture({ missing: true });
  missing.layout.refresh();
  assert.deepEqual(missing.calls, [['ready', undefined]]);
  assert.equal(missing.attributes['data-widget-fits'], 'false');
  assert.equal(missing.observations, 0);
  const active = fixture();
  active.layout.refresh();
  active.resize();
  active.layout.dispose();
  active.box.height = 900;
  active.flush();
  active.layout.refresh();
  assert.equal(active.calls.length, 1);
  assert.equal(active.disconnected, true);
  assert.equal(active.events.size, 0);
  assert.equal(active.visualEvents.size, 0);
});

test('exactly fitting content is not treated as overflow merely because of the height buffer', () => {
  const fits = fixture({ height: 587.4, viewport: 588 });
  fits.layout.refresh();
  assert.equal(fits.attributes['data-widget-fits'], 'true');
  const overflow = fixture({ height: 587.4, viewport: 587 });
  overflow.layout.refresh();
  assert.equal(overflow.attributes['data-widget-fits'], 'false');
});
