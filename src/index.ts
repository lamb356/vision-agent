import "dotenv/config";
import { launchBrowser, closeBrowser, navigateTo } from "./browser.js";
import { detectModel } from "./gemini.js";
import { runAgent } from "./agent.js";
import type { AgentConfig } from "./types.js";

const DEFAULT_URL = "https://serene-frangipane-7fd25b.netlify.app";

function parseArgs(): { headed: boolean; url: string } {
  const args = process.argv.slice(2);
  return {
    headed: args.includes("--headed"),
    url: args.find((a) => a.startsWith("--url="))?.split("=")[1]
      ?? (args.indexOf("--url") !== -1 ? args[args.indexOf("--url") + 1] : undefined)
      ?? DEFAULT_URL,
  };
}

async function main() {
  const { headed, url } = parseArgs();

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === "your-api-key-here") {
    console.error("Error: Set GEMINI_API_KEY in .env file");
    process.exit(1);
  }

  console.log("=== Vision Browser Agent ===");
  console.log(`  URL: ${url}`);
  console.log(`  Mode: ${headed ? "headed" : "headless"}`);

  // Detect best available model
  console.log("\nDetecting Gemini model...");
  await detectModel(apiKey);

  const config: AgentConfig = {
    url,
    headed,
    apiKey,
    model: "", // set by detectModel
    modelVersion: "3x", // set by detectModel
  };

  console.log("\nLaunching browser...");
  const instance = await launchBrowser(headed);

  try {
    console.log(`Navigating to ${url}...`);
    await navigateTo(instance.page, url);

    const results = await runAgent(instance.page, config);

    // Summary
    const passed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success);

    if (failed.length > 0) {
      console.log("\nFailed steps:");
      for (const f of failed) {
        console.log(`  Step ${f.step}: ${f.error ?? "unknown"} (${f.attempts} attempts, ${f.elapsed_ms}ms)`);
      }
    }

    console.log(`\nFinal: ${passed}/30 steps completed`);
    process.exitCode = passed === 30 ? 0 : 1;
  } catch (err) {
    console.error("\nFatal error:", err);
    process.exitCode = 2;
  } finally {
    console.log("\nClosing browser (saving video)...");
    await closeBrowser(instance);
    console.log("Done. Check recordings/ for video.");
  }
}

main();
