import { chromium } from 'playwright';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://serene-frangipane-7fd25b.netlify.app');
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const state = (window as any).__CHALLENGE_STATE__ || (window as any).state || null;
    const scripts = Array.from(document.querySelectorAll('script')).map(s => s.textContent?.substring(0, 500));
    const iframes = document.querySelectorAll('iframe').length;
    const shadowHosts = Array.from(document.querySelectorAll('*')).filter(e => e.shadowRoot).length;
    const cssContent = Array.from(document.querySelectorAll('*')).map(e => {
      const before = getComputedStyle(e, '::before').content;
      const after = getComputedStyle(e, '::after').content;
      return { tag: e.tagName, before, after };
    }).filter(x => x.before !== 'none' || x.after !== 'none');
    const hiddenWithCode = Array.from(document.querySelectorAll('*')).filter(e => {
      const t = (e.textContent || '').trim();
      return /[A-Z0-9]{6}/.test(t) && t.length < 50;
    }).map(e => ({ tag: e.tagName, class: e.className, text: e.textContent?.trim().substring(0, 100), display: getComputedStyle(e).display, vis: getComputedStyle(e).visibility }));
    const title = document.title;
    const stepText = document.body.innerText.substring(0, 2000);
    return { title, state, iframes, shadowHosts, cssContent: cssContent.slice(0, 20), hiddenWithCode, scripts: scripts.slice(0, 5), stepText: stepText.substring(0, 1500) };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
