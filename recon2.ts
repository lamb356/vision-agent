import { chromium } from 'playwright';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://serene-frangipane-7fd25b.netlify.app');
  await page.waitForTimeout(2000);
  
  // Click START
  const startBtn = await page.$('text=START');
  if (startBtn) await startBtn.click();
  await page.waitForTimeout(3000);
  
  const info = await page.evaluate(() => {
    const w = window as any;
    const state = w.__CHALLENGE_STATE__ || w.challengeState || w.state || w.gameState || null;
    
    // Search ALL window properties for codes
    const windowCodes: string[] = [];
    for (const key of Object.keys(w)) {
      try {
        const val = JSON.stringify(w[key]);
        const m = val?.match(/[A-Z0-9]{6}/g);
        if (m) windowCodes.push(...m.map((c: string) => key + ':' + c));
      } catch {}
    }
    
    // Check data attributes
    const dataAttrs: any[] = [];
    document.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        if (/[A-Z0-9]{6}/.test(attr.value) && attr.value.length < 100) {
          dataAttrs.push({ tag: el.tagName, attr: attr.name, val: attr.value.substring(0, 80) });
        }
      }
    });
    
    // CSS pseudo-element content
    const cssContent: any[] = [];
    document.querySelectorAll('*').forEach(e => {
      const before = getComputedStyle(e, '::before').content;
      const after = getComputedStyle(e, '::after').content;
      if (before !== 'none' && before !== '""') cssContent.push({ tag: e.tagName, pseudo: 'before', content: before.substring(0, 80) });
      if (after !== 'none' && after !== '""') cssContent.push({ tag: e.tagName, pseudo: 'after', content: after.substring(0, 80) });
    });
    
    // ALL text nodes with short content containing uppercase+digits
    const textNodes: any[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walk.nextNode()) {
      const t = (node.textContent || '').trim();
      if (t.length >= 6 && t.length <= 20 && /[A-Z]/.test(t) && /[0-9]/.test(t)) {
        const parent = node.parentElement;
        textNodes.push({ text: t, tag: parent?.tagName, class: parent?.className?.substring(0, 50), display: parent ? getComputedStyle(parent).display : '', vis: parent ? getComputedStyle(parent).visibility : '' });
      }
    }
    
    const title = document.title;
    const bodyText = document.body.innerText.substring(0, 3000);
    const html = document.body.innerHTML.substring(0, 5000);
    
    return { title, state, windowCodes: windowCodes.slice(0, 30), dataAttrs: dataAttrs.slice(0, 20), cssContent: cssContent.slice(0, 20), textNodes, bodyTextSnippet: bodyText.substring(0, 2000), htmlSnippet: html.substring(0, 3000) };
  });
  
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
