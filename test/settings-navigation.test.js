'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bind } = require('../settings/navigation');
function fixture() {
  let focused;
  function element(id, dataset = {}) {
    return {
      id,
      dataset,
      hidden: false,
      value: '',
      attrs: {},
      handlers: {},
      setAttribute(key, value) {
        this.attrs[key] = value;
      },
      removeAttribute(key) {
        delete this.attrs[key];
      },
      addEventListener(type, handler) {
        this.handlers[type] = handler;
      },
      focus() {
        focused = this.id;
      },
      scrollIntoView() {},
    };
  }
  const tabs = ['overview', 'settings', 'history'].map((name) =>
    element('tab-' + name, { tab: name }),
  );
  const panels = tabs.map((tab) => element('panel-' + tab.dataset.tab));
  const categories = ['connections', 'costs', 'car'].map((name) =>
    element('menu-' + name, { settingsCategory: name }),
  );
  const pages = categories.map((button) => element('settings-' + button.dataset.settingsCategory));
  const headings = categories.map((button) =>
    element('settings-heading-' + button.dataset.settingsCategory),
  );
  const picker = element('settingsCategory');
  picker.value = 'connections';
  const link = element('link', { settingsLink: 'costs' });
  const all = [...tabs, ...panels, ...categories, ...pages, ...headings, picker];
  const document = {
    querySelectorAll: (selector) =>
      ({
        '[data-tab]': tabs,
        '.panel': panels,
        '[data-settings-category]': categories,
        '.settings-page': pages,
        '[data-settings-link]': [link],
      })[selector],
    getElementById: (id) => all.find((item) => item.id === id),
  };
  return {
    nav: bind(document),
    tabs,
    panels,
    categories,
    pages,
    picker,
    link,
    focused: () => focused,
  };
}
test('category changes preserve edited inputs and the selected category when returning to settings', () => {
  const v = fixture();
  const input = { value: 'unsaved draft' };
  v.pages[1].input = input;
  v.nav.showTab('settings');
  v.categories[1].handlers.click();
  assert.equal(v.picker.value, 'costs');
  assert.equal(v.focused(), 'settings-heading-costs');
  assert.equal(v.categories[1].attrs['aria-current'], 'page');
  assert.equal(v.categories[0].attrs['aria-current'], undefined);
  v.picker.value = 'car';
  v.picker.handlers.change();
  assert.equal(v.pages[1].hidden, true);
  assert.equal(v.pages[2].hidden, false);
  v.nav.showTab('history');
  v.nav.showTab('settings');
  assert.equal(v.picker.value, 'car');
  v.categories[1].handlers.click();
  assert.equal(v.pages[1].input, input);
  assert.equal(input.value, 'unsaved draft');
  assert.equal(v.pages.filter((page) => !page.hidden).length, 1);
});
test('top tabs support arrow keys, wrapping, Home/End and a single keyboard tab stop', () => {
  const v = fixture();
  let prevented = 0;
  function key(index, key) {
    v.tabs[index].handlers.keydown({
      key,
      preventDefault() {
        prevented++;
      },
    });
  }
  key(0, 'ArrowLeft');
  assert.equal(v.focused(), 'tab-history');
  assert.equal(v.panels[2].hidden, false);
  key(2, 'ArrowRight');
  assert.equal(v.focused(), 'tab-overview');
  key(0, 'End');
  key(2, 'Home');
  assert.equal(v.focused(), 'tab-overview');
  assert.deepEqual(
    v.tabs.map((tab) => tab.tabIndex),
    [0, -1, -1],
  );
  assert.deepEqual(
    v.tabs.map((tab) => tab.attrs['aria-selected']),
    ['true', 'false', 'false'],
  );
  key(0, 'Tab');
  assert.equal(prevented, 4);
});
test('cross-category links synchronize both menus; unknown destinations keep the active view', () => {
  const v = fixture();
  v.link.handlers.click();
  assert.equal(v.panels[1].hidden, false);
  assert.equal(v.picker.value, 'costs');
  assert.equal(v.pages[1].hidden, false);
  v.nav.showCategory('unknown');
  v.nav.showTab('unknown');
  assert.equal(v.panels[1].hidden, false);
  assert.equal(v.pages[1].hidden, false);
  assert.equal(v.focused(), 'settings-heading-costs');
});
