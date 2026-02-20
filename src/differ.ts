import { EnrichedSnapshot, SnapshotDiff } from './types.js';

function elementKey(role: string, selector: string): string {
  return `${role}::${selector}`;
}

function elementLabel(role: string, name: string): string {
  return `[${role} "${name || ''}"]`;
}

export function diffSnapshots(before: EnrichedSnapshot, after: EnrichedSnapshot): SnapshotDiff {
  var beforeMap = new Map(
    before.interactiveElements.map((element) => [elementKey(element.role, element.selector), element])
  );
  var afterMap = new Map(
    after.interactiveElements.map((element) => [elementKey(element.role, element.selector), element])
  );

  var addedElements: string[] = [];
  var removedElements: string[] = [];
  var modifiedElements: string[] = [];
  var visibilityChanges: Array<{ selector: string; from: string; to: string }> = [];
  var textChanges: Array<{ selector: string; from: string; to: string }> = [];

  for (var [key, element] of afterMap.entries()) {
    if (!beforeMap.has(key)) {
      addedElements.push(`+ ${elementLabel(element.role, element.name)} appeared`);
    }
  }

  for (var [key, element] of beforeMap.entries()) {
    if (!afterMap.has(key)) {
      removedElements.push(`- ${elementLabel(element.role, element.name)} removed`);
    }
  }

  for (var [key, beforeElement] of beforeMap.entries()) {
    var afterElement = afterMap.get(key);
    if (!afterElement) {
      continue;
    }

    if (beforeElement.visible !== afterElement.visible) {
      visibilityChanges.push({
        selector: beforeElement.selector,
        from: String(beforeElement.visible),
        to: String(afterElement.visible)
      });
      modifiedElements.push(
        `~ ${elementLabel(beforeElement.role, beforeElement.name)} visibility ${beforeElement.visible} -> ${afterElement.visible}`
      );
    }

    if ((beforeElement.name || '') !== (afterElement.name || '')) {
      textChanges.push({
        selector: beforeElement.selector,
        from: beforeElement.name,
        to: afterElement.name
      });
      modifiedElements.push(
        `~ [${beforeElement.role}] text changed: "${beforeElement.name}" -> "${afterElement.name}"`
      );
    }

    if (beforeElement.enabled !== afterElement.enabled) {
      modifiedElements.push(
        `~ ${elementLabel(beforeElement.role, beforeElement.name)} enabled ${beforeElement.enabled} -> ${afterElement.enabled}`
      );
    }

    if (beforeElement.handlers.length !== afterElement.handlers.length) {
      modifiedElements.push(
        `~ ${elementLabel(beforeElement.role, beforeElement.name)} handlers ${beforeElement.handlers.length} -> ${afterElement.handlers.length}`
      );
    }

    if (
      beforeElement.styles.zIndex !== afterElement.styles.zIndex ||
      beforeElement.styles.pointerEvents !== afterElement.styles.pointerEvents ||
      beforeElement.styles.display !== afterElement.styles.display ||
      beforeElement.styles.visibility !== afterElement.styles.visibility
    ) {
      modifiedElements.push(
        `~ ${elementLabel(beforeElement.role, beforeElement.name)} style changed (z:${beforeElement.styles.zIndex}->${afterElement.styles.zIndex}, pe:${beforeElement.styles.pointerEvents}->${afterElement.styles.pointerEvents})`
      );
    }
  }

  var urlChanged = before.url !== after.url;
  var newUrl = urlChanged ? after.url : undefined;

  var summaryLines = ['CHANGES:'];

  if (!addedElements.length && !removedElements.length && !modifiedElements.length && !urlChanged) {
    summaryLines.push('(no material DOM changes detected)');
  } else {
    summaryLines.push(...addedElements);
    summaryLines.push(...removedElements);
    summaryLines.push(...modifiedElements.slice(0, 40));
    summaryLines.push(urlChanged ? `URL: changed -> ${after.url}` : 'URL: unchanged');
  }

  return {
    addedElements,
    removedElements,
    modifiedElements,
    urlChanged,
    newUrl,
    visibilityChanges,
    textChanges,
    summary: summaryLines.join('\n')
  };
}