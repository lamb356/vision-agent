/**
 * Code Extractor Module
 * 
 * Solves Problem 2: Phantom Code Extraction
 * Extracts 6-character codes while filtering out CSS values and false positives
 */

import { Page } from 'playwright';

export interface ExtractedCode {
  code: string;
  confidence: number;
  source: string;
  context: string;
}

export interface CodeExtractionConfig {
  minLength: number;
  maxLength: number;
  requireDigit: boolean;
  requireLetter: boolean;
  excludedUnits: string[];
  excludedPatterns: RegExp[];
}

export const DEFAULT_CONFIG: CodeExtractionConfig = {
  minLength: 6,
  maxLength: 6,
  requireDigit: true,
  requireLetter: true,
  excludedUnits: ['ms', 'px', 'pt', 'em', 'rem', 's', 'sec', '%', 'vh', 'vw', 'deg', 'ex', 'ch', 'cm', 'mm', 'in'],
  excludedPatterns: [
    /^#?[0-9a-fA-F]{6}$/,   // Hex colors
    /^[0-9]{6}$/,            // Numbers only
    /^rgb/,                  // RGB values
    /^hsl/,                  // HSL values
    /^[0-9]+\.[0-9]+/,       // Decimal numbers
    /^[0-9]+[a-zA-Z]{1,3}$/, // Number followed by unit
  ]
};

/**
 * Extract 6-character codes from page with intelligent filtering
 * to exclude CSS values and false positives
 */
export class CodeExtractor {
  private config: CodeExtractionConfig;

  constructor(config: Partial<CodeExtractionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Main extraction method - returns validated codes with confidence scores
   */
  async extractCodes(page: Page): Promise<ExtractedCode[]> {
    const candidates: ExtractedCode[] = [];

    // Method 1: Extract from visible text content only
    const textCodes = await this.extractFromVisibleText(page);
    candidates.push(...textCodes);

    // Method 2: Extract from specific data attributes
    const attrCodes = await this.extractFromDataAttributes(page);
    candidates.push(...attrCodes);

    // Method 3: Extract from meta tags
    const metaCodes = await this.extractFromMetaTags(page);
    candidates.push(...metaCodes);

    // Method 4: Extract from input placeholders and values
    const inputCodes = await this.extractFromInputs(page);
    candidates.push(...inputCodes);

    // Filter and rank results
    return this.filterAndRank(candidates);
  }

  /**
   * Extract codes from visible text only (excludes CSS in style attributes)
   */
  private async extractFromVisibleText(page: Page): Promise<ExtractedCode[]> {
    return page.evaluate((config) => {
      const results: ExtractedCode[] = [];
      const seen = new Set<string>();

      // Get all text nodes from visible elements (not style/script tags)
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            
            // Skip script, style, noscript tags
            const tagName = parent.tagName.toLowerCase();
            if (['script', 'style', 'noscript', 'template', 'iframe'].includes(tagName)) {
              return NodeFilter.FILTER_REJECT;
            }
            
            // Skip hidden elements
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return NodeFilter.FILTER_REJECT;
            }
            
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      const codeRegex = new RegExp(
        `\\b[a-zA-Z0-9]{${config.minLength},${config.maxLength}}\\b`, 
        'g'
      );

      let textNode: Text | null;
      while (textNode = walker.nextNode() as Text) {
        const text = textNode.textContent || '';
        const matches = text.match(codeRegex) || [];
        
        for (const match of matches) {
          if (!seen.has(match)) {
            seen.add(match);
            results.push({
              code: match,
              confidence: 0.7,
              source: 'visible_text',
              context: text.substring(0, 100)
            });
          }
        }
      }

      return results;
    }, this.config);
  }

  /**
   * Extract from data-* attributes commonly used for codes
   */
  private async extractFromDataAttributes(page: Page): Promise<ExtractedCode[]> {
    return page.evaluate((config) => {
      const results: ExtractedCode[] = [];
      const seen = new Set<string>();

      // Common attribute names that might contain codes
      const codeAttrs = [
        'data-code', 'data-token', 'data-key', 'data-id',
        'data-value', 'data-secret', 'data-answer', 'data-captcha',
        'data-validation', 'data-verify'
      ];

      const codeRegex = new RegExp(
        `^[a-zA-Z0-9]{${config.minLength},${config.maxLength}}$`
      );

      for (const attr of codeAttrs) {
        const elements = document.querySelectorAll(`[${attr}]`);
        elements.forEach(el => {
          const value = el.getAttribute(attr);
          if (value && codeRegex.test(value) && !seen.has(value)) {
            seen.add(value);
            results.push({
              code: value,
              confidence: 0.9, // Higher confidence for data attributes
              source: `attr:${attr}`,
              context: el.tagName
            });
          }
        });
      }

      return results;
    }, this.config);
  }

  /**
   * Extract from meta tags
   */
  private async extractFromMetaTags(page: Page): Promise<ExtractedCode[]> {
    return page.evaluate((config) => {
      const results: ExtractedCode[] = [];
      const codeRegex = new RegExp(
        `^[a-zA-Z0-9]{${config.minLength},${config.maxLength}}$`
      );

      const metaTags = document.querySelectorAll('meta');
      metaTags.forEach(meta => {
        const content = meta.getAttribute('content');
        if (content && codeRegex.test(content)) {
          results.push({
            code: content,
            confidence: 0.6,
            source: 'meta_tag',
            context: meta.getAttribute('name') || 'unknown'
          });
        }
      });

      return results;
    }, this.config);
  }

  /**
   * Extract from input placeholders and values
   */
  private async extractFromInputs(page: Page): Promise<ExtractedCode[]> {
    return page.evaluate((config) => {
      const results: ExtractedCode[] = [];
      const seen = new Set<string>();
      const codeRegex = new RegExp(
        `^[a-zA-Z0-9]{${config.minLength},${config.maxLength}}$`
      );

      const inputs = document.querySelectorAll('input, textarea');
      inputs.forEach(input => {
        // Check placeholder
        const placeholder = input.getAttribute('placeholder');
        if (placeholder) {
          const matches = placeholder.match(/[a-zA-Z0-9]{6}/g) || [];
          for (const match of matches) {
            if (codeRegex.test(match) && !seen.has(match)) {
              seen.add(match);
              results.push({
                code: match,
                confidence: 0.65,
                source: 'input_placeholder',
                context: 'placeholder'
              });
            }
          }
        }

        // Check value (for pre-filled codes)
        const value = (input as HTMLInputElement).value;
        if (value && codeRegex.test(value) && !seen.has(value)) {
          seen.add(value);
          results.push({
            code: value,
            confidence: 0.85,
            source: 'input_value',
            context: 'pre-filled'
          });
        }
      });

      return results;
    }, this.config);
  }

  /**
   * Filter out false positives and rank by confidence
   */
  private filterAndRank(candidates: ExtractedCode[]): ExtractedCode[] {
    const filtered: ExtractedCode[] = [];

    for (const candidate of candidates) {
      const code = candidate.code;

      // Check 1: Must contain at least one digit if required
      if (this.config.requireDigit && !/\d/.test(code)) {
        continue;
      }

      // Check 2: Must contain at least one letter if required
      if (this.config.requireLetter && !/[a-zA-Z]/.test(code)) {
        continue;
      }

      // Check 3: Exclude CSS units
      const lowerCode = code.toLowerCase();
      for (const unit of this.config.excludedUnits) {
        if (lowerCode.endsWith(unit)) {
          candidate.confidence -= 0.5;
          break;
        }
      }

      // Check 4: Exclude pattern matches
      for (const pattern of this.config.excludedPatterns) {
        if (pattern.test(code)) {
          candidate.confidence -= 0.7;
          break;
        }
      }

      // Check 5: Context validation - boost confidence for good contexts
      if (this.isGoodContext(candidate.context)) {
        candidate.confidence += 0.2;
      }

      // Check 6: Penalize suspicious contexts
      if (this.isSuspiciousContext(candidate.context)) {
        candidate.confidence -= 0.3;
      }

      // Only keep codes with positive confidence
      if (candidate.confidence > 0.5) {
        filtered.push(candidate);
      }
    }

    // Sort by confidence descending
    return filtered.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Check if the context suggests this is a real code
   */
  private isGoodContext(context: string): boolean {
    const goodIndicators = [
      'code', 'token', 'key', 'secret', 'verify', 'confirm',
      'enter', 'input', 'submit', 'validation', 'captcha',
      'auth', 'password', 'pin', 'verification'
    ];
    const lowerContext = context.toLowerCase();
    return goodIndicators.some(ind => lowerContext.includes(ind));
  }

  /**
   * Check if context suggests this is a false positive
   */
  private isSuspiciousContext(context: string): boolean {
    const suspiciousIndicators = [
      'duration', 'delay', 'timeout', 'interval', 'animation',
      'transition', 'width', 'height', 'margin', 'padding',
      'font-size', 'line-height', 'color', 'background'
    ];
    const lowerContext = context.toLowerCase();
    return suspiciousIndicators.some(ind => lowerContext.includes(ind));
  }

  /**
   * Validate a single code without extraction
   */
  validateCode(code: string): { valid: boolean; confidence: number; reason?: string } {
    // Must be exactly 6 chars
    if (code.length !== this.config.minLength || code.length !== this.config.maxLength) {
      return { valid: false, confidence: 0, reason: 'Length not 6' };
    }

    // Must contain at least 1 digit and 1 letter
    if (this.config.requireDigit && !/\d/.test(code)) {
      return { valid: false, confidence: 0, reason: 'Missing digit' };
    }
    if (this.config.requireLetter && !/[a-zA-Z]/.test(code)) {
      return { valid: false, confidence: 0, reason: 'Missing letter' };
    }

    let confidence = 0.7;

    // Check excluded units
    const lowerCode = code.toLowerCase();
    for (const unit of this.config.excludedUnits) {
      if (lowerCode.endsWith(unit)) {
        confidence -= 0.5;
        break;
      }
    }

    // Check excluded patterns
    for (const pattern of this.config.excludedPatterns) {
      if (pattern.test(code)) {
        confidence -= 0.7;
        break;
      }
    }

    return { valid: confidence > 0.5, confidence };
  }
}

export default CodeExtractor;
