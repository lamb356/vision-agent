import type { Page } from 'playwright';

import { EnrichedSnapshot } from '../types.js';
import { takeEnrichedSnapshot } from '../snapshot.js';

export async function navigateTool(page: Page, url: string): Promise<EnrichedSnapshot> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    // Some challenge steps intentionally keep network busy.
  }

  await page.waitForTimeout(200);
  return takeEnrichedSnapshot(page);
}