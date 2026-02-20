import type { ConsoleMessage, Page } from 'playwright';

import { diffSnapshots } from '../differ.js';
import { takeEnrichedSnapshot } from '../snapshot.js';
import { JsToolResult } from '../types.js';

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsetTimeout\s*\(/i, reason: 'setTimeout is not allowed in js()' },
  { pattern: /\bsetInterval\s*\(/i, reason: 'setInterval is not allowed in js()' },
  { pattern: /\bfetch\s*\(/i, reason: 'fetch is not allowed in js()' },
  { pattern: /\bXMLHttpRequest\b/i, reason: 'XMLHttpRequest is not allowed in js()' },
  { pattern: /\bwindow\.location\b/i, reason: 'window.location mutation is not allowed in js()' },
  { pattern: /\bhistory\.pushState\b/i, reason: 'history.pushState is not allowed in js()' },
  { pattern: /\bhistory\.replaceState\b/i, reason: 'history.replaceState is not allowed in js()' },
  { pattern: /\bhistory\.back\s*\(/i, reason: 'history.back is not allowed in js()' },
  { pattern: /\bhistory\.forward\s*\(/i, reason: 'history.forward is not allowed in js()' },
  { pattern: /\bhistory\.go\s*\(/i, reason: 'history.go is not allowed in js()' }
];

const REACT_FORM_HELPER_SCRIPT = `(function(){
  window.__codexReactForm = {
    setValue: function(el, val) {
      if (!el) {
        return false;
      }
      try {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(val));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch (e) {
        try {
          el.value = String(val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (innerErr) {
          return false;
        }
        return true;
      }
    },
    setChecked: function(el, checked) {
      if (!el) {
        return false;
      }
      try {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set.call(el, !!checked);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('click', { bubbles: true }));
        return true;
      } catch (e) {
        try {
          el.checked = !!checked;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (innerErr) {
          return false;
        }
        return true;
      }
    },
    selectRadioByLabel: function(labelText) {
      var labels = document.querySelectorAll('label');
      var wanted = String(labelText || '').toLowerCase();
      for (var i = 0; i < labels.length; i += 1) {
        var label = labels[i];
        var text = String(label.textContent || '').toLowerCase();
        if (text.indexOf(wanted) !== -1) {
          var radio = label.querySelector('input[type="radio"]');
          if (!radio && label.htmlFor) {
            radio = document.getElementById(label.htmlFor);
          }
          if (radio) {
            this.setChecked(radio, true);
            return true;
          }
        }
      }
      return false;
    }
  };
  return true;
})()`;

function looksLikeIife(code: string): boolean {
  var trimmed = code.trim();
  return /^\(\s*(?:\(\s*\)\s*=>|function\s*\()/s.test(trimmed) && /\)\s*\(\s*\)\s*;?\s*$/s.test(trimmed);
}

function normalizeJsCode(code: string): string {
  var trimmed = code.trim();
  if (!trimmed) {
    return '(() => { return null; })()';
  }

  if (looksLikeIife(trimmed)) {
    return trimmed;
  }

  return `(() => { var __result = (function(){ ${trimmed} })(); return __result; })()`;
}

function validateCode(code: string): string[] {
  var errors: string[] = [];

  for (var rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(code)) {
      errors.push(rule.reason);
    }
  }

  return errors;
}

async function ensureReactFormHelper(page: Page): Promise<void> {
  try {
    await page.evaluate(REACT_FORM_HELPER_SCRIPT);
  } catch {
    // Best effort helper install.
  }
}

export async function jsTool(page: Page, code: string): Promise<JsToolResult> {
  var before = await takeEnrichedSnapshot(page);

  var consoleMessages: string[] = [];
  var errors: string[] = [];

  var normalizedCode = normalizeJsCode(code);
  errors.push(...validateCode(normalizedCode));

  var consoleHandler = (msg: ConsoleMessage) => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
  };

  page.on('console', consoleHandler);

  var result: unknown = null;

  try {
    if (!errors.length) {
      await ensureReactFormHelper(page);
      result = await page.evaluate(`(function(){
        var source = ${JSON.stringify(normalizedCode)};
        return (0, eval)(source);
      })()`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    page.off('console', consoleHandler);
  }

  await page.waitForTimeout(350);

  var after = await takeEnrichedSnapshot(page);
  var changes = diffSnapshots(before, after);

  return {
    result,
    changes,
    snapshot: after,
    consoleMessages,
    errors,
    executedCode: normalizedCode
  };
}
