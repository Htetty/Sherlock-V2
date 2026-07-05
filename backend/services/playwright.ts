// Deterministic execution of a validated, saved reproduction plan.
// This module must stay free of Claude/Anthropic imports so saved plans can be
// replayed without any Claude dependency.
//
// Merge note: steps and element_text assertions accept either a raw CSS
// selector (dev replay compatibility) or an intent-level target
// (docs/fable/07). Targets resolve through Playwright's strict-mode
// user-facing locators: zero or multiple matches throw, so the step fails
// with `ambiguous` recorded instead of acting on the wrong element.

import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import type {
  DomTargetIntent,
  PlanAssertion,
  ReproductionPlan,
} from "./plan.js";
import type { ArtifactStore } from "./artifacts.js";

const STEP_TIMEOUT_MS = 10_000;
const STEP_SETTLE_MS = 1_000;
const BASE_URL_PROBE_TIMEOUT_MS = 10_000;
const MAX_EVENTS = 1_000;
const MAX_HTTP_RESPONSES = 300;

export type StepOutcome = "passed" | "failed" | "skipped";

export type StepRecord = {
  id: string;
  action: string;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: StepOutcome;
  error: string | null;
  // True when the failure was a strict-mode violation (target matched
  // multiple elements) - a plan defect, not evidence about the bug.
  ambiguous: boolean;
  screenshot: string | null;
};

export type PlaywrightEvent = {
  timestamp: string;
  type: "console" | "pageerror" | "requestfailed" | "response";
  detail: string;
};

export type HttpResponseRecord = {
  method: string;
  url: string;
  status: number;
  statusText: string;
};

export type NetworkFailure = {
  method: string;
  url: string;
  status: number | null;
  statusText: string;
  failure: string;
};

export type ApiResponseRecord = HttpResponseRecord & { body: string };

export type AssertionResult = {
  assertion: PlanAssertion;
  observed: string | null;
  matchedFailure: boolean;
  matchedExpected: boolean;
  detail: string;
};

export type ReproductionOutcome =
  | "reproduced"
  | "not_reproduced"
  | "environment_failed"
  | "execution_failed";

export type ReproductionResult = {
  planVersion: number;
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  outcome: ReproductionOutcome;
  outcomeReason: string;
  steps: StepRecord[];
  consoleErrors: string[];
  pageErrors: string[];
  networkFailures: NetworkFailure[];
  httpResponses: HttpResponseRecord[];
  apiResponses: ApiResponseRecord[];
  screenshots: string[];
  assertion: AssertionResult | null;
  events: PlaywrightEvent[];
  html: string;
};

export type ExecuteOptions = {
  probeTimeoutMs?: number;
};

export async function executeReproductionPlan(
  plan: ReproductionPlan,
  store: ArtifactStore,
  options: ExecuteOptions = {},
): Promise<ReproductionResult> {
  const startedAt = new Date().toISOString();
  const steps: StepRecord[] = plan.steps.map((step) => ({
    id: step.id,
    action: step.action,
    startedAt: null,
    finishedAt: null,
    outcome: "skipped",
    error: null,
    ambiguous: false,
    screenshot: null,
  }));

  const result: ReproductionResult = {
    planVersion: plan.version,
    baseUrl: plan.baseUrl,
    startedAt,
    finishedAt: startedAt,
    outcome: "execution_failed",
    outcomeReason: "",
    steps,
    consoleErrors: [],
    pageErrors: [],
    networkFailures: [],
    httpResponses: [],
    apiResponses: [],
    screenshots: [],
    assertion: null,
    events: [],
    html: "",
  };

  const probeTimeoutMs = options.probeTimeoutMs ?? BASE_URL_PROBE_TIMEOUT_MS;

  if (!(await isBaseUrlReachable(plan.baseUrl, probeTimeoutMs))) {
    result.outcome = "environment_failed";
    result.outcomeReason = `Application base URL ${plan.baseUrl} was not reachable.`;
    result.finishedAt = new Date().toISOString();
    return result;
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(STEP_TIMEOUT_MS);

  const recordEvent = (type: PlaywrightEvent["type"], detail: string) => {
    if (result.events.length < MAX_EVENTS) {
      result.events.push({ timestamp: new Date().toISOString(), type, detail });
    }
  };

  page.on("console", (message) => {
    recordEvent("console", `[${message.type()}] ${message.text()}`);

    if (message.type() === "error") {
      result.consoleErrors.push(message.text());
    }
  });

  page.on("pageerror", (error) => {
    recordEvent("pageerror", error.message);
    result.pageErrors.push(error.message);
  });

  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    recordEvent("requestfailed", `${request.method()} ${request.url()} ${failure}`);
    result.networkFailures.push({
      method: request.method(),
      url: request.url(),
      status: null,
      statusText: "",
      failure,
    });
  });

  page.on("response", (response) => {
    const method = response.request().method();
    recordEvent(
      "response",
      `${method} ${response.url()} ${response.status()} ${response.statusText()}`,
    );

    if (result.httpResponses.length < MAX_HTTP_RESPONSES) {
      result.httpResponses.push({
        method,
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
      });
    }

    if (!response.ok()) {
      result.networkFailures.push({
        method,
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        failure: `HTTP ${response.status()}`,
      });
    }
  });

  try {
    let failedStep: StepRecord | null = null;

    for (const [index, step] of plan.steps.entries()) {
      const record = steps[index];
      record.startedAt = new Date().toISOString();

      try {
        switch (step.action) {
          case "goto":
            await page.goto(new URL(step.path, plan.baseUrl).toString(), {
              waitUntil: "domcontentloaded",
            });
            break;
          case "click":
            if ("selector" in step) {
              await page.click(step.selector);
            } else {
              await resolveTarget(page, step.target).click({
                timeout: STEP_TIMEOUT_MS,
              });
            }
            await waitForPageToSettle(page);
            break;
          case "fill":
            if ("selector" in step) {
              await page.fill(step.selector, step.value);
            } else {
              await resolveTarget(page, step.target).fill(step.value, {
                timeout: STEP_TIMEOUT_MS,
              });
            }
            break;
          case "waitForSelector":
            if ("selector" in step) {
              await page.waitForSelector(step.selector);
            } else {
              await resolveTarget(page, step.target).waitFor({
                state: "visible",
                timeout: STEP_TIMEOUT_MS,
              });
            }
            break;
          case "screenshot":
            record.screenshot = await saveScreenshot(page, store, result, step.id);
            break;
          case "wait":
            // Bounded by plan validation; lets async server work settle.
            await page.waitForTimeout(step.ms);
            break;
          case "request": {
            const url = new URL(step.path, plan.baseUrl).toString();
            const response = await page.request.fetch(url, {
              method: step.method,
              data: step.body,
            });

            const apiRecord: ApiResponseRecord = {
              method: step.method,
              url,
              status: response.status(),
              statusText: response.statusText(),
              body: await response.text(),
            };

            result.apiResponses.push(apiRecord);

            if (result.httpResponses.length < MAX_HTTP_RESPONSES) {
              result.httpResponses.push({
                method: apiRecord.method,
                url: apiRecord.url,
                status: apiRecord.status,
                statusText: apiRecord.statusText,
              });
            }
            break;
          }
        }

        record.outcome = "passed";
      } catch (error) {
        record.outcome = "failed";
        record.error = formatError(error);
        record.ambiguous = record.error.includes("strict mode violation");

        // Explain WHY an intent target failed: per-key match counts plus
        // hints for common mistakes (e.g. HTML id passed as testId).
        if ("target" in step) {
          const diagnostics = await describeTargetDiagnostics(
            page,
            step.target,
          ).catch(() => "");

          if (diagnostics) {
            record.error = `${record.error}\nTarget diagnostics: ${diagnostics}`;
          }
        }

        record.screenshot = await saveScreenshot(
          page,
          store,
          result,
          `${step.id}-failure`,
        ).catch(() => null);
        failedStep = record;
      }

      record.finishedAt = new Date().toISOString();

      if (failedStep) {
        break;
      }
    }

    await waitForPageToSettle(page);
    result.html = await page.content().catch(() => "");
    await saveScreenshot(page, store, result, "final").catch(() => null);

    if (failedStep) {
      result.outcome = "execution_failed";
      result.outcomeReason = failedStep.ambiguous
        ? `Step "${failedStep.id}" (${failedStep.action}) was blocked: its target matched multiple elements (plan defect, no action taken): ${failedStep.error}`
        : `Step "${failedStep.id}" (${failedStep.action}) failed: ${failedStep.error}`;
    } else {
      result.assertion = await evaluateAssertion(plan.assertion, result, page);

      if (result.assertion.matchedFailure) {
        result.outcome = "reproduced";
        result.outcomeReason = `Expected failure condition observed: ${result.assertion.detail}`;
      } else {
        result.outcome = "not_reproduced";
        result.outcomeReason = result.assertion.matchedExpected
          ? `Expected behavior observed: ${result.assertion.detail}`
          : `Neither the expected behavior nor the failure condition was observed: ${result.assertion.detail}`;
      }
    }
  } catch (error) {
    result.outcome = "execution_failed";
    result.outcomeReason = `Unexpected Playwright error: ${formatError(error)}`;
  } finally {
    await browser.close();
    result.finishedAt = new Date().toISOString();
  }

  return result;
}

// Strict-mode resolution of an intent target. Priority mirrors
// docs/fable/07: testId, then role(+name), then label, placeholder, text,
// then bare name as a button. No `.first()` anywhere - ambiguity must throw.
function resolveTarget(page: Page, target: DomTargetIntent): Locator {
  if (target.testId) {
    return page.getByTestId(target.testId);
  }

  if (target.id) {
    return page.locator(`#${target.id}`);
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

  throw new Error(`Intent target has no usable keys: ${JSON.stringify(target)}`);
}

// Per-key match counts for a failed target, plus cross-checks for the two
// most common model mistakes: an HTML id passed as testId, and vice versa.
async function describeTargetDiagnostics(
  page: Page,
  target: DomTargetIntent,
): Promise<string> {
  const probes: { label: string; locator: Locator }[] = [];

  if (target.testId) {
    probes.push({
      label: `testId="${target.testId}"`,
      locator: page.getByTestId(target.testId),
    });
  }

  if (target.id) {
    probes.push({ label: `id="${target.id}"`, locator: page.locator(`#${target.id}`) });
  }

  if (target.role) {
    probes.push({
      label: `role="${target.role}"${target.name ? ` name="${target.name}"` : ""}`,
      locator: page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
        name: target.name,
      }),
    });
  }

  if (target.label) {
    probes.push({ label: `label="${target.label}"`, locator: page.getByLabel(target.label) });
  }

  if (target.placeholder) {
    probes.push({
      label: `placeholder="${target.placeholder}"`,
      locator: page.getByPlaceholder(target.placeholder),
    });
  }

  if (target.text) {
    probes.push({ label: `text="${target.text}"`, locator: page.getByText(target.text) });
  }

  const parts: string[] = [];

  for (const probe of probes) {
    const count = await probe.locator.count().catch(() => -1);
    parts.push(`${probe.label} -> ${count} match(es)`);
  }

  // Cross-checks for misclassified identifiers.
  if (target.testId) {
    const asId = await page.locator(`#${target.testId}`).count().catch(() => 0);

    if (asId > 0) {
      parts.push(
        `note: an element with HTML id="${target.testId}" exists (${asId} match(es)); testId means the data-testid attribute - use { "id": "${target.testId}" } instead`,
      );
    }
  }

  if (target.id) {
    const asTestId = await page.getByTestId(target.id).count().catch(() => 0);

    if (asTestId > 0) {
      parts.push(
        `note: an element with data-testid="${target.id}" exists (${asTestId} match(es)); use { "testId": "${target.id}" } instead`,
      );
    }
  }

  return parts.join("; ");
}

async function evaluateAssertion(
  assertion: PlanAssertion,
  result: ReproductionResult,
  page: Page,
): Promise<AssertionResult> {
  switch (assertion.type) {
    case "response_status": {
      const matches = result.httpResponses.filter((response) => {
        if (assertion.method && response.method !== assertion.method) {
          return false;
        }

        if (assertion.pathPattern && !response.url.includes(assertion.pathPattern)) {
          return false;
        }

        return true;
      });

      const lastMatch = matches[matches.length - 1];

      if (!lastMatch) {
        return {
          assertion,
          observed: null,
          matchedFailure: false,
          matchedExpected: false,
          detail: "No HTTP response matched the assertion filter.",
        };
      }

      return {
        assertion,
        observed: String(lastMatch.status),
        matchedFailure: lastMatch.status === assertion.failureValue,
        matchedExpected: lastMatch.status === assertion.expected,
        detail: `${lastMatch.method} ${lastMatch.url} returned HTTP ${lastMatch.status} (expected ${assertion.expected}, failure ${assertion.failureValue}).`,
      };
    }
    case "console_error": {
      const allErrors = [...result.consoleErrors, ...result.pageErrors];
      const match = allErrors.find((message) => message.includes(assertion.contains));

      return {
        assertion,
        observed: match ?? null,
        matchedFailure: match !== undefined,
        matchedExpected: match === undefined,
        detail: match
          ? `Console/page error contained "${assertion.contains}".`
          : `No console/page error contained "${assertion.contains}".`,
      };
    }
    case "response_body": {
      const matches = result.apiResponses.filter((response) => {
        if (assertion.method && response.method !== assertion.method) {
          return false;
        }

        if (assertion.pathPattern && !response.url.includes(assertion.pathPattern)) {
          return false;
        }

        return true;
      });

      const lastMatch = matches[matches.length - 1];

      if (!lastMatch) {
        return {
          assertion,
          observed: null,
          matchedFailure: false,
          matchedExpected: false,
          detail:
            "No API response from a request step matched the assertion filter.",
        };
      }

      const matchedFailure = lastMatch.body.includes(assertion.failureContains);
      const matchedExpected = assertion.expectedContains
        ? lastMatch.body.includes(assertion.expectedContains) && !matchedFailure
        : !matchedFailure;

      return {
        assertion,
        observed: lastMatch.body.slice(0, 500),
        matchedFailure,
        matchedExpected,
        detail: matchedFailure
          ? `${lastMatch.method} ${lastMatch.url} response body contained "${assertion.failureContains}".`
          : `${lastMatch.method} ${lastMatch.url} response body did not contain "${assertion.failureContains}".`,
      };
    }
    case "element_text": {
      const targetLabel =
        "selector" in assertion
          ? `"${assertion.selector}"`
          : JSON.stringify(assertion.target);

      const text =
        "selector" in assertion
          ? await page
              .textContent(assertion.selector, { timeout: STEP_TIMEOUT_MS })
              .catch(() => null)
          : await resolveTarget(page, assertion.target)
              .textContent({ timeout: STEP_TIMEOUT_MS })
              .catch(() => null);

      if (text === null) {
        return {
          assertion,
          observed: null,
          matchedFailure: false,
          matchedExpected: false,
          detail: `Element ${targetLabel} was not found (or did not resolve to exactly one element).`,
        };
      }

      const matched = text.includes(assertion.contains);

      return {
        assertion,
        observed: text.slice(0, 500),
        matchedFailure: matched,
        matchedExpected: !matched,
        detail: matched
          ? `Element ${targetLabel} contained "${assertion.contains}".`
          : `Element ${targetLabel} did not contain "${assertion.contains}".`,
      };
    }
  }
}

async function saveScreenshot(
  page: Page,
  store: ArtifactStore,
  result: ReproductionResult,
  name: string,
) {
  const fileName = `${name}.png`;
  await page.screenshot({
    path: path.join(store.screenshotsDir, fileName),
    fullPage: true,
    type: "png",
  });

  const reference = path.join("screenshots", fileName);
  result.screenshots.push(reference);
  return reference;
}

async function isBaseUrlReachable(baseUrl: string, timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return false;
}

async function waitForPageToSettle(page: Page) {
  await page
    .waitForLoadState("networkidle", { timeout: STEP_SETTLE_MS })
    .catch(async () => {
      await page.waitForTimeout(STEP_SETTLE_MS);
    });
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
