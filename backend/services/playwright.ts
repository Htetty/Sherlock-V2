import { chromium, type Locator, type Page } from "playwright";
import type {
  BrowserResult,
  DomTargetIntent,
  IntentStep,
  ReproductionIntentPlan,
  ReproductionPlan,
  StepResult,
} from "./claude.js";

const STEP_SETTLE_MS = 1_000;
const ASSERT_TIMEOUT_MS = 5_000;
const ACTION_TIMEOUT_MS = 10_000;

// Executes an intent-level reproduction plan. Targets are resolved through
// Playwright's user-facing locators (role/label/testid/text), which run in
// strict mode: zero or multiple matches throw instead of guessing. That is
// the Part 1 stand-in for the browser action validator.
export async function runIntentInvestigation(
  plan: ReproductionIntentPlan,
): Promise<BrowserResult> {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const consoleLogs: string[] = [];
  const failedNetworkResponses: BrowserResult["failedNetworkResponses"] = [];
  const screenshots: string[] = [];
  const errors: string[] = [];
  const stepResults: StepResult[] = [];

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
    for (const [index, step] of plan.steps.entries()) {
      try {
        await runIntentStep(page, plan.baseUrl, step);

        if (step.action === "click") {
          await waitForPageToSettle(page);
        }

        stepResults.push({ index, action: step.action, status: "passed" });
      } catch (error) {
        const message = formatError(error);

        errors.push(
          `Step ${index + 1} (${describeIntentStep(step)}): ${message}`,
        );
        stepResults.push({
          index,
          action: step.action,
          status: "failed",
          ambiguous: message.includes("strict mode violation"),
          error: message,
        });

        // Assertion failures are evidence (often the bug itself); keep going.
        // Action failures leave the page in an unknown state; stop.
        if (step.action !== "assert") {
          for (let rest = index + 1; rest < plan.steps.length; rest += 1) {
            stepResults.push({
              index: rest,
              action: plan.steps[rest].action,
              status: "skipped",
            });
          }
          break;
        }
      }
    }

    await waitForPageToSettle(page);

    const screenshot = await page
      .screenshot({ fullPage: true, type: "png" })
      .catch(() => null);

    if (screenshot) {
      screenshots.push(screenshot.toString("base64"));
    }

    const html = await page.content().catch((error: unknown) => {
      errors.push(`Could not collect page HTML: ${formatError(error)}`);
      return "";
    });

    return {
      stepResults,
      consoleLogs,
      failedNetworkResponses,
      apiResponses: [],
      html,
      screenshots,
      errors,
    };
  } finally {
    await browser.close();
  }
}

async function runIntentStep(page: Page, baseUrl: string, step: IntentStep) {
  switch (step.action) {
    case "goto":
      await page.goto(new URL(step.path, baseUrl).toString(), {
        waitUntil: "domcontentloaded",
      });
      break;
    case "click":
      await resolveTarget(page, step.target).click({
        timeout: ACTION_TIMEOUT_MS,
      });
      break;
    case "fill":
      await resolveTarget(page, step.target).fill(step.value, {
        timeout: ACTION_TIMEOUT_MS,
      });
      break;
    case "assert": {
      const locator = resolveTarget(page, step.target);

      if (step.condition === "visible") {
        await locator.waitFor({ state: "visible", timeout: ASSERT_TIMEOUT_MS });
      } else if (step.condition === "hidden") {
        await locator.waitFor({ state: "hidden", timeout: ASSERT_TIMEOUT_MS });
      } else {
        await locator.waitFor({ state: "visible", timeout: ASSERT_TIMEOUT_MS });
        const actual = (await locator.textContent()) ?? "";

        if (actual.trim() !== (step.value ?? "").trim()) {
          throw new Error(
            `text_equals failed: expected "${step.value ?? ""}", got "${actual.trim()}"`,
          );
        }
      }
      break;
    }
  }
}

function resolveTarget(page: Page, target: DomTargetIntent): Locator {
  if (target.testId) {
    return page.getByTestId(target.testId);
  }

  if (target.role) {
    return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
      name: target.name,
      exact: false,
    });
  }

  if (target.label) {
    return page.getByLabel(target.label);
  }

  if (target.placeholder) {
    return page.getByPlaceholder(target.placeholder);
  }

  if (target.text) {
    return page.getByText(target.text);
  }

  if (target.name) {
    return page.getByRole("button", { name: target.name });
  }

  throw new Error(
    `Intent target has no usable keys: ${JSON.stringify(target)}`,
  );
}

function describeIntentStep(step: IntentStep): string {
  if (step.action === "goto") {
    return `goto ${step.path}`;
  }

  const target = JSON.stringify(step.target);

  if (step.action === "assert") {
    return `assert ${step.condition} ${target}`;
  }

  return `${step.action} ${target}`;
}

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
