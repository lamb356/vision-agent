import type { Page } from 'playwright';

import {
  EnrichedSnapshot,
  HandlerInfo,
  InteractiveElement
} from './types.js';

const MAX_HANDLER_SOURCE = 120;
const MAX_VISIBLE_TEXT = 1500;
const MAX_ARIA_TREE = 3000;
const MAX_INTERACTIVE_ELEMENTS = 50;
const MAX_CDP_LISTENER_ELEMENTS = 120;

type RawInteractiveElement = Omit<InteractiveElement, 'handlers'> & {
  snapId: string;
  handlers: HandlerInfo[];
};

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)} ...[truncated ${text.length - maxLength} chars]`;
}

function normalizeHandlerSource(source: string): string {
  var compact = source.replace(/\s+/g, ' ').trim();
  return truncateText(compact, MAX_HANDLER_SOURCE);
}

function hasCodeLikeText(text: string): boolean {
  return /\b[A-Z0-9]{6}\b/i.test(text);
}

function escapeSelectorLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function uniqueHandlers(handlers: HandlerInfo[]): HandlerInfo[] {
  var seen = new Set<string>();
  var deduped: HandlerInfo[] = [];

  for (var handler of handlers) {
    var key = `${handler.listenerType}:${handler.event}:${handler.source}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(handler);
  }

  return deduped;
}

function formatAccessibilityNode(node: unknown, depth = 0): string[] {
  if (!node || typeof node !== 'object') {
    return [];
  }

  var asRecord = node as Record<string, unknown>;
  var role = typeof asRecord.role === 'string' ? asRecord.role : 'unknown';
  var name = typeof asRecord.name === 'string' ? asRecord.name : '';
  var value = typeof asRecord.value === 'string' ? asRecord.value : '';
  var description = typeof asRecord.description === 'string' ? asRecord.description : '';
  var disabled = typeof asRecord.disabled === 'boolean' ? asRecord.disabled : false;

  var prefix = '  '.repeat(depth);
  var suffixParts: string[] = [];

  if (value) {
    suffixParts.push(`value="${value}"`);
  }
  if (description) {
    suffixParts.push(`description="${description}"`);
  }
  if (disabled) {
    suffixParts.push('disabled');
  }

  var suffix = suffixParts.length ? ` (${suffixParts.join(', ')})` : '';
  var line = `${prefix}[${role}${name ? ` "${name}"` : ''}]${suffix}`;

  var lines = [line];
  var children = Array.isArray(asRecord.children) ? asRecord.children : [];
  for (var child of children) {
    lines.push(...formatAccessibilityNode(child, depth + 1));
  }

  return lines;
}

function scoreElement(element: InteractiveElement): number {
  var score = 0;

  if (element.visible) {
    score += 40;
  }
  if (element.enabled) {
    score += 12;
  }

  score += Math.min(element.handlers.length, 4) * 12;
  score += Math.max(Math.min(element.styles.zIndex, 5000), 0) / 200;

  if (element.styles.pointerEvents !== 'none') {
    score += 8;
  }

  if (element.role === 'button' || element.role === 'link') {
    score += 8;
  }

  if (element.role === 'textbox' || element.role === 'input') {
    score += 6;
  }

  if (element.name.length > 0) {
    score += 3;
  }

  return score;
}

async function collectDomInteractiveElements(page: Page): Promise<{
  url: string;
  title: string;
  visibleText: string;
  elements: RawInteractiveElement[];
}> {
  var result = (await page.evaluate(`(function(){
    var maxCandidates = 140;
    var inlineEvents = ['click', 'submit', 'change', 'input', 'keydown', 'keyup', 'mousedown', 'mouseup', 'dragstart', 'dragover', 'drop', 'touchstart', 'touchend'];

    function truncate(input, max) {
      if (!input) {
        return '';
      }
      var compact = String(input).replace(/\\s+/g, ' ').trim();
      if (compact.length <= max) {
        return compact;
      }
      return compact.slice(0, max) + ' ...[truncated ' + (compact.length - max) + ' chars]';
    }

    function parseZIndex(value) {
      if (!value || value === 'auto') {
        return 0;
      }
      var parsed = parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function roleFromTag(tagName) {
      if (tagName === 'button') return 'button';
      if (tagName === 'a') return 'link';
      if (tagName === 'input') return 'input';
      if (tagName === 'textarea') return 'textbox';
      if (tagName === 'select') return 'combobox';
      if (tagName === 'option') return 'option';
      if (tagName === 'summary') return 'button';
      if (tagName === 'form') return 'form';
      return tagName;
    }

    function cssEscapeValue(value) {
      if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
      }
      return String(value).replace(/[^a-zA-Z0-9_-]/g, '');
    }

    function cssPath(el) {
      if (el && el.id) {
        return '#' + cssEscapeValue(el.id);
      }

      var path = [];
      var node = el;
      while (node && path.length < 5 && node.nodeType === Node.ELEMENT_NODE) {
        var tag = node.tagName.toLowerCase();
        var segment = tag;
        var htmlNode = node;

        if (htmlNode.id) {
          segment = tag + '#' + String(htmlNode.id).replace(/\\s+/g, '-');
          path.unshift(segment);
          break;
        }

        var className = typeof htmlNode.className === 'string' ? htmlNode.className.trim() : '';
        if (className) {
          var firstClass = className.split(/\\s+/)[0];
          if (firstClass) {
            segment += '.' + firstClass.replace(/[^a-zA-Z0-9_-]/g, '');
          }
        }

        var parent = node.parentElement;
        if (parent) {
          var siblings = Array.prototype.filter.call(parent.children, function(child) {
            return child.tagName === node.tagName;
          });
          if (siblings.length > 1) {
            var idx = siblings.indexOf(node) + 1;
            segment += ':nth-of-type(' + idx + ')';
          }
        }

        path.unshift(segment);
        node = parent;
      }

      return path.join(' > ');
    }

    function getLabelText(el) {
      var ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) {
        return ariaLabel.trim();
      }

      var labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        var labelParts = labelledBy
          .split(/\\s+/)
          .map(function(id) {
            var n = document.getElementById(id);
            return n && n.textContent ? n.textContent.trim() : '';
          })
          .filter(Boolean);
        if (labelParts.length) {
          return labelParts.join(' ');
        }
      }

      var tag = el.tagName.toLowerCase();
      var inputType = tag === 'input' ? (el.getAttribute('type') || '').toLowerCase() : '';

      function lookupAssociatedLabel(inputEl) {
        var closestLabel = inputEl.closest ? inputEl.closest('label') : null;
        if (closestLabel && closestLabel.innerText) {
          var closestText = closestLabel.innerText.trim();
          if (closestText) {
            return closestText;
          }
        }

        var inputId = inputEl.id || '';
        if (inputId) {
          var linkedLabel = document.querySelector('label[for="' + inputId + '"]');
          if (linkedLabel && linkedLabel.innerText) {
            var linkedText = linkedLabel.innerText.trim();
            if (linkedText) {
              return linkedText;
            }
          }
        }

        return '';
      }

      if (tag === 'input' && (inputType === 'radio' || inputType === 'checkbox')) {
        var labelText = lookupAssociatedLabel(el);
        var checkedState = !!el.checked;
        var inputName = (el.getAttribute('name') || '').trim();
        var inputValue = (el.getAttribute('value') || '').trim();
        var typeLabel = inputType || 'input';
        var parts = [];
        parts.push(typeLabel);
        parts.push('label="' + (labelText || '(unlabeled)') + '"');
        parts.push('checked=' + String(checkedState));
        if (inputName) {
          parts.push('name="' + inputName + '"');
        }
        if (inputValue) {
          parts.push('value="' + inputValue + '"');
        }
        return parts.join(' ');
      }

      if (tag === 'input') {
        if (el.value) {
          return String(el.value).trim();
        }
        if (el.placeholder) {
          return String(el.placeholder).trim();
        }
      }

      if (tag === 'img' && el.alt) {
        return String(el.alt).trim();
      }

      var title = el.getAttribute('title');
      if (title && title.trim()) {
        return title.trim();
      }

      var text = (el.innerText || el.textContent || '').trim();
      if (text) {
        return text.slice(0, 180);
      }
      return '';
    }

    function isVisible(style, rect) {
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      if (parseFloat(style.opacity || '1') <= 0.01) {
        return false;
      }
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      return true;
    }

    function getInlineHandlers(el) {
      var handlers = [];
      for (var i = 0; i < inlineEvents.length; i += 1) {
        var eventName = inlineEvents[i];
        var attrName = 'on' + eventName;
        var attrValue = el.getAttribute(attrName);
        if (attrValue && attrValue.trim()) {
          handlers.push({ event: eventName, source: truncate(attrValue, 120), listenerType: 'attribute' });
        }
        var prop = el[attrName];
        if (typeof prop === 'function') {
          handlers.push({ event: eventName, source: truncate(prop.toString(), 120), listenerType: 'attribute' });
        }
      }
      return handlers;
    }

    function getReactHandlers(el) {
      var key = Object.keys(el).find(function(k) {
        return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactProps$') === 0 || k.indexOf('__reactInternalInstance$') === 0;
      });
      if (!key) {
        return { handlers: [] };
      }

      var handlers = [];
      var frameworkProps = { reactFiberKey: key };
      var current = el[key];
      var guard = 0;

      while (current && guard < 30) {
        guard += 1;
        var memoizedProps = current.memoizedProps;
        if (memoizedProps) {
          Object.entries(memoizedProps).forEach(function(entry) {
            var propKey = entry[0];
            var propValue = entry[1];
            if (propKey.indexOf('on') === 0 && typeof propValue === 'function') {
              handlers.push({
                event: propKey.slice(2).toLowerCase(),
                source: truncate(propValue.toString(), 120),
                listenerType: 'react'
              });
            }
          });
          frameworkProps.reactPropKeys = Object.keys(memoizedProps).filter(function(k) { return k.indexOf('on') === 0; }).slice(0, 20);
          break;
        }
        current = current.return;
      }

      return { handlers: handlers, frameworkProps: frameworkProps };
    }

    function getVueHandlers(el) {
      var vue = el.__vue__ || el.__vueParentComponent;
      if (!vue) {
        return { handlers: [] };
      }

      var handlers = [];
      var frameworkProps = { vue: true };
      var listeners = vue.$listeners || vue.props;
      if (listeners) {
        Object.entries(listeners).forEach(function(entry) {
          var name = entry[0];
          var value = entry[1];
          if (typeof value === 'function') {
            handlers.push({
              event: name.replace(/^on/i, '').toLowerCase(),
              source: truncate(value.toString(), 120),
              listenerType: 'vue'
            });
          }
        });
        frameworkProps.vueListenerKeys = Object.keys(listeners).slice(0, 20);
      }

      var vnodeProps = vue.vnode && vue.vnode.props ? vue.vnode.props : null;
      if (vnodeProps) {
        Object.entries(vnodeProps).forEach(function(entry) {
          var name = entry[0];
          var value = entry[1];
          if (typeof value === 'function' && /^on[A-Z]/.test(name)) {
            handlers.push({
              event: name.replace(/^on/, '').toLowerCase(),
              source: truncate(value.toString(), 120),
              listenerType: 'vue'
            });
          }
        });
      }

      return { handlers: handlers, frameworkProps: frameworkProps };
    }

    function getJQueryHandlers(el) {
      var jq = window.jQuery || window.$;
      if (!jq || typeof jq._data !== 'function') {
        return { handlers: [] };
      }

      var handlers = [];
      var frameworkProps = { jquery: true };
      var events = jq._data(el, 'events');
      if (!events) {
        return { handlers: handlers, frameworkProps: frameworkProps };
      }

      Object.entries(events).forEach(function(entry) {
        var eventName = entry[0];
        var eventValue = entry[1];
        if (!Array.isArray(eventValue)) {
          return;
        }
        eventValue.forEach(function(item) {
          var handler = item && item.handler;
          if (typeof handler === 'function') {
            handlers.push({
              event: eventName,
              source: truncate(handler.toString(), 120),
              listenerType: 'jquery'
            });
          }
        });
      });

      frameworkProps.jqueryEventKeys = Object.keys(events).slice(0, 20);
      return { handlers: handlers, frameworkProps: frameworkProps };
    }

    function hasInlineAttribute(el) {
      for (var i = 0; i < inlineEvents.length; i += 1) {
        if (el.hasAttribute('on' + inlineEvents[i])) {
          return true;
        }
      }
      return false;
    }

    document.querySelectorAll('[data-codex-snap-id]').forEach(function(node) {
      node.removeAttribute('data-codex-snap-id');
    });

    var candidates = [];
    var seen = new Set();
    var all = Array.prototype.slice.call(document.querySelectorAll('*'));

    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      if (seen.has(el)) {
        continue;
      }

      var style = getComputedStyle(el);
      var tag = el.tagName.toLowerCase();
      var roleAttr = el.getAttribute('role') || '';
      var tabIndex = el.tabIndex;
      var zIndex = parseZIndex(style.zIndex || '0');
      var rect = el.getBoundingClientRect();

      var isNativeInteractive =
        tag === 'button' ||
        tag === 'a' ||
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        tag === 'summary' ||
        tag === 'option' ||
        tag === 'details' ||
        Boolean(el.isContentEditable);

      var hasInteractionHints =
        hasInlineAttribute(el) ||
        style.cursor === 'pointer' ||
        el.hasAttribute('draggable') ||
        tabIndex >= 0 ||
        Boolean(roleAttr) ||
        el.hasAttribute('data-action') ||
        el.hasAttribute('data-testid') ||
        el.hasAttribute('aria-controls');

      var isOverlayCandidate =
        (style.position === 'fixed' || style.position === 'absolute' || style.position === 'sticky') &&
        zIndex >= 900 &&
        rect.width >= 80 &&
        rect.height >= 30;

      if (!(isNativeInteractive || hasInteractionHints || isOverlayCandidate)) {
        continue;
      }

      seen.add(el);
      candidates.push(el);
      if (candidates.length >= maxCandidates) {
        break;
      }
    }

    var interactiveElements = candidates.map(function(el, idx) {
      var style = getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      var roleAttr = el.getAttribute('role');
      var role = roleAttr ? roleAttr.toLowerCase() : roleFromTag(el.tagName.toLowerCase());
      var name = getLabelText(el);
      var enabled = !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true';
      var visible = isVisible(style, rect);
      var snapId = 'codex-' + (idx + 1);
      el.setAttribute('data-codex-snap-id', snapId);

      var inlineHandlers = getInlineHandlers(el);
      var reactData = getReactHandlers(el);
      var vueData = getVueHandlers(el);
      var jqueryData = getJQueryHandlers(el);
      var handlers = inlineHandlers.concat(reactData.handlers, vueData.handlers, jqueryData.handlers);
      var frameworkProps = Object.assign({}, reactData.frameworkProps || {}, vueData.frameworkProps || {}, jqueryData.frameworkProps || {});

      var boundingBox =
        Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height)
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null;

      return {
        snapId: snapId,
        role: role,
        name: name,
        selector: cssPath(el),
        visible: visible,
        enabled: enabled,
        boundingBox: boundingBox,
        handlers: handlers,
        frameworkProps: Object.keys(frameworkProps).length ? frameworkProps : undefined,
        styles: {
          zIndex: parseZIndex(style.zIndex || '0'),
          opacity: parseFloat(style.opacity || '1') || 0,
          pointerEvents: style.pointerEvents,
          position: style.position,
          display: style.display,
          visibility: style.visibility,
          overflow: style.overflow
        }
      };
    });

    var visibleText = truncate((document.body && document.body.innerText) || '', 1500);

    return {
      url: window.location.href,
      title: document.title,
      visibleText: visibleText,
      elements: interactiveElements
    };
  })()`)) as {
    url: string;
    title: string;
    visibleText: string;
    elements: RawInteractiveElement[];
  };

  return result;
}

async function enrichWithCdpListeners(
  page: Page,
  elements: RawInteractiveElement[]
): Promise<RawInteractiveElement[]> {
  var cdp = await page.context().newCDPSession(page);
  var objectGroup = `codex-snapshot-${Date.now()}`;

  try {
    var limitedElements = elements.slice(0, MAX_CDP_LISTENER_ELEMENTS);

    for (var element of limitedElements) {
      var selector = `[data-codex-snap-id="${escapeSelectorLiteral(element.snapId)}"]`;
      var expression = `document.querySelector("${selector}")`;

      var evalResult = await cdp.send('Runtime.evaluate', {
        expression,
        objectGroup,
        includeCommandLineAPI: true,
        returnByValue: false
      });

      var objectId = evalResult?.result?.objectId as string | undefined;
      if (!objectId) {
        continue;
      }

      var listenersResponse;
      try {
        listenersResponse = await cdp.send('DOMDebugger.getEventListeners', {
          objectId
        });
      } catch {
        continue;
      }

      var listeners =
        ((listenersResponse?.listeners as unknown) as Array<Record<string, unknown>> | undefined) ?? [];
      for (var listener of listeners) {
        var event = typeof listener.type === 'string' ? listener.type : 'unknown';

        var source = '';
        var handlerObject = listener.handler as Record<string, unknown> | undefined;
        var handlerObjectId =
          (handlerObject?.objectId as string | undefined) ||
          ((listener.originalHandler as Record<string, unknown> | undefined)?.objectId as string | undefined);

        if (handlerObjectId) {
          try {
            var sourceResult = await cdp.send('Runtime.callFunctionOn', {
              objectId: handlerObjectId,
              functionDeclaration: 'function() { try { return this.toString(); } catch (e) { return ""; } }',
              returnByValue: true,
              silent: true
            });

            if (typeof sourceResult?.result?.value === 'string') {
              source = sourceResult.result.value;
            }
          } catch {
            // Best-effort source extraction.
          }
        }

        if (!source && typeof handlerObject?.description === 'string') {
          source = handlerObject.description;
        }

        if (!source) {
          var lineInfo =
            typeof listener.lineNumber === 'number' && typeof listener.columnNumber === 'number'
              ? `listener at ${listener.lineNumber}:${listener.columnNumber}`
              : 'listener source unavailable';
          source = lineInfo;
        }

        element.handlers.push({
          event,
          source: normalizeHandlerSource(source),
          listenerType: 'addEventListener'
        });
      }
    }
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {
      // Ignore cleanup failures.
    });

    await page
      .evaluate(`(function(){
        var nodes = document.querySelectorAll('[data-codex-snap-id]');
        nodes.forEach(function(node){
          node.removeAttribute('data-codex-snap-id');
        });
      })()`)
      .catch(() => {
        // Ignore cleanup failures.
      });

    await cdp.detach().catch(() => {
      // Ignore cleanup failures.
    });
  }

  for (var element of elements) {
    element.handlers = uniqueHandlers(
      element.handlers
        .map((handler) => ({
          event: handler.event,
          listenerType: handler.listenerType,
          source: normalizeHandlerSource(handler.source)
        }))
        .slice(0, 16)
    );
  }

  return elements;
}

export function formatInteractiveElementsForPrompt(elements: InteractiveElement[]): string {
  if (!elements.length) {
    return '(no interactive elements detected)';
  }

  return elements
    .map((element, index) => {
      var head = `${index + 1}. [${element.role || 'unknown'} "${element.name || ''}"] selector=${element.selector}`;
      var state = `visible=${element.visible} enabled=${element.enabled} z=${element.styles.zIndex} pe=${element.styles.pointerEvents}`;
      var box = element.boundingBox
        ? `box=(${Math.round(element.boundingBox.x)},${Math.round(element.boundingBox.y)},${Math.round(
            element.boundingBox.width
          )},${Math.round(element.boundingBox.height)})`
        : 'box=(none)';

      var handlers = element.handlers.length
        ? element.handlers
            .map((handler) => `${handler.event}/${handler.listenerType}: ${handler.source}`)
            .join(' | ')
        : '(no handlers found)';

      return `${head}\n   ${state} ${box}\n   handlers: ${handlers}`;
    })
    .join('\n');
}

export async function takeEnrichedSnapshot(page: Page): Promise<EnrichedSnapshot> {
  var domData = await collectDomInteractiveElements(page);
  var enrichedElements = await enrichWithCdpListeners(page, domData.elements);

  var interactiveElements: InteractiveElement[] = enrichedElements
    .map((element) => ({
      role: element.role,
      name: element.name,
      selector: element.selector,
      visible: element.visible,
      enabled: element.enabled,
      boundingBox: element.boundingBox,
      handlers: uniqueHandlers(element.handlers).slice(0, 8),
      frameworkProps: element.frameworkProps,
      styles: element.styles
    }))
    .filter((element) => element.visible || hasCodeLikeText(element.name))
    .sort((a, b) => {
      if (a.visible !== b.visible) {
        return a.visible ? -1 : 1;
      }

      if (a.styles.zIndex !== b.styles.zIndex) {
        return b.styles.zIndex - a.styles.zIndex;
      }

      return scoreElement(b) - scoreElement(a);
    })
    .slice(0, MAX_INTERACTIVE_ELEMENTS);

  var ariaTree = interactiveElements
    .map((element) => {
      var handlerText = element.handlers.length
        ? ` (${element.handlers
            .map((handler) => `${handler.event}/${handler.listenerType}: ${handler.source}`)
            .join(' | ')})`
        : '';
      var visibilityLabel = element.visible ? 'visible' : 'hidden';
      return `[${element.role} "${element.name}"${handlerText}] [${visibilityLabel}, z:${element.styles.zIndex}]`;
    })
    .join('\n');

  if (ariaTree.length > MAX_ARIA_TREE) {
    ariaTree = `${ariaTree.substring(0, MAX_ARIA_TREE)}\n... (truncated)`;
  }

  return {
    ariaTree,
    interactiveElements,
    url: domData.url,
    title: domData.title,
    visibleText: truncateText(domData.visibleText, MAX_VISIBLE_TEXT),
    timestamp: new Date().toISOString()
  };
}
