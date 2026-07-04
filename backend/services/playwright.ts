import { chromium } from "playwright";
import type { BrowserResult, ReproductionPlan } from "./claude.js";

const STEP_SETTLE_MS = 1_000;

export async function runPlaywrightInvestigation(
  plan: ReproductionPlan,
): Promise<BrowserResult> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const consoleLogs: string[] = [];
  const failedNetworkResponses: BrowserResult["failedNetworkResponses"] = [];
  const apiResponses: BrowserResult["apiResponses"] = [];
  const screenshots: string[] = [];
  const errors: string[] = [];

  page.on("console", (message) => {
    consoleLogs.push(`[${message.type()}] ${message.text()}`);
  });

  page.on("response", (response) => {
    if (response.ok()) {
      return;
    }

    failedNetworkResponses.push({
      url: response.url(),
      status: response.status(),
      statusText: response.statusText(),
    });
  });

  try {
    for (const step of plan.steps) {
      try {
        switch (step.action) {
          case "goto":
            await page.goto(new URL(step.path, plan.baseUrl).toString(), {
              waitUntil: "domcontentloaded",
            });
            break;
          case "click":
            await page.click(step.selector);
            await waitForPageToSettle(page);
            break;
          case "fill":
            await page.fill(step.selector, step.value);
            break;
          case "waitForSelector":
            await page.waitForSelector(step.selector);
            break;
          case "screenshot": {
            const screenshot = await page.screenshot({
              fullPage: true,
              type: "png",
            });
            screenshots.push(screenshot.toString("base64"));
            break;
          }
          case "request": {
            const url = new URL(step.path, plan.baseUrl).toString();
            const response = await page.request.fetch(url, {
              method: step.method,
              data: step.body,
            });

            apiResponses.push({
              method: step.method,
              url,
              status: response.status(),
              statusText: response.statusText(),
              body: await response.text(),
            });
            break;
          }
        }
      } catch (error) {
        errors.push(formatStepError(step.action, error));
        break;
      }
    }

    await waitForPageToSettle(page);

    const html = await page.content().catch((error: unknown) => {
      errors.push(`Could not collect page HTML: ${formatError(error)}`);
      return "";
    });

    return {
      consoleLogs,
      failedNetworkResponses,
      apiResponses,
      html,
      screenshots,
      errors,
    };
  } finally {
    await browser.close();
  }
}

async function waitForPageToSettle(
  page: Awaited<
    ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>
  >,
) {
  await page
    .waitForLoadState("networkidle", { timeout: STEP_SETTLE_MS })
    .catch(async () => {
      await page.waitForTimeout(STEP_SETTLE_MS);
    });
}

function formatStepError(action: string, error: unknown) {
  return `Playwright ${action} failed: ${formatError(error)}`;
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
