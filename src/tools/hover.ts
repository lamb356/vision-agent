import type { Page } from 'playwright';

import { diffSnapshots } from '../differ.js';
import { takeEnrichedSnapshot } from '../snapshot.js';
import { HoverToolResult } from '../types.js';

function extractTextHint(selector: string): string | null {
  var textEqualsMatch = selector.match(/text\s*=\s*["']([^"']+)["']/i);
  if (textEqualsMatch?.[1]) {
    return textEqualsMatch[1].trim();
  }

  var hasTextMatch = selector.match(/:has-text\(\s*["']([^"']+)["']\s*\)/i);
  if (hasTextMatch?.[1]) {
    return hasTextMatch[1].trim();
  }

  var quoted = selector.match(/["']([^"']+)["']/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  return null;
}

export async function hoverTool(page: Page, selector: string): Promise<HoverToolResult> {
  var before = await takeEnrichedSnapshot(page);
  var errors: string[] = [];
  var result: unknown = null;

  try {
    var textHint = extractTextHint(selector);
    var usedLeafTarget = false;

    if (textHint) {
      var box = await page.evaluate((hint) => {
        var h = String(hint || '').toLowerCase();
        var all = Array.from(document.querySelectorAll('*'));
        var target = all
          .filter((el) => el.children.length === 0 && String(el.textContent || '').toLowerCase().includes(h))
          .sort((a, b) => String(a.textContent || '').length - String(b.textContent || '').length)[0];

        if (!target) {
          return null;
        }

        var rect = target.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          return null;
        }

        return {
          x: Math.max(0, rect.left + rect.width / 2),
          y: Math.max(0, rect.top + rect.height / 2)
        };
      }, textHint);

      if (box) {
        await page.mouse.move(box.x, box.y);
        await page.waitForTimeout(1000);
        usedLeafTarget = true;
      }
    }

    if (!usedLeafTarget) {
      try {
        await page.hover(selector, { timeout: 3000 });
        await page.waitForTimeout(1000);
      } catch (hoverError) {
        var genericBox = await page.evaluate(() => {
          var all = Array.from(document.querySelectorAll('*'));
          var target = all
            .filter((el) => el.children.length === 0 && String(el.textContent || '').toLowerCase().includes('hover'))
            .sort((a, b) => String(a.textContent || '').length - String(b.textContent || '').length)[0];

          if (!target) {
            return null;
          }

          var rect = target.getBoundingClientRect();
          if (!rect.width || !rect.height) {
            return null;
          }

          return {
            x: Math.max(0, rect.left + rect.width / 2),
            y: Math.max(0, rect.top + rect.height / 2)
          };
        });

        if (!genericBox) {
          throw hoverError;
        }

        await page.mouse.move(genericBox.x, genericBox.y);
        await page.waitForTimeout(1000);
        usedLeafTarget = true;
      }
    }

    var discoveredCode = await page.evaluate(() => {
      var codeRegex = /\b[A-Z0-9]{6}\b/g;
      var bodyText = String(document.body?.innerText || '');
      var matches = bodyText.match(codeRegex) || [];
      if (matches.length > 0) {
        return matches[matches.length - 1];
      }

      var allEls = document.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i += 1) {
        var el = allEls[i];
        var before = window.getComputedStyle(el, '::before').content;
        var after = window.getComputedStyle(el, '::after').content;
        var values = [before, after];
        for (var j = 0; j < values.length; j += 1) {
          var value = values[j];
          if (!value || value === 'none') {
            continue;
          }

          var cleaned = String(value).replace(/['"]/g, '').trim();
          if (/^[A-Z0-9]{6}$/.test(cleaned)) {
            return cleaned;
          }
        }
      }

      return null;
    });

    result = { ok: true, selector, method: usedLeafTarget ? 'mouse.move(leaf)' : 'page.hover(selector)', code: discoveredCode };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    result = { ok: false, selector };
  }

  var after = await takeEnrichedSnapshot(page);
  var changes = diffSnapshots(before, after);

  return {
    selector,
    result,
    changes,
    snapshot: after,
    errors
  };
}
