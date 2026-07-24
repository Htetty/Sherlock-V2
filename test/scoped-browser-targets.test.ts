import { afterEach, describe, expect, test } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  isDomTargetIntent,
  validateReproductionPlan,
} from "../backend/services/plan.js";
import {
  buildPageSnapshot,
  resolveTarget,
} from "../backend/services/playwright.js";

let browser: Browser | null = null;

afterEach(async () => {
  await browser?.close();
  browser = null;
});

describe("scoped browser targets", () => {
  test("validates a control scoped to a specific task row", () => {
    const target = {
      role: "button",
      name: "✕",
      within: {
        role: "listitem",
        text: "Set up CI pipeline",
      },
    };

    expect(isDomTargetIntent(target)).toBe(true);
    expect(
      validateReproductionPlan({
        version: 1,
        baseUrl: "http://localhost:3000",
        steps: [{ id: "delete-task", action: "click", target }],
        expectedBehavior: "Only the selected task is deleted.",
        failureCondition: "Deleting the task moves notes to another task.",
        assertion: {
          type: "page_text",
          contains: "Remember auth",
          failureWhen: "present",
        },
      }).ok,
    ).toBe(true);
  });

  test("resolves the duplicate delete button inside the named row", async () => {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <ul>
        <li>Design landing page <button data-task="design">✕</button></li>
        <li>Set up CI pipeline <button data-task="ci">✕</button></li>
        <li>Write API docs <button data-task="docs">✕</button></li>
      </ul>
    `);

    const locator = resolveTarget(page, {
      role: "button",
      name: "✕",
      within: {
        role: "listitem",
        text: "Set up CI pipeline",
      },
    });

    expect(await locator.count()).toBe(1);
    expect(await locator.getAttribute("data-task")).toBe("ci");
  });
});

describe("live input values", () => {
  test("read_page snapshots include current non-secret form values", async () => {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(`
      <label>Notes for Write API docs
        <input value="Remember to include auth section">
      </label>
      <label>Password
        <input type="password" value="do-not-expose">
      </label>
    `);

    const snapshot = await buildPageSnapshot(page);
    const digest = snapshot.elements.join("\n");

    expect(digest).toContain('value="Remember to include auth section"');
    expect(digest).not.toContain("do-not-expose");
  });
});
