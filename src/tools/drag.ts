import type { Page } from 'playwright';

import { diffSnapshots } from '../differ.js';
import { takeEnrichedSnapshot } from '../snapshot.js';
import { DragToolResult } from '../types.js';

export async function dragTool(
  page: Page,
  sourceSelector: string,
  targetSelector: string
): Promise<DragToolResult> {
  var before = await takeEnrichedSnapshot(page);
  var errors: string[] = [];
  var result: unknown = null;

  try {
    var source = page.locator(sourceSelector).first();
    var target = page.locator(targetSelector).first();

    await source.waitFor({ state: 'visible', timeout: 5000 });
    await target.waitFor({ state: 'visible', timeout: 5000 });
    await source.dragTo(target, { timeout: 10000 });

    result = { ok: true, sourceSelector, targetSelector };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    result = { ok: false, sourceSelector, targetSelector };
  }

  await page.waitForTimeout(350);

  var after = await takeEnrichedSnapshot(page);
  var changes = diffSnapshots(before, after);

  return {
    sourceSelector,
    targetSelector,
    result,
    changes,
    snapshot: after,
    errors
  };
}
