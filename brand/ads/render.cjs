// Renders the ads in ads.html to PNG files next to it: node brand/ads/render.cjs
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(__dirname, 'ads.html'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  for (const [id, file] of [['portrait', 'ad-feed-1080x1350.png'], ['square', 'ad-square-1080x1080.png'], ['story', 'ad-story-1080x1920.png']]) {
    await (await page.$('#' + id)).screenshot({ path: path.join(__dirname, file) });
    console.log('wrote', file);
  }
  await browser.close();
})();
