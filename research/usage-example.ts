/**
 * Usage Example for Code Extractor and Decoy Detector
 * 
 * Demonstrates how to use both modules together to solve
 * Problem 2 (Phantom Code Extraction) and Problem 4 (Decoy Button Identification)
 */

import { chromium, Browser, Page } from 'playwright';
import { CodeExtractor, ExtractedCode } from './code-extractor';
import { DecoyButtonDetector } from './decoy-detector';

interface ChallengeResult {
  success: boolean;
  code?: string;
  buttonClicked?: boolean;
  error?: string;
}

/**
 * Main challenge solver class
 */
export class ChallengeSolver {
  private codeExtractor: CodeExtractor;
  private buttonDetector: DecoyButtonDetector;

  constructor() {
    this.codeExtractor = new CodeExtractor({
      minLength: 6,
      maxLength: 6,
      requireDigit: true,
      requireLetter: true
    });

    this.buttonDetector = new DecoyButtonDetector();
  }

  /**
   * Solve the complete challenge
   */
  async solve(url: string): Promise<ChallengeResult> {
    const browser = await chromium.launch({ headless: false });
    
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle' });

      // Step 1: Extract and submit code
      const codeResult = await this.extractAndSubmitCode(page);
      if (!codeResult.success) {
        return codeResult;
      }

      // Step 2: Find and click the real button
      const buttonResult = await this.findAndClickButton(page);
      
      return {
        success: codeResult.success && buttonResult.success,
        code: codeResult.code,
        buttonClicked: buttonResult.clicked
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    } finally {
      await browser.close();
    }
  }

  /**
   * Extract code and submit it
   */
  private async extractAndSubmitCode(page: Page): Promise<{ success: boolean; code?: string }> {
    console.log('\n=== Extracting Codes ===');
    
    const codes = await this.codeExtractor.extractCodes(page);
    
    if (codes.length === 0) {
      console.log('No codes found!');
      return { success: false };
    }

    console.log(`Found ${codes.length} candidate codes:`);
    codes.slice(0, 5).forEach((c, i) => {
      console.log(`  ${i + 1}. "${c.code}" (confidence: ${c.confidence.toFixed(2)}, source: ${c.source})`);
    });

    // Use the highest confidence code
    const bestCode = codes[0];
    console.log(`\nUsing best code: "${bestCode.code}" (confidence: ${bestCode.confidence.toFixed(2)})`);

    // Find input field and submit code
    const inputSelector = 'input[type="text"], input[type="password"], input[name*="code"], input[placeholder*="code"]';
    const input = await page.$(inputSelector);

    if (input) {
      await input.fill(bestCode.code);
      console.log('Code entered into input field');
      
      // Look for submit button
      const submitButton = await page.$('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Verify")');
      if (submitButton) {
        await submitButton.click();
        console.log('Submitted code');
        await page.waitForTimeout(1000);
      }
    }

    return { success: true, code: bestCode.code };
  }

  /**
   * Find and click the real button
   */
  private async findAndClickButton(page: Page): Promise<{ success: boolean; clicked: boolean }> {
    console.log('\n=== Finding Real Button ===');

    // Check if page mentions scrolling
    const pageText = await page.evaluate(() => document.body.textContent || '');
    const mentionsScrolling = /scroll|scrolling|keep looking|find the button/i.test(pageText);

    let realButton;

    if (mentionsScrolling) {
      console.log('Page mentions scrolling - using scroll-to-find strategy');
      realButton = await this.buttonDetector.scrollToFindButton(page, 15);
    } else {
      realButton = await this.buttonDetector.findRealButton(page);
    }

    if (realButton) {
      const text = await realButton.evaluate(el => el.textContent?.trim() || '');
      console.log(`\nClicking button: "${text}"`);
      
      await realButton.scrollIntoViewIfNeeded();
      await realButton.click();
      
      console.log('Button clicked successfully!');
      return { success: true, clicked: true };
    }

    console.log('Could not identify real button');
    return { success: false, clicked: false };
  }
}

/**
 * Standalone code extraction function
 */
export async function extractCodesFromPage(page: Page): Promise<ExtractedCode[]> {
  const extractor = new CodeExtractor();
  return extractor.extractCodes(page);
}

/**
 * Standalone button finding function
 */
export async function findRealButtonOnPage(page: Page, scrollIfNeeded: boolean = false): Promise<boolean> {
  const detector = new DecoyButtonDetector();
  
  let button;
  if (scrollIfNeeded) {
    button = await detector.scrollToFindButton(page);
  } else {
    button = await detector.findRealButton(page);
  }

  if (button) {
    await button.click();
    return true;
  }
  
  return false;
}

// Example usage
async function main() {
  const solver = new ChallengeSolver();
  
  // Replace with actual challenge URL
  const result = await solver.solve('https://example-challenge.com');
  
  console.log('\n=== Result ===');
  console.log('Success:', result.success);
  console.log('Code:', result.code);
  console.log('Button clicked:', result.buttonClicked);
  
  if (result.error) {
    console.log('Error:', result.error);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export default ChallengeSolver;
