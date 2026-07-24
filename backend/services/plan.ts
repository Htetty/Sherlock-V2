// Structured reproduction plan schema and validation.
// This module must stay free of Claude/Anthropic imports so saved plans can be
// replayed without any Claude dependency.

import { createHash } from "node:crypto";

export const REPRODUCTION_PLAN_VERSION = 1;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// Intent-level target (docs/fable/07): describes the element the way a user
// sees it. Resolved via Playwright's strict-mode user-facing locators, so
// zero or multiple matches fail the step instead of guessing. The model-facing
// prompt only teaches targets; raw selectors remain valid for saved-plan
// replay compatibility.
export type DomTargetScope = {
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  // data-testid attribute value (NOT the HTML id attribute).
  testId?: string;
  // HTML id attribute value.
  id?: string;
};

export type DomTargetIntent = DomTargetScope & {
  // Scope this target to a grounded ancestor/container, e.g. the delete
  // button within the list item whose text names the task.
  within?: DomTargetScope;
};

export type ReproductionStep =
  | { id: string; action: "goto"; path: string }
  | { id: string; action: "click"; selector: string }
  | { id: string; action: "click"; target: DomTargetIntent }
  | { id: string; action: "fill"; selector: string; value: string }
  | { id: string; action: "fill"; target: DomTargetIntent; value: string }
  | { id: string; action: "waitForSelector"; selector: string }
  | { id: string; action: "waitForSelector"; target: DomTargetIntent }
  | { id: string; action: "screenshot" }
  // Bounded pause so plans can let asynchronous work (queued jobs, debounced
  // saves) settle before checking state.
  | { id: string; action: "wait"; ms: number }
  | {
      id: string;
      action: "request";
      method: HttpMethod;
      path: string;
      body?: Record<string, unknown>;
    };

export type PlanAssertion =
  | {
      type: "response_status";
      // Substring the response URL must contain; defaults to any response.
      pathPattern?: string;
      method?: HttpMethod;
      expected: number;
      failureValue: number;
    }
  | {
      type: "console_error";
      contains: string;
    }
  | {
      type: "page_text";
      contains: string;
      failureWhen: "present" | "absent";
    }
  | {
      type: "input_value";
      target: DomTargetIntent;
      value: string;
      failureWhen: "equals" | "not_equals";
    }
  | {
      type: "element_text";
      selector: string;
      contains: string;
    }
  | {
      type: "element_text";
      target: DomTargetIntent;
      contains: string;
    }
  // Substring check against the body of the last matching API response from
  // a "request" step. The failure condition matches when the body contains
  // failureContains; expectedContains (optional) confirms correct behavior,
  // otherwise the absence of failureContains counts as expected.
  | {
      type: "response_body";
      pathPattern?: string;
      method?: HttpMethod;
      failureContains: string;
      expectedContains?: string;
    };

export type ReproductionPlan = {
  version: number;
  baseUrl: string;
  steps: ReproductionStep[];
  expectedBehavior: string;
  failureCondition: string;
  assertion: PlanAssertion;
};

export type PlanValidationResult =
  | { ok: true; plan: ReproductionPlan }
  | { ok: false; errors: string[] };

// Canonical hash of a plan's BEHAVIOR (steps + assertion, excluding baseUrl,
// which changes per sandbox). The single plan-identity implementation: used
// by the replay-proof check in fix.ts, the reproducer's duplicate-plan guard,
// and failed-plan memory.
export function hashPlanBehavior(plan: ReproductionPlan): string {
  return createHash("sha256")
    .update(JSON.stringify({ steps: plan.steps, assertion: plan.assertion }))
    .digest("hex")
    .slice(0, 16);
}

const MAX_STEPS = 30;
const MAX_WAIT_MS = 10_000;

// Steps that drive a real browser page. Assertions that read browser state
// (console errors, page/element text) are vacuous without at least one of these.
const BROWSER_ACTIONS = new Set(["goto", "click", "fill", "waitForSelector"]);
const BROWSER_ONLY_ASSERTIONS = new Set([
  "console_error",
  "page_text",
  "input_value",
  "element_text",
]);

export function validateReproductionPlan(value: unknown): PlanValidationResult {
  const errors: string[] = [];

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["Plan must be a JSON object."] };
  }

  const plan = value as Record<string, unknown>;

  if (plan.version !== REPRODUCTION_PLAN_VERSION) {
    errors.push(
      `Plan version must be ${REPRODUCTION_PLAN_VERSION}, got ${JSON.stringify(plan.version)}.`,
    );
  }

  if (typeof plan.baseUrl !== "string" || !isSafeBaseUrl(plan.baseUrl)) {
    errors.push(
      "Plan baseUrl must be an http(s) URL pointing at localhost, 127.0.0.1, or the sandbox app container.",
    );
  }

  if (typeof plan.expectedBehavior !== "string" || !plan.expectedBehavior) {
    errors.push("Plan expectedBehavior must be a non-empty string.");
  }

  if (typeof plan.failureCondition !== "string" || !plan.failureCondition) {
    errors.push("Plan failureCondition must be a non-empty string.");
  }

  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    errors.push("Plan steps must be a non-empty array.");
  } else if (plan.steps.length > MAX_STEPS) {
    errors.push(`Plan has ${plan.steps.length} steps; maximum is ${MAX_STEPS}.`);
  } else {
    const seenIds = new Set<string>();

    plan.steps.forEach((step, index) => {
      const stepErrors = validateStep(step, index);
      errors.push(...stepErrors);

      if (stepErrors.length === 0) {
        const id = (step as ReproductionStep).id;

        if (seenIds.has(id)) {
          errors.push(`Duplicate step id "${id}".`);
        }

        seenIds.add(id);
      }
    });
  }

  errors.push(...validateAssertion(plan.assertion));

  // Vacuous-assertion guard: a browser-state assertion over a plan that never
  // opens a page can only ever pass, which silently turns real bugs into
  // false "not_reproduced" verdicts.
  if (errors.length === 0) {
    const assertionType = (plan.assertion as Record<string, unknown>).type as string;
    const hasBrowserStep = (plan.steps as ReproductionStep[]).some((step) =>
      BROWSER_ACTIONS.has(step.action),
    );

    if (BROWSER_ONLY_ASSERTIONS.has(assertionType) && !hasBrowserStep) {
      errors.push(
        `A "${assertionType}" assertion requires at least one browser step (goto, click, fill, waitForSelector); this plan only makes API requests. Use a "response_status" or "response_body" assertion instead.`,
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, plan: plan as unknown as ReproductionPlan };
}

// Exported for the reproducer agent (docs/fable/11): live tool actions are
// validated with the exact same rules as frozen plan steps, so nothing the
// agent does interactively could be illegal in the submitted plan.
export function validateStep(value: unknown, index: number): string[] {
  const label = `Step ${index + 1}`;

  if (!value || typeof value !== "object") {
    return [`${label} must be an object.`];
  }

  const step = value as Record<string, unknown>;

  if (typeof step.id !== "string" || !step.id) {
    return [`${label} must have a non-empty string id.`];
  }

  switch (step.action) {
    case "goto":
      if (!hasOnlyKeys(step, ["id", "action", "path"]) || typeof step.path !== "string") {
        return [`${label} (goto) must have only id, action, and a string path.`];
      }
      if (!isSafePath(step.path)) {
        return [`${label} (goto) path must be relative (start with "/").`];
      }
      return [];
    case "click":
    case "waitForSelector": {
      const bySelector =
        hasOnlyKeys(step, ["id", "action", "selector"]) &&
        typeof step.selector === "string" &&
        !!step.selector;
      const byTarget =
        hasOnlyKeys(step, ["id", "action", "target"]) &&
        isDomTargetIntent(step.target);

      if (!bySelector && !byTarget) {
        return [
          `${label} (${step.action}) must have id, action, and either a non-empty selector or a valid target object (${TARGET_KEYS.join("/")}).`,
        ];
      }
      return [];
    }
    case "fill": {
      const bySelector =
        hasOnlyKeys(step, ["id", "action", "selector", "value"]) &&
        typeof step.selector === "string" &&
        !!step.selector &&
        typeof step.value === "string";
      const byTarget =
        hasOnlyKeys(step, ["id", "action", "target", "value"]) &&
        isDomTargetIntent(step.target) &&
        typeof step.value === "string";

      if (!bySelector && !byTarget) {
        return [
          `${label} (fill) must have id, action, a string value, and either a non-empty selector or a valid target object (${TARGET_KEYS.join("/")}).`,
        ];
      }
      return [];
    }
    case "screenshot":
      if (!hasOnlyKeys(step, ["id", "action"])) {
        return [`${label} (screenshot) must have only id and action.`];
      }
      return [];
    case "wait":
      if (
        !hasOnlyKeys(step, ["id", "action", "ms"]) ||
        typeof step.ms !== "number" ||
        !Number.isInteger(step.ms) ||
        step.ms < 1 ||
        step.ms > MAX_WAIT_MS
      ) {
        return [
          `${label} (wait) must have only id, action, and an integer ms between 1 and ${MAX_WAIT_MS}.`,
        ];
      }
      return [];
    case "request":
      if (
        !hasOnlyKeys(step, ["id", "action", "method", "path", "body"]) ||
        !isHttpMethod(step.method) ||
        typeof step.path !== "string" ||
        !isSafePath(step.path) ||
        (step.body !== undefined &&
          (typeof step.body !== "object" || step.body === null || Array.isArray(step.body)))
      ) {
        return [
          `${label} (request) must have id, action, a valid HTTP method, a relative path, and an optional object body.`,
        ];
      }
      return [];
    default:
      return [`${label} has unsupported action ${JSON.stringify(step.action)}.`];
  }
}

function validateAssertion(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return ["Plan assertion must be an object."];
  }

  const assertion = value as Record<string, unknown>;

  switch (assertion.type) {
    case "response_status":
      if (
        !hasOnlyKeys(assertion, ["type", "pathPattern", "method", "expected", "failureValue"]) ||
        typeof assertion.expected !== "number" ||
        typeof assertion.failureValue !== "number" ||
        (assertion.pathPattern !== undefined && typeof assertion.pathPattern !== "string") ||
        (assertion.method !== undefined && !isHttpMethod(assertion.method))
      ) {
        return [
          "response_status assertion must have numeric expected and failureValue, optional string pathPattern, optional HTTP method.",
        ];
      }
      if (assertion.expected === assertion.failureValue) {
        return ["response_status assertion expected and failureValue must differ."];
      }
      return [];
    case "console_error":
      if (
        !hasOnlyKeys(assertion, ["type", "contains"]) ||
        typeof assertion.contains !== "string" ||
        !assertion.contains
      ) {
        return ["console_error assertion must have a non-empty string contains."];
      }
      return [];
    case "page_text":
      if (
        !hasOnlyKeys(assertion, ["type", "contains", "failureWhen"]) ||
        typeof assertion.contains !== "string" ||
        !assertion.contains ||
        (assertion.failureWhen !== "present" && assertion.failureWhen !== "absent")
      ) {
        return [
          'page_text assertion must have a non-empty string contains and failureWhen set to "present" or "absent".',
        ];
      }
      return [];
    case "input_value":
      if (
        !hasOnlyKeys(assertion, ["type", "target", "value", "failureWhen"]) ||
        !isDomTargetIntent(assertion.target) ||
        typeof assertion.value !== "string" ||
        (assertion.failureWhen !== "equals" &&
          assertion.failureWhen !== "not_equals")
      ) {
        return [
          'input_value assertion must have a valid target, a string value, and failureWhen set to "equals" or "not_equals".',
        ];
      }
      return [];
    case "element_text": {
      const bySelector =
        hasOnlyKeys(assertion, ["type", "selector", "contains"]) &&
        typeof assertion.selector === "string" &&
        !!assertion.selector;
      const byTarget =
        hasOnlyKeys(assertion, ["type", "target", "contains"]) &&
        isDomTargetIntent(assertion.target);

      if (
        (!bySelector && !byTarget) ||
        typeof assertion.contains !== "string" ||
        !assertion.contains
      ) {
        return [
          "element_text assertion must have a non-empty contains string and either a non-empty selector or a valid target object.",
        ];
      }
      return [];
    }
    case "response_body":
      if (
        !hasOnlyKeys(assertion, [
          "type",
          "pathPattern",
          "method",
          "failureContains",
          "expectedContains",
        ]) ||
        typeof assertion.failureContains !== "string" ||
        !assertion.failureContains ||
        (assertion.pathPattern !== undefined && typeof assertion.pathPattern !== "string") ||
        (assertion.method !== undefined && !isHttpMethod(assertion.method)) ||
        (assertion.expectedContains !== undefined &&
          (typeof assertion.expectedContains !== "string" || !assertion.expectedContains))
      ) {
        return [
          "response_body assertion must have a non-empty string failureContains, optional string pathPattern, optional HTTP method, and optional non-empty expectedContains.",
        ];
      }
      if (assertion.failureContains === assertion.expectedContains) {
        return ["response_body assertion failureContains and expectedContains must differ."];
      }
      return [];
    default:
      return [`Unsupported assertion type ${JSON.stringify(assertion.type)}.`];
  }
}

// --- Plan mode (docs/fable/11 observability) --------------------------------
// Distinguishes API-only, browser, and mixed reproductions so visual
// artifacts are only produced when a browser page was actually driven.

export type PlanMode = "api-only" | "browser" | "mixed";

// Steps that drive a real browser page. "wait" is neutral: it belongs to
// whichever kind of plan it appears in.
const PAGE_ACTIONS = new Set([
  "goto",
  "click",
  "fill",
  "waitForSelector",
  "screenshot",
]);

export function getPlanMode(plan: ReproductionPlan): PlanMode {
  const hasBrowser = plan.steps.some((step) => PAGE_ACTIONS.has(step.action));
  const hasRequest = plan.steps.some((step) => step.action === "request");

  if (hasBrowser && hasRequest) {
    return "mixed";
  }

  if (hasBrowser) {
    return "browser";
  }

  return "api-only";
}

const TARGET_KEYS = [
  "role",
  "name",
  "label",
  "placeholder",
  "text",
  "testId",
  "id",
  "within",
] as const;

export function isDomTargetIntent(value: unknown): value is DomTargetIntent {
  return isTargetObject(value, true);
}

function isTargetObject(value: unknown, allowWithin: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const target = value as Record<string, unknown>;
  const keys = Object.keys(target);
  const selectorKeys = keys.filter((key) => key !== "within");

  return (
    selectorKeys.length > 0 &&
    keys.every((key) => (TARGET_KEYS as readonly string[]).includes(key)) &&
    selectorKeys.every(
      (key) => typeof target[key] === "string" && target[key] !== "",
    ) &&
    (target.within === undefined ||
      (allowWithin && isTargetObject(target.within, false)))
  );
}

// Under network addressing (containerized worker; see SandboxAddressing in
// container.ts) the sandbox base URL names the target app container on the
// shared sandbox network instead of localhost. Container names come from
// createContainerName("app") in container.ts: sherlock-app-<uuid>.
const SANDBOX_APP_CONTAINER_HOSTNAME = /^sherlock-app-[0-9a-f-]{36}$/i;

function isSafeBaseUrl(value: string) {
  try {
    const url = new URL(value);

    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        SANDBOX_APP_CONTAINER_HOSTNAME.test(url.hostname))
    );
  } catch {
    return false;
  }
}

function isSafePath(value: string) {
  return value.startsWith("/") && !value.startsWith("//");
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isHttpMethod(value: unknown): value is HttpMethod {
  return (
    value === "GET" ||
    value === "POST" ||
    value === "PUT" ||
    value === "PATCH" ||
    value === "DELETE"
  );
}
