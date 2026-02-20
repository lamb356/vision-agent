import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from 'playwright';

import { callGemini } from './gemini.js';
import { formatInteractiveElementsForPrompt } from './snapshot.js';
import {
  AdvisorRequest,
  AgentRunOptions,
  DragToolResult,
  EnrichedSnapshot,
  GeminiPart,
  GeminiMessage,
  HoverToolResult,
  JsToolResult,
  ParsedToolCall,
  SnapshotDiff
} from './types.js';
import { advisorTool } from './tools/advisor.js';
import { dragTool } from './tools/drag.js';
import { hoverTool } from './tools/hover.js';
import { jsTool } from './tools/js.js';
import { navigateTool } from './tools/navigate.js';
import { screenshotTool } from './tools/screenshot.js';

var agentPromptCache: string | null = null;

function nowLabel(): string {
  return new Date().toISOString();
}

function logAgent(message: string): void {
  console.log(`[${nowLabel()}] [agent] ${message}`);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function setCompletedStepsMonotonic(current: number, candidate: number, maxSteps: number): number {
  return Math.max(current, Math.min(maxSteps, candidate));
}

function normalizeJsPattern(code: string): string {
  return code.replace(/\s+/g, ' ').trim().slice(0, 320);
}

function hasTextPart(part: GeminiPart): part is { text: string } {
  return 'text' in part && typeof part.text === 'string';
}

function messageContainsPattern(message: GeminiMessage, pattern: string): boolean {
  for (var part of message.parts) {
    if (hasTextPart(part) && part.text.includes(pattern)) {
      return true;
    }
  }

  return false;
}

function removeMessagesWithBannedPattern(messages: GeminiMessage[], pattern: string): GeminiMessage[] {
  return messages.filter((message) => !messageContainsPattern(message, pattern));
}

function isNoOpChange(changes: SnapshotDiff): boolean {
  return (
    changes.addedElements.length === 0 && changes.removedElements.length === 0 && changes.modifiedElements.length === 0
  );
}

async function loadAgentPrompt(): Promise<string> {
  if (agentPromptCache) {
    return agentPromptCache;
  }

  var promptPath = path.join(process.cwd(), 'prompts', 'AGENT.md');
  agentPromptCache = await readFile(promptPath, 'utf8');
  return agentPromptCache;
}

function extractTag(text: string, tag: string): string | null {
  var regex = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i');
  var match = text.match(regex);
  return match?.[1]?.trim() ?? null;
}

function extractCodeFallback(text: string): string | null {
  var fenced = text.match(/```(?:javascript|js)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  var iife = text.match(/\(\(\)\s*=>[\s\S]*?\)\s*\(\s*\)\s*;?/);
  if (iife?.[0]) {
    return iife[0].trim();
  }

  return null;
}

function extractDragFallback(text: string): { sourceSelector: string; targetSelector: string } | null {
  var match = text.match(/drag\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]\s*\)/i);
  if (match?.[1] && match?.[2]) {
    return {
      sourceSelector: match[1].trim(),
      targetSelector: match[2].trim()
    };
  }

  return null;
}

function extractHoverFallback(text: string): { selector: string } | null {
  var match = text.match(/hover\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/i);
  if (match?.[1]) {
    return { selector: match[1].trim() };
  }

  return null;
}

export function parseToolCall(response: string): ParsedToolCall {
  var status = extractTag(response, 'status');
  if (status) {
    return { tool: 'status', status };
  }

  var tool = extractTag(response, 'tool')?.toLowerCase();
  if (!tool) {
    var fallbackDrag = extractDragFallback(response);
    if (fallbackDrag) {
      return { tool: 'drag', sourceSelector: fallbackDrag.sourceSelector, targetSelector: fallbackDrag.targetSelector };
    }

    var fallbackHover = extractHoverFallback(response);
    if (fallbackHover) {
      return { tool: 'hover', selector: fallbackHover.selector };
    }

    var fallbackCode = extractCodeFallback(response);
    if (fallbackCode) {
      return { tool: 'js', code: fallbackCode };
    }

    return { tool: 'none' };
  }

  if (tool === 'js') {
    var code = extractTag(response, 'code') ?? extractCodeFallback(response);
    return code ? { tool: 'js', code } : { tool: 'none' };
  }

  if (tool === 'screenshot') {
    var fullPageRaw = extractTag(response, 'fullPage');
    var fullPage = fullPageRaw ? /true|1|yes/i.test(fullPageRaw) : false;
    return { tool: 'screenshot', fullPage };
  }

  if (tool === 'drag') {
    var sourceSelector = extractTag(response, 'source') ?? extractTag(response, 'from');
    var targetSelector = extractTag(response, 'target') ?? extractTag(response, 'to');

    if (sourceSelector && targetSelector) {
      return { tool: 'drag', sourceSelector, targetSelector };
    }

    var parsed = extractDragFallback(response);
    if (parsed) {
      return { tool: 'drag', sourceSelector: parsed.sourceSelector, targetSelector: parsed.targetSelector };
    }

    return { tool: 'none' };
  }

  if (tool === 'hover') {
    var selector = extractTag(response, 'selector') ?? extractTag(response, 'target');
    if (selector) {
      return { tool: 'hover', selector };
    }

    var parsedHover = extractHoverFallback(response);
    if (parsedHover) {
      return { tool: 'hover', selector: parsedHover.selector };
    }

    return { tool: 'none' };
  }

  if (tool === 'advisor') {
    var prompt = extractTag(response, 'prompt') ?? extractTag(response, 'code');
    var sourceCode = extractTag(response, 'sourceCode') ?? undefined;
    return prompt ? { tool: 'advisor', prompt, sourceCode } : { tool: 'none' };
  }

  return { tool: 'none' };
}

function detectVisibleStep(snapshot: EnrichedSnapshot): number | null {
  var text = `${snapshot.title}\n${snapshot.visibleText}\n${snapshot.ariaTree}`;

  var stepMatches = Array.from(text.matchAll(/step\s*(\d{1,2})(?:\s*\/\s*(\d{1,2}))?/gi));
  var fractionMatches = Array.from(text.matchAll(/(\d{1,2})\s*\/\s*(\d{1,2})/g));

  var candidates: number[] = [];

  for (var match of stepMatches) {
    var stepNum = Number.parseInt(match[1] ?? '', 10);
    var totalNum = Number.parseInt(match[2] ?? '', 10);
    if (Number.isFinite(stepNum) && stepNum >= 1 && stepNum <= 30) {
      if (!Number.isFinite(totalNum) || totalNum <= 30) {
        candidates.push(stepNum);
      }
    }
  }

  for (var match of fractionMatches) {
    var a = Number.parseInt(match[1] ?? '', 10);
    var b = Number.parseInt(match[2] ?? '', 10);
    if (Number.isFinite(a) && Number.isFinite(b) && b === 30 && a >= 1 && a <= 30) {
      candidates.push(a);
    }
  }

  if (!candidates.length) {
    return null;
  }

  return Math.max(...candidates);
}

function detectVisibleStepFromPageText(snapshot: EnrichedSnapshot): number | null {
  var text = `${snapshot.title}\n${snapshot.visibleText}`;
  var stepOfMatches = Array.from(text.matchAll(/step\s*(\d{1,2})\s*of\s*30/gi));
  var fractionMatches = Array.from(text.matchAll(/\b(\d{1,2})\s*\/\s*30\b/g));

  var candidates: number[] = [];

  for (var match of stepOfMatches) {
    var stepNum = Number.parseInt(match[1] ?? '', 10);
    if (Number.isFinite(stepNum) && stepNum >= 1 && stepNum <= 30) {
      candidates.push(stepNum);
    }
  }

  for (var match of fractionMatches) {
    var fracNum = Number.parseInt(match[1] ?? '', 10);
    if (Number.isFinite(fracNum) && fracNum >= 1 && fracNum <= 30) {
      candidates.push(fracNum);
    }
  }

  if (!candidates.length) {
    return null;
  }

  return Math.max(...candidates);
}

async function isNotFoundPage(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      var title = String(document.title || '').toLowerCase();
      var bodyText = String(document.body?.innerText || '').trim().toLowerCase();
      return title.includes('404') || title.includes('page not found') || bodyText.startsWith('page not found');
    });
  } catch {
    return false;
  }
}

function hasActiveFormControls(snapshot: EnrichedSnapshot): boolean {
  for (var element of snapshot.interactiveElements) {
    if (!element.visible || !element.enabled) {
      continue;
    }

    var role = (element.role || '').toLowerCase();
    var name = (element.name || '').toLowerCase();
    var selector = (element.selector || '').toLowerCase();

    if (
      role === 'input' ||
      role === 'textbox' ||
      role === 'combobox' ||
      role === 'textarea' ||
      role === 'searchbox' ||
      selector.includes('input') ||
      selector.includes('textarea') ||
      selector.includes('select')
    ) {
      return true;
    }

    if (name.includes('submit') && (role === 'button' || role === 'input' || role.includes('button'))) {
      return true;
    }
  }

  return false;
}

function detectCompletion(
  snapshot: EnrichedSnapshot,
  context: {
    stepCounter: number;
    completedSteps: number;
    visibleStep: number | null;
  }
): boolean {
  if (context.stepCounter < 25) {
    return false;
  }

  var text = `${snapshot.title}\n${snapshot.visibleText}`;
  var hasCompletionText = /congratulations|challenge complete|30\s*\/\s*30|all steps completed/i.test(text);
  if (!hasCompletionText) {
    return false;
  }

  var visibleStep = context.visibleStep ?? detectVisibleStep(snapshot);
  if (!visibleStep || visibleStep < 30) {
    return false;
  }

  if (context.completedSteps < 25) {
    return false;
  }

  if (hasActiveFormControls(snapshot)) {
    return false;
  }

  return true;
}

function formatSnapshotForModel(
  snapshot: EnrichedSnapshot,
  context: {
    currentStep: number;
    completedSteps: number;
    maxSteps: number;
    toolCalls: number;
    maxToolCalls: number;
    elapsedSeconds: number;
    lastChangesSummary: string;
    navGuidance: string;
    priorityDirective: string | null;
  }
): string {
  var interactive = formatInteractiveElementsForPrompt(snapshot.interactiveElements);

  var lines: string[] = [`== STEP ${context.currentStep} ==`];

  if (context.priorityDirective) {
    lines.push('PRIORITY DIRECTIVE:');
    lines.push(context.priorityDirective);
    lines.push('');
  }

  lines.push('PAGE TEXT:');
  lines.push(truncate(snapshot.visibleText || '(none)', 1000));
  lines.push('');
  lines.push('STEP NAVIGATION:');
  lines.push(context.navGuidance);
  lines.push('');
  lines.push('INTERACTIVE ELEMENTS:');
  lines.push(truncate(interactive, 2600));
  lines.push('');
  lines.push('CHANGES SINCE LAST ACTION:');
  lines.push(truncate(context.lastChangesSummary || '(none)', 1200));
  lines.push('');
  lines.push(`STATE @ ${snapshot.timestamp}`);
  lines.push(`Progress: completed ${context.completedSteps}/${context.maxSteps}`);
  lines.push(`Tool budget: ${context.toolCalls}/${context.maxToolCalls}`);
  lines.push(`Elapsed seconds: ${context.elapsedSeconds}`);
  lines.push(`URL: ${snapshot.url}`);
  lines.push(`TITLE: ${snapshot.title}`);
  lines.push('');
  lines.push('ARIA TREE:');
  lines.push(truncate(snapshot.ariaTree || '(none)', 1500));

  var message = lines.join('\n');

  if (message.length > 5000) {
    return `${message.slice(0, 5000)}\n... (truncated)`;
  }

  return message;
}

function stringifyToolResult(result: JsToolResult): string {
  var safeResult: string;
  try {
    safeResult = JSON.stringify(result.result, null, 2) ?? 'undefined';
  } catch {
    safeResult = String(result.result);
  }

  var sections = [
    '<js_result>',
    `<result>${truncate(safeResult, 4000)}</result>`,
    `<changes>${truncate(result.changes.summary, 7000)}</changes>`,
    `<errors>${truncate(result.errors.join('\n') || '(none)', 2000)}</errors>`,
    `<console>${truncate(result.consoleMessages.join('\n') || '(none)', 2000)}</console>`,
    '</js_result>'
  ];

  return sections.join('\n');
}

function stringifyDragResult(result: DragToolResult): string {
  var safeResult: string;
  try {
    safeResult = JSON.stringify(result.result, null, 2) ?? 'undefined';
  } catch {
    safeResult = String(result.result);
  }

  return [
    '<drag_result>',
    `<source>${result.sourceSelector}</source>`,
    `<target>${result.targetSelector}</target>`,
    `<result>${truncate(safeResult, 1500)}</result>`,
    `<changes>${truncate(result.changes.summary, 5000)}</changes>`,
    `<errors>${truncate(result.errors.join('\n') || '(none)', 1500)}</errors>`,
    '</drag_result>'
  ].join('\n');
}

function stringifyHoverResult(result: HoverToolResult): string {
  var safeResult: string;
  try {
    safeResult = JSON.stringify(result.result, null, 2) ?? 'undefined';
  } catch {
    safeResult = String(result.result);
  }

  return [
    '<hover_result>',
    `<selector>${result.selector}</selector>`,
    `<result>${truncate(safeResult, 1500)}</result>`,
    `<changes>${truncate(result.changes.summary, 5000)}</changes>`,
    `<errors>${truncate(result.errors.join('\n') || '(none)', 1500)}</errors>`,
    '</hover_result>'
  ].join('\n');
}

function trimConversation(messages: GeminiMessage[], maxMessages = 24): GeminiMessage[] {
  if (messages.length <= maxMessages) {
    return messages;
  }

  return messages.slice(messages.length - maxMessages);
}

function defaultStartCode(): string {
  return [
    '(() => {',
    '  var candidates = Array.from(document.querySelectorAll("button, [role=\"button\"], [data-testid], [aria-label]"));',
    '  var startButton = candidates.find(function(el) {',
    '    var t = (el.textContent || el.getAttribute("aria-label") || "").toLowerCase();',
    '    return /start|begin|play|continue/.test(t);',
    '  });',
    '  if (startButton) { startButton.click(); return "clicked-start"; }',
    '  var firstButton = document.querySelector("button");',
    '  if (firstButton) { firstButton.click(); return "clicked-first-button"; }',
    '  return "no-start-button-found";',
    '})()'
  ].join('\n');
}

function forceAdvanceStepCode(targetStep: number): string {
  var safeTarget = Math.max(1, Math.min(30, Math.floor(targetStep)));
  return [
    '(() => {',
    `  var targetStep = ${safeTarget};`,
    "  var root = document.querySelector('#root') || document.body;",
    "  if (!root) { return 'Could not find step state'; }",
    '  var key = Object.keys(root).find(function(k) {',
    "    return k.indexOf('__reactContainer$') === 0 || k.indexOf('__reactFiber') === 0;",
    '  });',
    "  if (!key) { return 'Could not find step state'; }",
    '  var fiber = root[key];',
    '  var queue = [fiber];',
    '  while (queue.length) {',
    '    var node = queue.shift();',
    '    if (!node) { continue; }',
    '    var state = node.memoizedState;',
    '    while (state) {',
    "      if (typeof state.memoizedState === 'number' && state.memoizedState >= 1 && state.memoizedState <= 30) {",
    '        if (state.queue && state.queue.dispatch) {',
    '          state.queue.dispatch(targetStep);',
    "          return 'Attempted step advance to ' + targetStep + ' from detected state ' + state.memoizedState;",
    '        }',
    '      }',
    '      state = state.next;',
    '    }',
    '    if (node.child) { queue.push(node.child); }',
    '    if (node.sibling) { queue.push(node.sibling); }',
    '  }',
    "  return 'Could not find step state';",
    '})()'
  ].join('\n');
}

async function installHiddenDomHelper(page: Page): Promise<void> {
  try {
    await page.evaluate(`(function(){
      if (window.__solveHiddenDOM && window.__findHoverTargets) {
        return 'exists';
      }

      var CODE_EXACT = /^[A-Z0-9]{6}$/;
      var CODE_ANY = /\\b([A-Z0-9]{6})\\b/;

      function normalizeCandidate(value) {
        var cleaned = String(value || '').replace(/['"]/g, '').trim().toUpperCase();
        if (CODE_EXACT.test(cleaned)) {
          return cleaned;
        }
        return null;
      }

      function extractAnyCode(value) {
        var text = String(value || '').toUpperCase();
        var match = text.match(CODE_ANY);
        if (!match || !match[1]) {
          return null;
        }
        var normalized = normalizeCandidate(match[1]);
        return normalized;
      }

      function maybeDecodeBase64(value) {
        var text = String(value || '').trim();
        if (!text || text.length < 8 || text.length % 4 !== 0) {
          return null;
        }
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
          return null;
        }
        try {
          return atob(text);
        } catch (_) {
          return null;
        }
      }

      window.__solveHiddenDOM = function() {
        var pageText = String(document.body && document.body.innerText ? document.body.innerText : '');
        var hiddenDomContext = /hidden\\s*dom\\s*challenge/i.test(pageText);
        var candidates = Array.from(document.querySelectorAll('p, span, div, strong, em, a'));
        var clickTarget = candidates.find(function(el) {
          var t = (el.textContent || '').trim().toLowerCase();
          return t.indexOf('click here') === 0 && t.indexOf('more time') !== -1;
        });

        if (!clickTarget) {
          var fallbackCandidates = candidates
            .filter(function(el) {
              return (el.textContent || '').toLowerCase().indexOf('click here') !== -1;
            })
            .sort(function(a, b) {
              return (a.textContent || '').length - (b.textContent || '').length;
            });
          clickTarget = fallbackCandidates[0] || null;
        }

        if (hiddenDomContext && clickTarget) {
          var match = (clickTarget.textContent || '').match(/(\\d+)\\s*more\\s*time/i);
          var clicks = match ? parseInt(match[1], 10) + 2 : 10;
          if (!Number.isFinite(clicks) || clicks < 1) {
            clicks = 10;
          }
          for (var i = 0; i < clicks; i += 1) {
            clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        }

        var allEls = document.querySelectorAll('*');

        // 1) Scan data-* and ALL attributes on every element.
        for (var i = 0; i < allEls.length; i += 1) {
          var el = allEls[i];
          for (var j = 0; j < el.attributes.length; j += 1) {
            var attr = el.attributes[j];
            var value = (attr.value || '').trim();
            var attrCode = normalizeCandidate(value);
            if (attrCode) {
              return { code: attrCode, source: 'attr:' + attr.name, tag: el.tagName, attr: attr.name };
            }
          }
        }

        // 2) Scan CSS pseudo-element computed content.
        for (var i = 0; i < allEls.length; i += 1) {
          var el = allEls[i];
          var before = '';
          var after = '';
          try {
            before = window.getComputedStyle(el, '::before').content;
            after = window.getComputedStyle(el, '::after').content;
          } catch (_) {}
          var contents = [before, after];
          for (var k = 0; k < contents.length; k += 1) {
            var c = contents[k];
            if (!c || c === 'none' || c === 'normal') {
              continue;
            }
            var pseudoCode = normalizeCandidate(c);
            if (pseudoCode) {
              return { code: pseudoCode, source: k === 0 ? 'css-::before' : 'css-::after' };
            }
          }
        }

        // 3) Scan inline style properties.
        for (var i = 0; i < allEls.length; i += 1) {
          var inlineStyle = allEls[i].getAttribute('style') || '';
          var styleCode = extractAnyCode(inlineStyle);
          if (styleCode) {
            return { code: styleCode, source: 'inline-style' };
          }
        }

        // 4) Scan HTML comments.
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
        while (walker.nextNode()) {
          var nodeText = walker.currentNode && walker.currentNode.textContent ? walker.currentNode.textContent : '';
          var commentCode = extractAnyCode(nodeText);
          if (commentCode) {
            return { code: commentCode, source: 'comment' };
          }
        }

        // 5) Scan inline script contents.
        var scripts = document.querySelectorAll('script:not([src])');
        for (var i = 0; i < scripts.length; i += 1) {
          var scriptText = scripts[i].textContent || '';
          var quotedMatch = scriptText.match(/['"]([A-Z0-9]{6})['"]/);
          if (quotedMatch && quotedMatch[1] && CODE_EXACT.test(quotedMatch[1])) {
            return { code: quotedMatch[1], source: 'script-tag' };
          }
          var scriptCode = extractAnyCode(scriptText);
          if (scriptCode) {
            return { code: scriptCode, source: 'script-tag' };
          }
        }

        // 6) Scan meta tag content attributes.
        var metas = document.querySelectorAll('meta[content]');
        for (var i = 0; i < metas.length; i += 1) {
          var metaCode = extractAnyCode(metas[i].getAttribute('content') || '');
          if (metaCode) {
            return { code: metaCode, source: 'meta-content' };
          }
        }

        // 7) Try Base64-decoding attribute values.
        for (var i = 0; i < allEls.length; i += 1) {
          var el = allEls[i];
          for (var j = 0; j < el.attributes.length; j += 1) {
            var attr = el.attributes[j];
            var decoded = maybeDecodeBase64(attr.value || '');
            if (!decoded) {
              continue;
            }
            var decodedCode = extractAnyCode(decoded);
            if (decodedCode) {
              return { code: decodedCode, source: 'base64-attr:' + attr.name, tag: el.tagName, attr: attr.name };
            }
          }
        }

        // 8) Scan open shadow DOM roots.
        for (var i = 0; i < allEls.length; i += 1) {
          var host = allEls[i];
          if (!host.shadowRoot) {
            continue;
          }
          var shadowText = String(host.shadowRoot.innerHTML || '') + ' ' + String(host.shadowRoot.textContent || '');
          var shadowCode = extractAnyCode(shadowText);
          if (shadowCode) {
            return { code: shadowCode, source: 'shadow-dom', tag: host.tagName };
          }
        }

        // 9) Visible text scan as a final fallback.
        var visibleTextCode = extractAnyCode(pageText);
        if (visibleTextCode) {
          return { code: visibleTextCode, source: 'visible-text' };
        }

        return { code: null, source: 'not-found' };
      };

      window.__findHoverTargets = function() {
        var targets = [];
        var seen = {};

        function addTarget(selectorText, cssText) {
          if (!selectorText || selectorText.indexOf(':hover') === -1) {
            return;
          }
          var baseSelector = selectorText.replace(/:hover[\\s\\S]*$/, '').trim();
          if (!baseSelector) {
            baseSelector = selectorText.trim();
          }
          var key = selectorText + '|' + baseSelector;
          if (seen[key]) {
            return;
          }
          seen[key] = true;
          targets.push({
            hoverSelector: selectorText.trim(),
            baseSelector: baseSelector,
            cssProperties: (cssText || '').trim()
          });
        }

        function inspectRule(rule) {
          if (!rule) {
            return;
          }

          if (rule.selectorText && rule.selectorText.indexOf(':hover') !== -1) {
            var cssText = rule.style ? String(rule.style.cssText || '') : '';
            var lowered = cssText.toLowerCase();
            var relevant =
              lowered.indexOf('content') !== -1 ||
              lowered.indexOf('display') !== -1 ||
              lowered.indexOf('visibility') !== -1 ||
              lowered.indexOf('opacity') !== -1;

            if (relevant) {
              addTarget(rule.selectorText, cssText);
            }
          }

          var nested = rule.cssRules;
          if (nested && nested.length) {
            for (var i = 0; i < nested.length; i += 1) {
              inspectRule(nested[i]);
            }
          }
        }

        var sheets = document.styleSheets || [];
        for (var i = 0; i < sheets.length; i += 1) {
          var sheet = sheets[i];
          try {
            var rules = sheet.cssRules || [];
            for (var j = 0; j < rules.length; j += 1) {
              inspectRule(rules[j]);
            }
          } catch (_) {
            // Ignore cross-origin stylesheet access errors.
          }
        }

        return targets;
      };

      return 'installed';
    })()`);
  } catch (error) {
    logAgent(`Hidden DOM helper install failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runAgent(page: Page, options: AgentRunOptions = {}): Promise<void> {
  var baseChallengeUrl = 'https://serene-frangipane-7fd25b.netlify.app';
  var challengeUrl = options.challengeUrl ?? process.env.CHALLENGE_URL ?? baseChallengeUrl;
  var maxSteps = options.maxSteps ?? 30;
  var maxToolCalls = options.maxToolCalls ?? 150;

  var agentPrompt = await loadAgentPrompt();

  logAgent(`Navigating to ${challengeUrl}`);
  var snapshot = await navigateTool(page, challengeUrl);
  await installHiddenDomHelper(page);

  logAgent('Attempting to click START');
  var startResult = await jsTool(page, defaultStartCode());
  snapshot = startResult.snapshot;

  var messages: GeminiMessage[] = [];
  var toolCalls = 1;
  var startTime = Date.now();
  var hardSkipCallThreshold = 6;
  var stepTimeBudgetMs = 30_000;
  var lastChangesSummary = startResult.changes.summary;
  var stepToolCalls = 0;
  var stuckEscalationSent = false;
  var stuckCyclesOnStep = 0;
  var stuckCyclesStep: number | null = null;
  var consecutiveModelFailures = 0;
  var hardSkipFailCount = 0;
  var lastHardSkipStep = -1;
  var codeSubmittedThisStep = false;
  var noOpWindow: Array<{ tool: 'js' | 'drag' | 'hover'; jsPattern?: string }> = [];
  var bannedJsPatterns = new Set<string>();
  var pendingPriorityDirective: string | null = null;

  var visibleStep = detectVisibleStep(snapshot) ?? 1;
  var lastVisibleStep = visibleStep;
  var sessionCompletedSteps = Math.max(0, lastVisibleStep - 1);
  var completedSteps = sessionCompletedSteps;
  var stepStartVisibleStep = lastVisibleStep;
  var stepStartTimeMs = Date.now();
  var lastPreScannedStep: number | null = null;

  logAgent(`Initial visible step: ${lastVisibleStep}; completed estimate: ${sessionCompletedSteps}/${maxSteps}`);

  var appendPriorityDirective = (directive: string): void => {
    var trimmed = directive.trim();
    if (!trimmed) {
      return;
    }
    pendingPriorityDirective = pendingPriorityDirective
      ? `${pendingPriorityDirective}\n${trimmed}`
      : trimmed;
  };

  var maybeTriggerNoOpCircuitBreaker = async (): Promise<void> => {
    if (noOpWindow.length < 3) {
      return;
    }

    var directive = 'Your last 3 actions had zero DOM effect. Try a completely different approach.';
    var lastJsEntry = [...noOpWindow].reverse().find((entry) => typeof entry.jsPattern === 'string');
    if (lastJsEntry?.jsPattern) {
      bannedJsPatterns.add(lastJsEntry.jsPattern);
      messages = removeMessagesWithBannedPattern(messages, lastJsEntry.jsPattern);
      logAgent(`Banned repeated JS pattern due to no-op streak: ${truncate(lastJsEntry.jsPattern, 140)}`);
    }

    logAgent('No-op circuit breaker triggered after 3 consecutive zero-effect actions.');
    toolCalls += 1;
    stepToolCalls += 1;
    var breakerScreenshot = await screenshotTool(page, false);
    messages.push({
      role: 'user',
      parts: [
        { text: directive },
        {
          inlineData: {
            mimeType: 'image/png',
            data: breakerScreenshot
          }
        }
      ]
    });

    appendPriorityDirective(directive);
    lastChangesSummary = '(no-op circuit breaker screenshot captured)';
    noOpWindow = [];
  };

  var maybeRecoverFrom404 = async (): Promise<boolean> => {
    var notFound = await isNotFoundPage(page);
    if (!notFound) {
      return false;
    }

    logAgent('404 page detected. Recovering from base URL.');

    snapshot = await navigateTool(page, baseChallengeUrl);
    await installHiddenDomHelper(page);

    toolCalls += 1;
    stepToolCalls += 1;
    var restartResult = await jsTool(page, defaultStartCode());
    snapshot = restartResult.snapshot;
    lastChangesSummary = restartResult.changes.summary;
    await installHiddenDomHelper(page);
    lastVisibleStep = detectVisibleStep(snapshot) ?? 1;
    sessionCompletedSteps = 0;
    completedSteps = setCompletedStepsMonotonic(completedSteps, Math.max(0, lastVisibleStep - 1), maxSteps);

    stepToolCalls = 0;
    stuckEscalationSent = false;
    stuckCyclesOnStep = 0;
    stuckCyclesStep = null;
    hardSkipFailCount = 0;
    lastHardSkipStep = -1;
    codeSubmittedThisStep = false;
    noOpWindow = [];
    stepStartVisibleStep = lastVisibleStep;
    stepStartTimeMs = Date.now();
    lastPreScannedStep = null;
    appendPriorityDirective(
      'Controller recovered from a 404 page. Continue solving from the current visible step and do not use history navigation.'
    );

    messages.push({
      role: 'user',
      parts: [{ text: '<status>Recovered from 404, restarted from base URL.</status>' }]
    });

    logAgent('Recovered from 404, restarted from base URL');
    return true;
  };

  var runHiddenDomPreScan = async (stepNumber: number): Promise<void> => {
    try {
      var preScanResult = await page.evaluate(`(() => {
        if (!window.__solveHiddenDOM) {
          return { code: null, source: 'helper-missing' };
        }
        return window.__solveHiddenDOM();
      })()`);

      var resultObject =
        preScanResult && typeof preScanResult === 'object'
          ? (preScanResult as Record<string, unknown>)
          : ({ code: null, source: 'invalid-result' } as Record<string, unknown>);

      var preScanCode =
        typeof resultObject.code === 'string' && /^[A-Z0-9]{6}$/.test(resultObject.code)
          ? resultObject.code
          : null;
      var preScanSource = typeof resultObject.source === 'string' ? resultObject.source : 'unknown';

      if (preScanCode) {
        appendPriorityDirective(
          `Pre-scan result: __solveHiddenDOM() returned {code: '${preScanCode}', source: '${preScanSource}'}. You may submit this code or investigate further.`
        );
      } else {
        appendPriorityDirective(
          `Pre-scan result: __solveHiddenDOM() returned {code: null, source: '${preScanSource}'}. The code is not in standard DOM locations. Try other approaches.`
        );
      }
      logAgent(`Pre-scan completed for step ${stepNumber}: code=${preScanCode ?? 'null'} source=${preScanSource}`);
    } catch (error) {
      appendPriorityDirective(
        "Pre-scan result: __solveHiddenDOM() returned {code: null, source: 'pre-scan-error'}. The code is not in standard DOM locations. Try other approaches."
      );
      logAgent(`Pre-scan failed for step ${stepNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  var performHardSkip = async (cycleStep: number, reason: string): Promise<void> => {
    logAgent(reason);
    logAgent(`HARD SKIP from step ${cycleStep}`);

    if (cycleStep === lastHardSkipStep) {
      hardSkipFailCount += 1;
    } else {
      hardSkipFailCount = 1;
      lastHardSkipStep = cycleStep;
    }

    try {
      var hardSkipBaseStep = detectVisibleStepFromPageText(snapshot) ?? lastVisibleStep ?? cycleStep;
      var hardSkipTargetStep = Math.min(maxSteps, hardSkipBaseStep + 1);
      var hardSkipHandled = false;

      toolCalls += 1;
      stepToolCalls += 1;
      var forceAdvanceResult = await jsTool(page, forceAdvanceStepCode(hardSkipTargetStep));

      snapshot = forceAdvanceResult.snapshot;
      lastChangesSummary = forceAdvanceResult.changes.summary;

      var forceAdvanceText =
        typeof forceAdvanceResult.result === 'string'
          ? forceAdvanceResult.result
          : JSON.stringify(forceAdvanceResult.result ?? null);
      logAgent(`HARD SKIP tier1 result: ${truncate(forceAdvanceText, 220)}`);

      var forceObservedStep = detectVisibleStepFromPageText(snapshot);
      if (forceObservedStep && forceObservedStep > hardSkipBaseStep) {
        sessionCompletedSteps = setCompletedStepsMonotonic(sessionCompletedSteps, forceObservedStep - 1, maxSteps);
        completedSteps = setCompletedStepsMonotonic(completedSteps, sessionCompletedSteps, maxSteps);
        lastVisibleStep = forceObservedStep;
        hardSkipHandled = true;

        messages.push({
          role: 'user',
          parts: [{ text: `<status>HARD SKIP tier1 succeeded: ${truncate(forceAdvanceText, 140)}</status>` }]
        });
      }

      if (!hardSkipHandled) {
        toolCalls += 1;
        stepToolCalls += 1;
        var hardSkipNavResult = await jsTool(
          page,
          `(() => {
            var targets = ['Click Me!', 'Click Here!', 'Here!', 'Link!', 'Button!', 'Try This!'];
            var navButtons = Array.from(document.querySelectorAll('div')).filter(function(el) {
              var text = (el.textContent || '').trim();
              return targets.includes(text);
            });
            navButtons.sort(function(a, b) {
              var bz = parseInt(getComputedStyle(b).zIndex || '0', 10) || 0;
              var az = parseInt(getComputedStyle(a).zIndex || '0', 10) || 0;
              return bz - az;
            });
            if (navButtons.length > 0) {
              var chosen = navButtons[0];
              var chosenText = (chosen.textContent || '').trim();
              chosen.click();
              return 'Skipped via nav: ' + chosenText;
            }
            return 'No nav button found';
          })()`
        );

        snapshot = hardSkipNavResult.snapshot;
        lastChangesSummary = hardSkipNavResult.changes.summary;

        var navSkipText =
          typeof hardSkipNavResult.result === 'string'
            ? hardSkipNavResult.result
            : JSON.stringify(hardSkipNavResult.result ?? null);
        logAgent(`HARD SKIP tier2 result: ${truncate(navSkipText, 220)}`);

        var navObservedStep = detectVisibleStepFromPageText(snapshot);
        if (navObservedStep && navObservedStep > hardSkipBaseStep) {
          sessionCompletedSteps = setCompletedStepsMonotonic(sessionCompletedSteps, navObservedStep - 1, maxSteps);
          completedSteps = setCompletedStepsMonotonic(completedSteps, sessionCompletedSteps, maxSteps);
          lastVisibleStep = navObservedStep;
          hardSkipHandled = true;

          messages.push({
            role: 'user',
            parts: [{ text: `<status>HARD SKIP tier2 succeeded: ${truncate(navSkipText, 140)}</status>` }]
          });
        }
      }

      if (!hardSkipHandled) {
        logAgent('Hard skip failed, continuing.');
        messages.push({
          role: 'user',
          parts: [{ text: '<status>Hard skip failed, continuing with a different strategy.</status>' }]
        });

        if (hardSkipFailCount >= 2) {
          logAgent('Hard skip failed twice on same step. Force resetting.');

          snapshot = await navigateTool(page, baseChallengeUrl);
          await installHiddenDomHelper(page);

          toolCalls += 1;
          stepToolCalls += 1;
          var hardSkipResetResult = await jsTool(page, defaultStartCode());
          snapshot = hardSkipResetResult.snapshot;
          lastChangesSummary = hardSkipResetResult.changes.summary;
          await installHiddenDomHelper(page);

          sessionCompletedSteps = 0;
          lastVisibleStep = detectVisibleStep(snapshot) ?? 1;
          completedSteps = setCompletedStepsMonotonic(completedSteps, Math.max(0, lastVisibleStep - 1), maxSteps);

          messages.push({
            role: 'user',
            parts: [{ text: '<status>Hard skip failed twice on the same step. Forced reset applied.</status>' }]
          });
          hardSkipHandled = true;
        }
      }

      if (!hardSkipHandled && (await maybeRecoverFrom404())) {
        return;
      }

      if (hardSkipHandled) {
        hardSkipFailCount = 0;
        lastHardSkipStep = -1;
      }

      stepToolCalls = 0;
      stuckEscalationSent = false;
      stuckCyclesOnStep = 0;
      stuckCyclesStep = null;
      codeSubmittedThisStep = false;
      noOpWindow = [];
      stepStartVisibleStep = lastVisibleStep;
      stepStartTimeMs = Date.now();
      lastPreScannedStep = null;
    } catch (error) {
      logAgent(`HARD SKIP failed: ${error instanceof Error ? error.message : String(error)}`);
      stepToolCalls = 0;
      stuckEscalationSent = false;
      stuckCyclesOnStep = 0;
      stuckCyclesStep = null;
      codeSubmittedThisStep = false;
      stepStartVisibleStep = lastVisibleStep;
      stepStartTimeMs = Date.now();
      lastPreScannedStep = null;
    }
  };

  while (sessionCompletedSteps < maxSteps && toolCalls < maxToolCalls) {
    var elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    if (elapsedSeconds > 295) {
      logAgent('Stopping due to 5-minute time budget threshold.');
      break;
    }
    var currentStep = Math.max(1, lastVisibleStep);

    if (currentStep !== stepStartVisibleStep) {
      stepStartVisibleStep = currentStep;
      stepStartTimeMs = Date.now();
    }

    if (Date.now() - stepStartTimeMs > stepTimeBudgetMs) {
      await performHardSkip(currentStep, 'Step time budget exceeded (30s). Force skipping.');
      messages = trimConversation(messages);
      continue;
    }

    if (currentStep !== lastPreScannedStep) {
      await runHiddenDomPreScan(currentStep);
      lastPreScannedStep = currentStep;
    }

    var navGuidance = codeSubmittedThisStep
      ? 'Code was submitted. Click the highest z-index nav button to advance.'
      : 'Do NOT click floating nav buttons yet. Find and submit the code first.';
    var directiveForPrompt = pendingPriorityDirective;
    pendingPriorityDirective = null;

    var stateMessage = formatSnapshotForModel(snapshot, {
      currentStep,
      completedSteps: sessionCompletedSteps,
      maxSteps,
      toolCalls,
      maxToolCalls,
      elapsedSeconds,
      lastChangesSummary,
      navGuidance,
      priorityDirective: directiveForPrompt
    });

    messages.push({ role: 'user', parts: [{ text: stateMessage }] });

    var modelResponse = '';
    try {
      var isStuckBudget = stepToolCalls >= 4;
      modelResponse = await callGemini(messages, agentPrompt, process.env.GEMINI_MODEL, {
        temperature: 0.15,
        maxTokens: isStuckBudget ? 800 : 600,
        thinkingBudget: isStuckBudget ? 256 : 128
      });
      consecutiveModelFailures = 0;
    } catch (error) {
      consecutiveModelFailures += 1;
      var errorMessage = error instanceof Error ? error.message : String(error);
      logAgent(`Model call failed (${consecutiveModelFailures}/3): ${truncate(errorMessage, 220)}`);

      if (consecutiveModelFailures >= 3) {
        logAgent('Stopping after repeated model call failures.');
        break;
      }

      await page.waitForTimeout(1200 * consecutiveModelFailures);
      messages = trimConversation(messages);
      continue;
    }
    console.log(`[agent] Model response (truncated): ${modelResponse.substring(0, 500)}`);

    messages.push({ role: 'model', parts: [{ text: modelResponse }] });

    var toolCall = parseToolCall(modelResponse);
    logAgent(`Model selected tool: ${toolCall.tool}`);

    if (toolCall.tool === 'none') {
      messages.push({
        role: 'user',
        parts: [
          {
            text: 'Tool parse failed. Return a valid XML-tagged tool call using <tool> and matching tags like <code>, <source>/<target>, <selector>, or <prompt>.'
          }
        ]
      });
      messages = trimConversation(messages);
      continue;
    }

    if (toolCall.tool === 'status') {
      messages.push({ role: 'user', parts: [{ text: `Status noted: ${toolCall.status}` }] });
      messages = trimConversation(messages);
      continue;
    }

    var executedTool = false;

    if (toolCall.tool === 'js') {
      var proposedJsPattern = normalizeJsPattern(toolCall.code);
      if (bannedJsPatterns.has(proposedJsPattern)) {
        logAgent('Blocked execution of banned no-op JS pattern.');
        messages.pop();
        messages.push({
          role: 'user',
          parts: [{ text: 'The last JS pattern is banned due to repeated zero-effect actions. Use a completely different approach.' }]
        });
        appendPriorityDirective('Your previous code pattern is banned due to no-op repetition. Use a different strategy.');
        messages = trimConversation(messages);
        continue;
      }

      executedTool = true;
      toolCalls += 1;
      stepToolCalls += 1;
      console.log(`[agent] js() code: ${toolCall.code.substring(0, 300)}`);
      var jsResult = await jsTool(page, toolCall.code);
      snapshot = jsResult.snapshot;
      messages.push({ role: 'user', parts: [{ text: stringifyToolResult(jsResult) }] });
      console.log(`[agent] js() result: ${(JSON.stringify(jsResult.result) ?? 'undefined').substring(0, 200)}`);
      console.log(
        `[agent] js() changes: added=${jsResult.changes.addedElements.length} removed=${jsResult.changes.removedElements.length} modified=${jsResult.changes.modifiedElements.length}`
      );
      lastChangesSummary = jsResult.changes.summary;
      logAgent(`js() executed. Errors: ${jsResult.errors.length}.`);

      var jsResultText = '';
      try {
        jsResultText = JSON.stringify(jsResult.result ?? '').toLowerCase();
      } catch {
        jsResultText = String(jsResult.result ?? '').toLowerCase();
      }
      var hasSubmitWord = /submit|submitted/.test(jsResultText);
      var inputTextChanged = jsResult.changes.textChanges.some((change) =>
        /input|textarea|text|code/i.test(change.selector || '')
      );
      if (hasSubmitWord && (jsResult.changes.modifiedElements.length > 0 || inputTextChanged)) {
        codeSubmittedThisStep = true;
      }

      if (isNoOpChange(jsResult.changes)) {
        noOpWindow.push({ tool: 'js', jsPattern: proposedJsPattern });
        if (noOpWindow.length > 3) {
          noOpWindow.shift();
        }
        await maybeTriggerNoOpCircuitBreaker();
      } else {
        noOpWindow = [];
      }
    }

    if (toolCall.tool === 'drag') {
      executedTool = true;
      toolCalls += 1;
      stepToolCalls += 1;
      logAgent(`drag() source=${toolCall.sourceSelector} target=${toolCall.targetSelector}`);
      var dragResult = await dragTool(page, toolCall.sourceSelector, toolCall.targetSelector);
      snapshot = dragResult.snapshot;
      messages.push({ role: 'user', parts: [{ text: stringifyDragResult(dragResult) }] });
      console.log(
        `[agent] drag() changes: added=${dragResult.changes.addedElements.length} removed=${dragResult.changes.removedElements.length} modified=${dragResult.changes.modifiedElements.length}`
      );
      lastChangesSummary = dragResult.changes.summary;
      logAgent(`drag() executed. Errors: ${dragResult.errors.length}.`);

      if (isNoOpChange(dragResult.changes)) {
        noOpWindow.push({ tool: 'drag' });
        if (noOpWindow.length > 3) {
          noOpWindow.shift();
        }
        await maybeTriggerNoOpCircuitBreaker();
      } else {
        noOpWindow = [];
      }
    }

    if (toolCall.tool === 'hover') {
      executedTool = true;
      toolCalls += 1;
      stepToolCalls += 1;
      logAgent(`hover() selector=${toolCall.selector}`);
      var hoverResult = await hoverTool(page, toolCall.selector);
      snapshot = hoverResult.snapshot;
      messages.push({ role: 'user', parts: [{ text: stringifyHoverResult(hoverResult) }] });
      console.log(
        `[agent] hover() changes: added=${hoverResult.changes.addedElements.length} removed=${hoverResult.changes.removedElements.length} modified=${hoverResult.changes.modifiedElements.length}`
      );
      lastChangesSummary = hoverResult.changes.summary;
      logAgent(`hover() executed. Errors: ${hoverResult.errors.length}.`);

      if (isNoOpChange(hoverResult.changes)) {
        noOpWindow.push({ tool: 'hover' });
        if (noOpWindow.length > 3) {
          noOpWindow.shift();
        }
        await maybeTriggerNoOpCircuitBreaker();
      } else {
        noOpWindow = [];
      }
    }

    if (toolCall.tool === 'screenshot') {
      executedTool = true;
      toolCalls += 1;
      stepToolCalls += 1;
      var screenshotBase64 = await screenshotTool(page, toolCall.fullPage ?? false);
      messages.push({
        role: 'user',
        parts: [
          { text: '<screenshot>Attached. Analyze and choose the next tool call.</screenshot>' },
          {
            inlineData: {
              mimeType: 'image/png',
              data: screenshotBase64
            }
          }
        ]
      });
      lastChangesSummary = '(screenshot captured; no DOM diff available)';
      logAgent('screenshot() executed.');
    }

    if (toolCall.tool === 'advisor') {
      executedTool = true;
      toolCalls += 1;
      stepToolCalls += 1;
      var advisorRequest: AdvisorRequest = {
        prompt: toolCall.prompt,
        sourceCode: toolCall.sourceCode,
        snapshot: JSON.stringify(snapshot)
      };

      var advisorResult = await advisorTool(advisorRequest, snapshot, process.env.GEMINI_MODEL);
      messages.push({
        role: 'user',
        parts: [
          {
            text: [
              '<advisor_result>',
              `### 1. Source Analysis\n${advisorResult.analysis || '(none)'}`,
              `### 2. Code\n${advisorResult.suggestedCode || '(none)'}`,
              `### 3. Disclaimer\n${advisorResult.disclaimer || '(none)'}`,
              '</advisor_result>'
            ].join('\n')
          }
        ]
      });
      lastChangesSummary = '(advisor guidance returned; no DOM diff available)';
      logAgent('advisor() executed.');
    }

    if (executedTool) {
      var recoveredFrom404 = await maybeRecoverFrom404();
      if (recoveredFrom404) {
        messages = trimConversation(messages);
        continue;
      }
    }

    var observedStep = detectVisibleStep(snapshot);
    var advancedStepThisTurn = false;
    if (observedStep && observedStep > lastVisibleStep) {
      sessionCompletedSteps = setCompletedStepsMonotonic(sessionCompletedSteps, observedStep - 1, maxSteps);
      completedSteps = setCompletedStepsMonotonic(completedSteps, sessionCompletedSteps, maxSteps);
      lastVisibleStep = observedStep;
      advancedStepThisTurn = true;
      stepToolCalls = 0;
      stuckEscalationSent = false;
      stuckCyclesOnStep = 0;
      stuckCyclesStep = null;
      codeSubmittedThisStep = false;
      noOpWindow = [];
      pendingPriorityDirective = null;
      stepStartVisibleStep = observedStep;
      stepStartTimeMs = Date.now();
      lastPreScannedStep = null;
      logAgent(`Step advanced to visible step ${observedStep}. Completed estimate: ${sessionCompletedSteps}/${maxSteps}`);

      messages.push({
        role: 'user',
        parts: [{ text: `<status>Detected step advancement. Completed ${sessionCompletedSteps}/${maxSteps}.</status>` }]
      });

      if (messages.length > 4) {
        var summary = `Completed steps 1-${sessionCompletedSteps}. Now on step ${observedStep}.`;
        messages = messages.slice(messages.length - 4);
        messages.unshift({ role: 'user', parts: [{ text: summary }] });
      }
    }

    if (!advancedStepThisTurn && (!observedStep || observedStep <= lastVisibleStep)) {
      var effectiveHardSkipThreshold = codeSubmittedThisStep ? hardSkipCallThreshold + 2 : hardSkipCallThreshold;
      if (stepToolCalls >= effectiveHardSkipThreshold) {
        await performHardSkip(
          observedStep ?? currentStep,
          `STUCK on step ${currentStep} after ${stepToolCalls} calls (threshold ${effectiveHardSkipThreshold}). Triggering hard skip.`
        );
        messages = trimConversation(messages);
        continue;
      }

      if (stepToolCalls >= 8 && !stuckEscalationSent) {
        logAgent(`STUCK on step ${currentStep} after 8 calls. Taking screenshot and resetting approach.`);
        toolCalls += 1;
        stepToolCalls += 1;
        stuckEscalationSent = true;
        var stuckScreenshot = await screenshotTool(page, false);
        messages.push({
          role: 'user',
          parts: [
            {
              text: "You've been stuck on this step for 8 calls. Look at the screenshot carefully. Try a completely different approach. If you see overlays, dismiss them first. If you can see a code in the page text, submit it directly."
            },
            {
              inlineData: {
                mimeType: 'image/png',
                data: stuckScreenshot
              }
            }
          ]
        });
        lastChangesSummary = '(stuck escalation screenshot captured)';
      }

      if (stepToolCalls >= 12) {
        var cycleStep = observedStep ?? currentStep;
        if (stuckCyclesStep === cycleStep) {
          stuckCyclesOnStep += 1;
        } else {
          stuckCyclesStep = cycleStep;
          stuckCyclesOnStep = 1;
        }

        if (stuckCyclesOnStep >= 2) {
          logAgent(`HARD SKIP from step ${cycleStep}`);

          try {
            var hardSkipBaseStep = detectVisibleStepFromPageText(snapshot) ?? lastVisibleStep;
            var hardSkipTargetStep = Math.min(maxSteps, hardSkipBaseStep + 1);
            var hardSkipHandled = false;

            toolCalls += 1;
            var forceAdvanceResult = await jsTool(page, forceAdvanceStepCode(hardSkipTargetStep));

            snapshot = forceAdvanceResult.snapshot;
            lastChangesSummary = forceAdvanceResult.changes.summary;

            var forceAdvanceText =
              typeof forceAdvanceResult.result === 'string'
                ? forceAdvanceResult.result
                : JSON.stringify(forceAdvanceResult.result ?? null);
            logAgent(`HARD SKIP tier1 result: ${truncate(forceAdvanceText, 220)}`);

            var forceObservedStep = detectVisibleStepFromPageText(snapshot);
            if (forceObservedStep && forceObservedStep > hardSkipBaseStep) {
              sessionCompletedSteps = setCompletedStepsMonotonic(sessionCompletedSteps, forceObservedStep - 1, maxSteps);
              completedSteps = setCompletedStepsMonotonic(completedSteps, sessionCompletedSteps, maxSteps);
              lastVisibleStep = forceObservedStep;
              hardSkipHandled = true;

              messages.push({
                role: 'user',
                parts: [{ text: `<status>HARD SKIP tier1 succeeded: ${truncate(forceAdvanceText, 140)}</status>` }]
              });
            }

            if (!hardSkipHandled) {
              toolCalls += 1;
              var hardSkipNavResult = await jsTool(
                page,
                `(() => {
                  var targets = ['Click Me!', 'Click Here!', 'Here!', 'Link!', 'Button!', 'Try This!'];
                  var navButtons = Array.from(document.querySelectorAll('div')).filter(function(el) {
                    var text = (el.textContent || '').trim();
                    return targets.includes(text);
                  });
                  navButtons.sort(function(a, b) {
                    var bz = parseInt(getComputedStyle(b).zIndex || '0', 10) || 0;
                    var az = parseInt(getComputedStyle(a).zIndex || '0', 10) || 0;
                    return bz - az;
                  });
                  if (navButtons.length > 0) {
                    var chosen = navButtons[0];
                    var chosenText = (chosen.textContent || '').trim();
                    chosen.click();
                    return 'Skipped via nav: ' + chosenText;
                  }
                  return 'No nav button found';
                })()`
              );

              snapshot = hardSkipNavResult.snapshot;
              lastChangesSummary = hardSkipNavResult.changes.summary;

              var navSkipText =
                typeof hardSkipNavResult.result === 'string'
                  ? hardSkipNavResult.result
                  : JSON.stringify(hardSkipNavResult.result ?? null);
              logAgent(`HARD SKIP tier2 result: ${truncate(navSkipText, 220)}`);

              var navObservedStep = detectVisibleStepFromPageText(snapshot);
              if (navObservedStep && navObservedStep > hardSkipBaseStep) {
                sessionCompletedSteps = setCompletedStepsMonotonic(sessionCompletedSteps, navObservedStep - 1, maxSteps);
                completedSteps = setCompletedStepsMonotonic(completedSteps, sessionCompletedSteps, maxSteps);
                lastVisibleStep = navObservedStep;
                hardSkipHandled = true;

                messages.push({
                  role: 'user',
                  parts: [{ text: `<status>HARD SKIP tier2 succeeded: ${truncate(navSkipText, 140)}</status>` }]
                });
              }
            }

            if (!hardSkipHandled) {
              logAgent('HARD SKIP fallback: reloading page and retrying tier1.');
              await page
                .reload({ waitUntil: 'networkidle' })
                .catch(async () => {
                  await page.reload({ waitUntil: 'domcontentloaded' });
                });
              await page.waitForTimeout(1000);
              await installHiddenDomHelper(page);

              toolCalls += 1;
              var hardSkipRestart = await jsTool(page, defaultStartCode());
              snapshot = hardSkipRestart.snapshot;
              lastChangesSummary = hardSkipRestart.changes.summary;
              lastVisibleStep = detectVisibleStep(snapshot) ?? 1;
              sessionCompletedSteps = 0;
              completedSteps = setCompletedStepsMonotonic(completedSteps, Math.max(0, lastVisibleStep - 1), maxSteps);
              lastPreScannedStep = null;

              toolCalls += 1;
              var retryForceResult = await jsTool(page, forceAdvanceStepCode(hardSkipTargetStep));
              snapshot = retryForceResult.snapshot;
              lastChangesSummary = retryForceResult.changes.summary;

              var retryText =
                typeof retryForceResult.result === 'string'
                  ? retryForceResult.result
                  : JSON.stringify(retryForceResult.result ?? null);
              logAgent(`HARD SKIP retry tier1 result: ${truncate(retryText, 220)}`);

              var retryObservedStep = detectVisibleStepFromPageText(snapshot);
              if (retryObservedStep && retryObservedStep > hardSkipBaseStep) {
                sessionCompletedSteps = setCompletedStepsMonotonic(sessionCompletedSteps, retryObservedStep - 1, maxSteps);
                completedSteps = setCompletedStepsMonotonic(completedSteps, sessionCompletedSteps, maxSteps);
                lastVisibleStep = retryObservedStep;
                hardSkipHandled = true;

                messages.push({
                  role: 'user',
                  parts: [{ text: `<status>HARD SKIP retry succeeded: ${truncate(retryText, 140)}</status>` }]
                });
              }
            }

            if (!hardSkipHandled) {
              logAgent('Hard skip failed, continuing.');
              messages.push({
                role: 'user',
                parts: [{ text: '<status>Hard skip failed, continuing with a different strategy.</status>' }]
              });
            }

            if (await maybeRecoverFrom404()) {
              messages = trimConversation(messages);
              continue;
            }

            stepToolCalls = 0;
            stuckEscalationSent = false;
            stuckCyclesOnStep = 0;
            stuckCyclesStep = null;
            noOpWindow = [];
            lastPreScannedStep = null;
            continue;
          } catch (error) {
            logAgent(`HARD SKIP failed: ${error instanceof Error ? error.message : String(error)}`);
            stepToolCalls = 0;
            stuckEscalationSent = false;
            stuckCyclesOnStep = 0;
            stuckCyclesStep = null;
            lastPreScannedStep = null;
            continue;
          }
        }

        logAgent(`STUCK on step ${currentStep} after ${stepToolCalls} calls. Attempting recovery...`);

        toolCalls += 1;
        var recoveryResult = await jsTool(
          page,
          `(() => {
            var all = document.querySelectorAll('*');
            var hidden = 0;
            for (var i = 0; i < all.length; i += 1) {
              var el = all[i];
              var style = window.getComputedStyle(el);
              var z = parseInt(style.zIndex || '0', 10);
              if (style.position === 'fixed' && Number.isFinite(z) && z > 100) {
                el.style.display = 'none';
                hidden += 1;
              }
            }
            return { hiddenOverlays: hidden };
          })()`
        );

        snapshot = recoveryResult.snapshot;
        lastChangesSummary = recoveryResult.changes.summary;
        logAgent(`Recovery overlay sweep result: ${JSON.stringify(recoveryResult.result ?? null).slice(0, 200)}`);

        if (await maybeRecoverFrom404()) {
          messages = trimConversation(messages);
          continue;
        }

        var hasContent = snapshot.interactiveElements.length > 2;
        if (!hasContent) {
          logAgent('Page unrecoverable. Navigating to base URL.');
          snapshot = await navigateTool(page, baseChallengeUrl);
          await installHiddenDomHelper(page);
          var restartResult = await jsTool(page, defaultStartCode());
          snapshot = restartResult.snapshot;
          toolCalls += 1;
          lastChangesSummary = restartResult.changes.summary;
          lastVisibleStep = detectVisibleStep(snapshot) ?? 1;
          sessionCompletedSteps = 0;
          completedSteps = setCompletedStepsMonotonic(completedSteps, Math.max(0, lastVisibleStep - 1), maxSteps);
          stepStartVisibleStep = lastVisibleStep;
          stepStartTimeMs = Date.now();
          lastPreScannedStep = null;
          logAgent('Restarted from base URL after unrecoverable state.');
        } else {
          logAgent('Recovery succeeded. Continuing without full reset.');
        }

        stepToolCalls = 0;
        stuckEscalationSent = false;
        noOpWindow = [];
        lastPreScannedStep = null;
        messages.push({
          role: 'user',
          parts: [
            {
              text: '<status>Previous strategy was stuck. State recovery was applied. Re-read PAGE TEXT and choose a different approach.</status>'
            }
          ]
        });
      }
    }

    if (
      detectCompletion(snapshot, {
        stepCounter: currentStep,
        completedSteps: sessionCompletedSteps,
        visibleStep: observedStep
      })
    ) {
      sessionCompletedSteps = setCompletedStepsMonotonic(sessionCompletedSteps, maxSteps, maxSteps);
      completedSteps = setCompletedStepsMonotonic(completedSteps, maxSteps, maxSteps);
      logAgent('Completion marker detected on page.');
      break;
    }

    messages = trimConversation(messages);
  }

  var totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
  logAgent(`Final: ${completedSteps}/${maxSteps} estimated steps completed in ${totalSeconds}s with ${toolCalls} tool calls.`);
}
