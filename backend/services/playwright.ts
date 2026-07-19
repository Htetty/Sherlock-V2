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
import { truncateWithMarker } from "./bounded-text.js";
import {
  getPlanMode,
  type DomTargetIntent,
  type PlanAssertion,
  type ReproductionPlan,
  type ReproductionStep,
} from "./plan.js";
import type { ArtifactStore } from "./artifacts.js";

const STEP_TIMEOUT_MS = 10_000;
const STEP_SETTLE_MS = 1_000;
const BASE_URL_PROBE_TIMEOUT_MS = 10_000;
const MAX_EVENTS = 1_000;
const MAX_HTTP_RESPONSES = 300;
const MAX_CONSOLE_ERRORS = 100;
const MAX_PAGE_ERRORS = 50;
const MAX_NETWORK_FAILURES = 300;
const MAX_API_RESPONSE_BODY_CHARS = 64 * 1024;
const MAX_RESULT_HTML_CHARS = 64 * 1024;

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

export type ApiResponseRecord = HttpResponseRecord & {
  body: string;
  bodyTruncated?: boolean;
  originalBodyLength?: number;
};

export type EvidenceTruncation = {
  consoleErrorsDropped: number;
  pageErrorsDropped: number;
  networkFailuresDropped: number;
};

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
  evidenceTruncation?: EvidenceTruncation;
  htmlTruncated?: boolean;
  originalHtmlLength?: number;
};

// Rolling evidence sink shared by the plan executor and live sessions
// (docs/fable/11). The plan executor's ReproductionResult holds references to
// these same arrays, so behavior is unchanged; the reproducer agent reads
// them incrementally between actions.
export type SessionEvidence = {
  consoleErrors: string[];
  pageErrors: string[];
  networkFailures: NetworkFailure[];
  httpResponses: HttpResponseRecord[];
  apiResponses: ApiResponseRecord[];
  events: PlaywrightEvent[];
  screenshots: string[];
  truncation: EvidenceTruncation;
  // Browser fetch/XHR response bodies are read asynchronously from Playwright
  // response objects. Track those reads so a step cannot finish before its
  // bounded API evidence has reached the reproduction result.
  pendingResponseCaptures: Set<Promise<void>>;
};

function createSessionEvidence(): SessionEvidence {
  return {
    consoleErrors: [],
    pageErrors: [],
    networkFailures: [],
    httpResponses: [],
    apiResponses: [],
    events: [],
    screenshots: [],
    pendingResponseCaptures: new Set(),
    truncation: {
      consoleErrorsDropped: 0,
      pageErrorsDropped: 0,
      networkFailuresDropped: 0,
    },
  };
}

// The exact listeners the plan executor has always installed, extracted so a
// live session captures identical evidence.
function attachEvidenceListeners(
  page: Page,
  evidence: SessionEvidence,
  baseUrl: string,
) {
  const recordEvent = (type: PlaywrightEvent["type"], detail: string) => {
    if (evidence.events.length < MAX_EVENTS) {
      evidence.events.push({ timestamp: new Date().toISOString(), type, detail });
    }
  };

  page.on("console", (message) => {
    recordEvent("console", `[${message.type()}] ${message.text()}`);

    if (message.type() === "error") {
      pushCapped(
        evidence.consoleErrors,
        message.text(),
        MAX_CONSOLE_ERRORS,
        evidence.truncation,
        "consoleErrorsDropped",
      );
    }
  });

  page.on("pageerror", (error) => {
    recordEvent("pageerror", error.message);
    pushCapped(
      evidence.pageErrors,
      error.message,
      MAX_PAGE_ERRORS,
      evidence.truncation,
      "pageErrorsDropped",
    );
  });

  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown failure";
    recordEvent("requestfailed", `${request.method()} ${request.url()} ${failure}`);
    pushCapped(
      evidence.networkFailures,
      {
        method: request.method(),
        url: request.url(),
        status: null,
        statusText: "",
        failure,
      },
      MAX_NETWORK_FAILURES,
      evidence.truncation,
      "networkFailuresDropped",
    );
  });

  page.on("response", (response) => {
    const method = response.request().method();
    recordEvent(
      "response",
      `${method} ${response.url()} ${response.status()} ${response.statusText()}`,
    );

    if (evidence.httpResponses.length < MAX_HTTP_RESPONSES) {
      evidence.httpResponses.push({
        method,
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
      });
    }

    if (!response.ok()) {
      pushCapped(
        evidence.networkFailures,
        {
          method,
          url: response.url(),
          status: response.status(),
          statusText: response.statusText(),
          failure: `HTTP ${response.status()}`,
        },
        MAX_NETWORK_FAILURES,
        evidence.truncation,
        "networkFailuresDropped",
      );
    }

    // Explicit `request` plan steps already record their response body in
    // performStepAction(). Browser-driven reproductions previously retained
    // only status/URL for page fetch/XHR traffic, which left later regression
    // generation guessing response contracts. Capture same-origin bodies in
    // a bounded form and wait for the read before completing the step.
    const resourceType = response.request().resourceType();
    const sameOrigin = (() => {
      try {
        return new URL(response.url()).origin === new URL(baseUrl).origin;
      } catch {
        return false;
      }
    })();

    if (
      sameOrigin &&
      (resourceType === "fetch" || resourceType === "xhr") &&
      evidence.apiResponses.length < MAX_HTTP_RESPONSES
    ) {
      let capture: Promise<void>;
      capture = response
        .text()
        .then((rawBody) => {
          const body = truncateWithMarker(
            rawBody,
            MAX_API_RESPONSE_BODY_CHARS,
            "API BODY TRUNCATED",
          );
          evidence.apiResponses.push({
            method,
            url: response.url(),
            status: response.status(),
            statusText: response.statusText(),
            body,
            bodyTruncated: rawBody.length > MAX_API_RESPONSE_BODY_CHARS,
            originalBodyLength: rawBody.length,
          });
        })
        .catch(() => {})
        .finally(() => {
          evidence.pendingResponseCaptures.delete(capture);
        });
      evidence.pendingResponseCaptures.add(capture);
    }
  });
}

async function flushPendingResponseCaptures(evidence: SessionEvidence) {
  while (evidence.pendingResponseCaptures.size > 0) {
    await Promise.allSettled([...evidence.pendingResponseCaptures]);
  }
}

function pushCapped<T>(
  target: T[],
  value: T,
  maxItems: number,
  truncation: EvidenceTruncation,
  counter: keyof EvidenceTruncation,
) {
  if (target.length < maxItems) {
    target.push(value);
    return;
  }

  truncation[counter] += 1;
}

// Performs one step's action. Shared verbatim between executeReproductionPlan
// and live sessions - a step that succeeded interactively must have IDENTICAL
// semantics when the frozen plan replays (docs/fable/11).
async function performStepAction(
  page: Page,
  baseUrl: string,
  step: ReproductionStep,
  evidence: SessionEvidence,
  screenshot: (name: string) => Promise<string | null>,
): Promise<string | null> {
  switch (step.action) {
    case "goto":
      await page.goto(new URL(step.path, baseUrl).toString(), {
        waitUntil: "domcontentloaded",
      });
      return null;
    case "click":
      if ("selector" in step) {
        await page.click(step.selector);
      } else {
        await resolveTarget(page, step.target).click({
          timeout: STEP_TIMEOUT_MS,
        });
      }
      await waitForPageToSettle(page);
      return null;
    case "fill":
      if ("selector" in step) {
        await page.fill(step.selector, step.value);
      } else {
        await resolveTarget(page, step.target).fill(step.value, {
          timeout: STEP_TIMEOUT_MS,
        });
      }
      return null;
    case "waitForSelector":
      if ("selector" in step) {
        await page.waitForSelector(step.selector);
      } else {
        await resolveTarget(page, step.target).waitFor({
          state: "visible",
          timeout: STEP_TIMEOUT_MS,
        });
      }
      return null;
    case "screenshot":
      return screenshot(step.id);
    case "wait":
      // Bounded by plan validation; lets async server work settle.
      await page.waitForTimeout(step.ms);
      return null;
    case "request": {
      const url = new URL(step.path, baseUrl).toString();
      const response = await page.request.fetch(url, {
        method: step.method,
        data: step.body,
      });

      const rawBody = await response.text();
      const body = truncateWithMarker(
        rawBody,
        MAX_API_RESPONSE_BODY_CHARS,
        "API BODY TRUNCATED",
      );
      const apiRecord: ApiResponseRecord = {
        method: step.method,
        url,
        status: response.status(),
        statusText: response.statusText(),
        body,
        bodyTruncated: rawBody.length > MAX_API_RESPONSE_BODY_CHARS,
        originalBodyLength: rawBody.length,
      };

      evidence.apiResponses.push(apiRecord);

      if (evidence.httpResponses.length < MAX_HTTP_RESPONSES) {
        evidence.httpResponses.push({
          method: apiRecord.method,
          url: apiRecord.url,
          status: apiRecord.status,
          statusText: apiRecord.statusText,
        });
      }
      return null;
    }
  }
}

// Full step execution with the executor's error handling: strict-mode
// ambiguity detection, target diagnostics, and a failure screenshot.
export async function executeSessionStep(
  page: Page,
  baseUrl: string,
  step: ReproductionStep,
  evidence: SessionEvidence,
  screenshot: (name: string) => Promise<string | null>,
): Promise<StepRecord> {
  const record: StepRecord = {
    id: step.id,
    action: step.action,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: "skipped",
    error: null,
    ambiguous: false,
    screenshot: null,
  };

  try {
    record.screenshot = await performStepAction(page, baseUrl, step, evidence, screenshot);
    await flushPendingResponseCaptures(evidence);
    record.outcome = "passed";
  } catch (error) {
    record.outcome = "failed";
    record.error = formatError(error);
    record.ambiguous = record.error.includes("strict mode violation");

    // Explain WHY an intent target failed: per-key match counts plus
    // hints for common mistakes (e.g. HTML id passed as testId).
    if ("target" in step) {
      const diagnostics = await describeTargetDiagnostics(page, step.target).catch(
        () => "",
      );

      if (diagnostics) {
        record.error = `${record.error}\nTarget diagnostics: ${diagnostics}`;
      }
    }

    record.screenshot = await screenshot(`${step.id}-failure`).catch(() => null);
  }

  record.finishedAt = new Date().toISOString();
  return record;
}

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

  // The result holds references to the evidence arrays, so listener pushes
  // are visible in the result exactly as before the extraction.
  const evidence = createSessionEvidence();

  const result: ReproductionResult = {
    planVersion: plan.version,
    baseUrl: plan.baseUrl,
    startedAt,
    finishedAt: startedAt,
    outcome: "execution_failed",
    outcomeReason: "",
    steps,
    consoleErrors: evidence.consoleErrors,
    pageErrors: evidence.pageErrors,
    networkFailures: evidence.networkFailures,
    httpResponses: evidence.httpResponses,
    apiResponses: evidence.apiResponses,
    screenshots: evidence.screenshots,
    assertion: null,
    events: evidence.events,
    html: "",
    evidenceTruncation: evidence.truncation,
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

  attachEvidenceListeners(page, evidence, plan.baseUrl);

  // API-only plans never open a page: screenshots would be blank white
  // frames that make the run look broken. Skip them and record why
  // (docs/fable/11 observability); browser/mixed plans keep today's behavior.
  const planMode = getPlanMode(plan);
  const visualEvidence =
    planMode === "api-only"
      ? {
          available: false,
          reason: "API-only reproduction plan; no browser page was opened.",
        }
      : { available: true, reason: `Plan mode: ${planMode}.` };

  await store
    .writeJson("visual-evidence.json", { planMode, ...visualEvidence })
    .catch(() => {});

  const screenshot = async (name: string) => {
    if (planMode === "api-only") {
      return null;
    }

    return saveScreenshot(page, store, evidence, name);
  };

  try {
    let failedStep: StepRecord | null = null;

    for (const [index, step] of plan.steps.entries()) {
      const record = steps[index];
      const executed = await executeSessionStep(page, plan.baseUrl, step, evidence, (name) =>
        screenshot(name).catch(() => null),
      );

      Object.assign(record, executed);

      if (record.outcome === "failed") {
        failedStep = record;
        break;
      }
    }

    await waitForPageToSettle(page);
    await flushPendingResponseCaptures(evidence);
    const rawHtml = await page.content().catch(() => "");
    result.html = truncateWithMarker(
      rawHtml,
      MAX_RESULT_HTML_CHARS,
      "HTML TRUNCATED",
    );
    result.htmlTruncated = rawHtml.length > MAX_RESULT_HTML_CHARS;
    result.originalHtmlLength = rawHtml.length;
    await screenshot("final").catch(() => null);

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
      const maybeTruncated = lastMatch.bodyTruncated === true;
      const matchedExpected =
        !matchedFailure &&
        !maybeTruncated &&
        (assertion.expectedContains
          ? lastMatch.body.includes(assertion.expectedContains)
          : true);
      const truncationNote =
        maybeTruncated && !matchedFailure
          ? " Body was truncated before assertion evaluation, so absence of the failure text is not treated as proof of expected behavior."
          : "";

      return {
        assertion,
        observed: lastMatch.body.slice(0, 500),
        matchedFailure,
        matchedExpected,
        detail: matchedFailure
          ? `${lastMatch.method} ${lastMatch.url} response body contained "${assertion.failureContains}".`
          : `${lastMatch.method} ${lastMatch.url} response body did not contain "${assertion.failureContains}".${truncationNote}`,
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
  evidence: SessionEvidence,
  name: string,
) {
  const fileName = `${name}.png`;
  await page.screenshot({
    path: path.join(store.screenshotsDir, fileName),
    fullPage: true,
    type: "png",
  });

  const reference = path.join("screenshots", fileName);
  evidence.screenshots.push(reference);
  return reference;
}

// --- Live session (docs/fable/11) -------------------------------------------
// Interactive browser/API session for the reproducer agent. Steps execute
// through the SAME executeSessionStep the plan executor uses, so a step that
// succeeded live has identical semantics when the frozen plan replays.

export type LiveSession = {
  page: Page;
  baseUrl: string;
  evidence: SessionEvidence;
  executeStep: (step: ReproductionStep) => Promise<StepRecord>;
  readPageDigest: () => Promise<string>;
  // Structured page snapshot (fable/16 action deltas): URL, title, and the
  // SAME interactive-element lines readPageDigest renders — one page model,
  // never a second collector. Snapshots compare deterministically. Optional
  // so pre-existing LiveSession fakes remain valid; consumers must fall back
  // to readPageDigest when absent.
  readPageSnapshot?: () => Promise<PageSnapshot>;
  // Save a screenshot of the current page into the session store (null when
  // no store was provided or the capture fails). Used by the reproducer for
  // exploration traces after browser actions.
  captureScreenshot: (name: string) => Promise<string | null>;
  close: () => Promise<void>;
};

export type OpenLiveSessionOptions = {
  // Store for exploration screenshots (failure shots, screenshot steps).
  store?: ArtifactStore | null;
  probeTimeoutMs?: number;
};

export async function openLiveSession(
  baseUrl: string,
  options: OpenLiveSessionOptions = {},
): Promise<LiveSession> {
  const probeTimeoutMs = options.probeTimeoutMs ?? BASE_URL_PROBE_TIMEOUT_MS;

  if (!(await isBaseUrlReachable(baseUrl, probeTimeoutMs))) {
    throw new Error(`Application base URL ${baseUrl} was not reachable.`);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(STEP_TIMEOUT_MS);

  const evidence = createSessionEvidence();
  attachEvidenceListeners(page, evidence, baseUrl);

  const screenshot = async (name: string) => {
    if (!options.store) {
      return null;
    }

    return saveScreenshot(page, options.store, evidence, name).catch(() => null);
  };

  return {
    page,
    baseUrl,
    evidence,
    executeStep: (step) => executeSessionStep(page, baseUrl, step, evidence, screenshot),
    readPageDigest: async () => {
      await flushPendingResponseCaptures(evidence);
      return formatPageSnapshot(await buildPageSnapshot(page));
    },
    readPageSnapshot: () => buildPageSnapshot(page),
    captureScreenshot: screenshot,
    close: async () => {
      await browser.close().catch(() => {});
    },
  };
}

const MAX_DIGEST_ELEMENTS = 200;

// Structured page snapshot (fable/16): URL, title, and interactive-element
// lines in the exact target vocabulary. The single source for read_page
// digests AND action-delta diffs — one page model.
export type PageSnapshot = {
  url: string;
  title: string;
  elements: string[];
};

export function formatPageSnapshot(snapshot: PageSnapshot): string {
  return [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title || "(none)"}`,
    "Interactive elements:",
    ...(snapshot.elements.length > 0 ? snapshot.elements : ["(none found)"]),
  ].join("\n");
}

// Deterministic snapshot comparison: URL/title changes plus element lines
// that appeared or disappeared. Element lines are compared verbatim (they are
// already normalized by the collector), so the diff is stable.
export function computePageSnapshotDelta(
  previous: PageSnapshot | null,
  next: PageSnapshot,
): string[] {
  const lines: string[] = [];

  if (!previous) {
    lines.push(`URL: ${next.url}`, `Title: ${next.title || "(none)"}`);

    if (next.elements.length > 0) {
      lines.push("New interactive elements:", ...next.elements);
    }

    return lines;
  }

  if (previous.url !== next.url) {
    lines.push(`URL changed: ${previous.url} -> ${next.url}`);
  }

  if (previous.title !== next.title) {
    lines.push(`Title changed: "${previous.title}" -> "${next.title}"`);
  }

  const previousSet = new Set(previous.elements);
  const nextSet = new Set(next.elements);
  const appeared = next.elements.filter((line) => !previousSet.has(line));
  const disappeared = previous.elements.filter((line) => !nextSet.has(line));

  if (appeared.length > 0) {
    lines.push("Appeared:", ...appeared);
  }

  if (disappeared.length > 0) {
    lines.push("Disappeared:", ...disappeared);
  }

  return lines;
}

// Interactive elements described in the exact vocabulary DomTargetIntent
// accepts (role, name, label, placeholder, testId, id, text) - what the agent
// sees is what it can target. Capping/truncation is the caller's job.
async function buildPageSnapshot(page: Page): Promise<PageSnapshot> {
  const url = page.url();
  const title = await page.title().catch(() => "");

  const elements = await page
    .evaluate((maxElements: number) => {
      const lines: string[] = [];
      const nodes = document.querySelectorAll(
        "a, button, input, select, textarea, form, [role], [data-testid], [onclick]",
      );

      for (const el of Array.from(nodes)) {
        if (lines.length >= maxElements) {
          break;
        }

        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute("type");

        if (tag === "input" && type === "hidden") {
          continue;
        }

        const parts: string[] = [tag + (type ? `[type=${type}]` : "")];
        const role = el.getAttribute("role");
        const testId = el.getAttribute("data-testid");
        const placeholder = el.getAttribute("placeholder");
        const ariaLabel = el.getAttribute("aria-label");

        if (role) parts.push(`role="${role}"`);
        if (testId) parts.push(`testId="${testId}"`);
        if (el.id) parts.push(`id="${el.id}"`);
        if (placeholder) parts.push(`placeholder="${placeholder}"`);

        let label = ariaLabel ?? "";

        if (!label && el.id) {
          const forLabel = document.querySelector(`label[for="${el.id}"]`);
          label = forLabel?.textContent?.trim() ?? "";
        }

        if (!label) {
          const parentLabel = el.closest("label");
          label = parentLabel?.textContent?.trim() ?? "";
        }

        if (label) parts.push(`label="${label.replace(/\s+/g, " ").slice(0, 80)}"`);

        const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80);

        if (text && tag !== "form" && tag !== "select") {
          parts.push(`text="${text}"`);
        }

        lines.push(`- ${parts.join(" ")}`);
      }

      return lines;
    }, MAX_DIGEST_ELEMENTS)
    .catch(() => ["(page digest unavailable)"]);

  return { url, title, elements };
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
