'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

async function checkWidgetScroll(browser, id, report, targetSelector) {
  const host = 'http://dashboard.test';
  const folder = path.resolve(__dirname, '../../widgets', id, 'public');
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    await page.addInitScript(() => {
      if (window === parent) return;
      document.addEventListener('DOMContentLoaded', () =>
        window.onHomeyReady({
          api: () => fetch('/snapshot').then((r) => r.json()),
          ready(options) {
            this.setHeight(options?.height);
          },
          setHeight(height) {
            parent.postMessage({ height }, location.origin);
          },
        }),
      );
    });
    await page.route(host + '/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{margin:0;padding:40px 0 120vh}iframe{width:100%;height:220px;border:0;display:block}</style>
        <iframe title="Widget" src="/widget/index.html"></iframe>
        <script>addEventListener('message', e => {
          const frame = document.querySelector('iframe');
          if (e.origin === location.origin && e.source === frame.contentWindow && Number.isFinite(e.data.height))
            frame.style.height = e.data.height + 'px';
        });</script>`,
        });
      if (pathname === '/homey.js')
        return route.fulfill({ contentType: 'text/javascript', body: '' });
      if (pathname === '/snapshot') return route.fulfill({ json: report });
      if (/^\/widget\/[\w.-]+$/.test(pathname))
        return route.fulfill({ path: path.join(folder, path.basename(pathname)) });
      return route.fulfill({ status: 404, body: '' });
    });
    const session = await page.context().newCDPSession(page);
    for (const constrained of [false, true]) {
      await page.goto(host);
      const widget = page.frameLocator('iframe');
      const target = widget.locator(targetSelector).first();
      await target.waitFor();
      const fit = (value) => widget.locator(`html[data-widget-fits="${value}"]`).waitFor();
      await fit(true);
      const box = await target.boundingBox();
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      if (constrained) {
        // Keep the swipe target visible while exposing real vertical overflow.
        await page.locator('iframe').evaluate((el, start) => {
          el.style.maxHeight = start - el.getBoundingClientRect().top + 8 + 'px';
        }, y);
        await fit(false);
      } else {
        assert.deepEqual(
          await widget.locator('html').evaluate((el) => {
            const style = getComputedStyle(el);
            return [style.overflowX, style.overflowY, getComputedStyle(document.body).overflow];
          }),
          ['hidden', 'hidden', 'visible'],
          id,
        );
      }
      const offsets = () =>
        page.evaluate(() => [
          scrollY,
          document.querySelector('iframe').contentDocument.scrollingElement.scrollTop,
        ]);
      assert.deepEqual(await offsets(), [0, 0], id);
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
      });
      for (let distance = 6; distance <= 54; distance += 6) {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y - distance }],
        });
      }
      // Inspect scroll ownership while the finger is down, before fling momentum.
      await page.waitForFunction(
        (inner) =>
          (inner
            ? document.querySelector('iframe').contentDocument.scrollingElement.scrollTop
            : scrollY) > 0,
        constrained,
        { timeout: 5000 },
      );
      const [outer, inner] = await offsets();
      assert.equal(constrained ? outer : inner, 0, id);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  } finally {
    await page.close();
  }
}
module.exports = { checkWidgetScroll };
