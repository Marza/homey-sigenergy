(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SettingsNavigation = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function bind(document) {
    const tabs = [...document.querySelectorAll('[data-tab]')];
    const panels = [...document.querySelectorAll('.panel')];
    const categories = [...document.querySelectorAll('[data-settings-category]')];
    const pages = [...document.querySelectorAll('.settings-page')];
    const picker = document.getElementById('settingsCategory');
    function showTab(name) {
      if (!tabs.some((tab) => tab.dataset.tab === name)) return;
      for (const panel of panels) panel.hidden = panel.id !== 'panel-' + name;
      for (const tab of tabs) {
        const selected = tab.dataset.tab === name;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
    }
    function showCategory(name, focus = false) {
      if (!pages.some((page) => page.id === 'settings-' + name)) return;
      for (const page of pages) page.hidden = page.id !== 'settings-' + name;
      for (const button of categories) {
        if (button.dataset.settingsCategory === name) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
      picker.value = name;
      if (focus) {
        const heading = document.getElementById('settings-heading-' + name);
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: 'start' });
      }
    }
    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener('click', () => showTab(tab.dataset.tab));
      tab.addEventListener('keydown', (event) => {
        let target;
        if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') target = (index + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') target = 0;
        else if (event.key === 'End') target = tabs.length - 1;
        else return;
        event.preventDefault();
        showTab(tabs[target].dataset.tab);
        tabs[target].focus();
      });
    }
    if (pages.length && picker) {
      picker.addEventListener('change', () => showCategory(picker.value, true));
      for (const button of categories)
        button.addEventListener('click', () => showCategory(button.dataset.settingsCategory, true));
      for (const link of document.querySelectorAll('[data-settings-link]'))
        link.addEventListener('click', () => {
          showTab('settings');
          showCategory(link.dataset.settingsLink, true);
        });
      showCategory(picker.value || 'connections');
    }
    return { showTab, showCategory };
  }
  return { bind };
});
