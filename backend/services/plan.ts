// Structured reproduction plan schema and validation.
// This module must stay free of Claude/Anthropic imports so saved plans can be
// replayed without any Claude dependency.

export const REPRODUCTION_PLAN_VERSION = 1;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ReproductionStep =
  | { id: string; action: "goto"; path: string }
  | { id: string; action: "click"; selector: string }
  | { id: string; action: "fill"; selector: string; value: string }
  | { id: string; action: "waitForSelector"; selector: string }
  | { id: string; action: "screenshot" }
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
      type: "element_text";
      selector: string;
      contains: string;
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

const MAX_STEPS = 30;

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
      "Plan baseUrl must be an http(s) URL pointing at localhost or 127.0.0.1.",
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

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, plan: plan as unknown as ReproductionPlan };
}

function validateStep(value: unknown, index: number): string[] {
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
    case "waitForSelector":
      if (
        !hasOnlyKeys(step, ["id", "action", "selector"]) ||
        typeof step.selector !== "string" ||
        !step.selector
      ) {
        return [`${label} (${step.action}) must have only id, action, and a non-empty selector.`];
      }
      return [];
    case "fill":
      if (
        !hasOnlyKeys(step, ["id", "action", "selector", "value"]) ||
        typeof step.selector !== "string" ||
        !step.selector ||
        typeof step.value !== "string"
      ) {
        return [`${label} (fill) must have only id, action, selector, and a string value.`];
      }
      return [];
    case "screenshot":
      if (!hasOnlyKeys(step, ["id", "action"])) {
        return [`${label} (screenshot) must have only id and action.`];
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
    case "element_text":
      if (
        !hasOnlyKeys(assertion, ["type", "selector", "contains"]) ||
        typeof assertion.selector !== "string" ||
        !assertion.selector ||
        typeof assertion.contains !== "string" ||
        !assertion.contains
      ) {
        return ["element_text assertion must have non-empty selector and contains strings."];
      }
      return [];
    default:
      return [`Unsupported assertion type ${JSON.stringify(assertion.type)}.`];
  }
}

function isSafeBaseUrl(value: string) {
  try {
    const url = new URL(value);

    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
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
