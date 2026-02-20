import { mkdir } from 'node:fs/promises';

import dotenv from 'dotenv';
import { chromium } from 'playwright';

import { runAgent } from './agent.js';

dotenv.config();

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }

  return /^(1|true|yes|y)$/i.test(value.trim());
}

async function main(): Promise<void> {
  console.log('=== Browser Automation Agent ===');

  await mkdir('./recordings', { recursive: true });

  var browser = await chromium.launch({
    headless: boolFromEnv(process.env.HEADLESS, true),
    args: ['--disable-web-security', '--no-sandbox']
  });

  var context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: './recordings' }
  });

  var page = await context.newPage();
  var startTime = Date.now();

  try {
    await runAgent(page, {
      challengeUrl: process.env.CHALLENGE_URL,
      maxSteps: 30,
      maxToolCalls: 150
    });
  } catch (error) {
    console.error('Agent error:', error);
  } finally {
    var elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Total time: ${elapsedSeconds}s`);

    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});