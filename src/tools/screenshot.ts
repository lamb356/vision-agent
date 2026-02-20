import type { Page } from 'playwright';

export async function screenshotTool(page: Page, fullPage = false): Promise<string> {
  var buffer = await page.screenshot({ fullPage, type: 'png' });
  return buffer.toString('base64');
}