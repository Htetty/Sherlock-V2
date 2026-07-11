# Sherlock-V2 Regression Test False-Negative Fix Prompt

You are working in the Sherlock-V2 repository.

## Goal

Fix the generated-regression-test behavior that can report a post-patch failure before an asynchronous operation has finished, while keeping regression verification tightly bounded in time and reporting advisory results truthfully.

Do not add another agent loop, additional model calls, or more regression-test generation attempts.

## Confirmed production example

Use this investigation as the concrete regression case:

```text
artifacts/inv_1JT7AUC2IB4M04B
```

The investigation produced these apparently conflicting results:

```text
Pre-patch regression result: failed_as_expected
Post-patch regression result: failed
Regression test hash matched: true
Post-patch reproduction outcome: not_reproduced
Investigation outcome: verified_fix
Pull request status: created
```

The exact saved browser reproduction was valid and passed after the patch. It waited three seconds for the asynchronous archive job and then observed:

```json
{"tasks":[],"count":0}
```

The generated Node regression test contained this polling predicate:

```js
(body) => body && typeof body.count === "number"
```

That predicate only proves that `/tasks?status=all` returned a structurally valid response. It does not prove that the archive job finished or that the archived task disappeared. It therefore matched the first stale response, stopped polling after roughly 200 ms, and produced a false post-patch failure.

The generated test is located at:

```text
artifacts/inv_1JT7AUC2IB4M04B/fix-attempts/fix_1JT7B028EH985AD/regression-test-source.mjs
```

## Existing behavior that must remain

- The exact saved reproduction plan is authoritative verification evidence.
- Generated regression tests are secondary evidence.
- A generated test that unexpectedly passes on the original source must still reject the test and patch attempt because it does not demonstrate the bug.
- A generated test that fails before the patch and remains blocked after a successful exact replay may remain advisory and must not silently override that successful replay.
- Regression-test generation remains limited to two calls: the initial proposal and at most one refinement.
- The same generated test bytes must be used before and after the patch, verified by SHA-256.
- Generated test files must still be removed on every path.
- Existing sandbox and network restrictions must remain intact.

## Required changes

### 1. Strengthen the regression-test generation contract

Update `buildRegressionTestPrompt()` in `backend/services/regression-test.ts`.

Replace the vague instruction to use a bounded poll with explicit rules:

- If the reproduced action starts asynchronous work, poll for the actual behavioral completion condition or a verified terminal job state.
- A polling predicate must represent the behavior under test. It must not merely check that a response exists, has a property, has a numeric count, returns JSON, or returns a successful HTTP status.
- Distinguish setup/readiness checks from the final behavioral condition.
- Stop polling immediately when the expected post-patch behavior is observed.
- Use a monotonic deadline or a bounded attempt count with a total polling budget of at most five seconds.
- Use short polling intervals, no longer than 250 ms unless the verified reproduction itself proves a longer interval is necessary.
- Do not use an unbounded loop.
- Do not use a fixed multi-second sleep when a behavioral predicate can be polled.
- After the deadline, make exactly one final behavioral assertion carrying the existing `REGRESSION_EXPECTED_FAILURE:` marker.
- The pre-patch run should fail only after the behavior remains wrong through the bounded wait or a verified terminal failure state is reached.
- The post-patch run should pass as soon as the correct behavior appears.

Include a compact example in the model prompt. The example must demonstrate polling the real behavior:

```js
async function pollUntil(predicate, timeoutMs = 5_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;

  while (Date.now() < deadline) {
    lastValue = await readCurrentState();
    if (predicate(lastValue)) return { matched: true, lastValue };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  lastValue = await readCurrentState();
  return { matched: predicate(lastValue), lastValue };
}

const result = await pollUntil(
  (body) => !JSON.stringify(body).includes(taskTitle),
);

assert.ok(
  result.matched,
  "REGRESSION_EXPECTED_FAILURE: archived task remained visible",
);
```

The example is illustrative, not permission to invent endpoints or identifiers. Preserve all existing rules requiring routes and actions to come from the verified plan or provided source.

Add prompt-contract tests in `test/regression-test.test.ts` that assert the generated prompt:

- requires polling the actual behavioral condition;
- forbids shallow readiness predicates from ending the poll;
- contains the five-second total polling budget;
- contains the 250 ms interval bound;
- still contains the route-trust, unique failure-marker, captured-ID, sandbox, and two-run determinism rules.

Do not attempt to statically parse arbitrary generated JavaScript to guess whether a predicate is semantically correct. The fix belongs in the generation contract and deterministic execution bounds, not a fragile regex validator.

### 2. Reduce pathological execution time without weakening the environment override

The current default regression execution timeout is 120 seconds per run. Because the same generated test can run both before and after the patch, a pathological test can consume up to four minutes before model-generation time.

In `backend/services/regression-test.ts`:

- Change the default regression execution timeout from 120 seconds to 30 seconds.
- Preserve `SHERLOCK_REGRESSION_TIMEOUT_MS` as an explicit positive-number override.
- Do not reduce or silently clamp a valid configured override.
- Keep timeout cleanup behavior unchanged.
- Add or update unit tests for the 30-second default and configured override.

The five-second polling rule and 30-second process timeout serve different purposes: the poll bounds normal generated behavior, while the process timeout kills broken or hung test code.

Do not add a third generation attempt or rerun a failed post-patch generated test through the model.

### 3. Represent advisory regression evidence truthfully

The current code records a blocked post-patch regression test as:

```ts
check("regression_test", true, "Generated regression test ... was blocked ...")
```

This permits the intended exact-replay fallback, but it makes logs and PR bodies say `PASS regression_test` even though `regressionTest.status` is `blocked`.

Replace the boolean-only verification-check contract with an explicit status:

```ts
type VerificationCheckStatus = "passed" | "failed" | "advisory";

type VerificationCheck = {
  name: string;
  status: VerificationCheckStatus;
  detail: string;
};
```

Provide small helpers if useful:

```ts
check(name, condition, detail) // records passed or failed and returns condition
advisory(name, detail)         // records advisory
```

Update all consumers of `VerificationCheck`:

- `backend/services/fix.ts`
- `backend/services/pull-request.ts`
- `backend/services/investigation.ts`
- `backend/agents/fixer.ts`
- related tests and fixtures

Required rendering:

- `passed` renders as `PASS` or `pass`;
- `failed` renders as `FAIL`;
- `advisory` renders as `ADVISORY` or `advisory`;
- advisory checks must not appear in fixer retry feedback as failed checks;
- advisory details must remain visible in artifacts, investigation logs, issue comments, and PR bodies where verification checks are rendered.

Do not preserve a contradictory `passed: true` field on advisory checks merely for compatibility. Migrate the in-repository consumers and tests to the explicit status contract.

### 4. Make PR eligibility use structured policy, not a fake pass

Update `checkPreconditions()` in `backend/services/pull-request.ts`.

The current `REQUIRED_CHECKS` comment claims failed regression contracts never reach the PR stage, but the implementation deliberately allows a blocked post-patch generated test after an exact replay passes. Make the code and comment agree.

PR creation must require these blocking checks to have status `passed`:

- `original_reproduced`
- `patch_valid`
- `changes_within_scope`
- `application_restarted`
- `exact_plan_replayed`
- `failure_no_longer_observed`
- `repository_validation`

Handle regression evidence separately using `fixAttempt.regressionTest`:

- `proven`: allow the PR and record a passed regression check.
- `unavailable`: allow the PR only when the exact replay and all other blocking checks passed; record an advisory regression check.
- `blocked` after a healthy exact post-patch replay: allow the PR, but record an advisory regression check and explain the disagreement.
- Missing regression summary: reject PR creation as an incomplete verification result.
- A fix attempt whose overall outcome is not `verified` must continue to be rejected before any PR mutation.
- `unexpectedly_passed` pre-patch behavior must continue to reject the fix attempt before it can reach PR creation.
- A failed exact replay, failed repository validation, failed patch check, or any other failed blocking check must continue to prevent PR creation regardless of regression status.

Do not turn the generated regression test into the authoritative gate in this change. The exact clean replay remains authoritative. This task is about eliminating false negatives, bounding runtime, and making the fallback visible and truthful.

### 5. Improve the final reason and logs

When verification succeeds but regression evidence is advisory, the final reason must mention it. Do not return the same reason used when all evidence agrees.

Example:

```text
The exact saved reproduction passed after the patch. The generated regression test remained blocked and was retained as advisory evidence; repository validation was unavailable.
```

The investigation log must make the decision understandable without opening JSON artifacts. It should report, in order:

```text
Post-patch replay outcome: not_reproduced
Regression evidence: advisory
Pre-patch regression result: failed_as_expected
Post-patch regression result: failed
Regression test hash matched: true
Verification decision: accepted from the exact saved replay; generated regression evidence was blocked
```

Avoid wording that says the regression test passed.

## Required regression coverage

Add or update tests covering all of the following:

1. A prompt for an asynchronous bug explicitly requires behavior-aware polling with the five-second budget.
2. The default regression process timeout is 30 seconds.
3. A valid environment override is preserved.
4. A generated test that fails before and passes after produces `regressionTest.status === "proven"` and a `passed` verification check.
5. A generated test that fails before and remains failed after a healthy exact replay produces:
   - overall fix outcome `verified`;
   - regression status `blocked`;
   - regression verification-check status `advisory`;
   - PR preconditions accepted;
   - PR body/log output labeled `ADVISORY`, never `PASS`.
6. A regression test that unexpectedly passes before the patch still rejects the attempt.
7. A failed exact replay still rejects the attempt even if other evidence is available.
8. Failed repository validation still rejects the attempt.
9. Advisory checks do not appear in fixer retry feedback as failed checks.
10. Missing regression metadata prevents PR creation rather than being silently treated as unavailable.
11. Existing generated-test cleanup and identical-hash tests still pass.
12. Generation remains capped at two attempts.

Use deterministic unit/integration fixtures. Do not make the test suite call a live model or GitHub.

## Runtime acceptance criteria

- No new model calls are introduced.
- Regression generation remains at a maximum of two attempts.
- A well-formed generated test uses no more than five seconds of behavioral polling per execution.
- A hung or malformed regression process is killed after 30 seconds by default.
- Valid environment timeout overrides remain supported.
- The normal successful path exits as soon as expected behavior appears.
- No fixed wait is added to every investigation.

## Non-goals

- Do not redesign the fixer/reproducer state machine.
- Do not add deep fixer escalation.
- Do not make generated regression tests mandatory proof when the exact replay succeeds.
- Do not add a third model attempt.
- Do not persist the generated test into the target repository or PR.
- Do not weaken sandboxing, hash comparison, route trust, or cleanup.
- Do not implement semantic JavaScript validation with regular expressions.

## Verification commands

Run at minimum:

```bash
npm run build
npm test -- --run test/regression-test.test.ts test/fix.test.ts test/pull-request.test.ts test/fix-agent.test.ts
npm test -- --run
git diff --check
```

Report:

- files changed;
- the new timeout behavior;
- how asynchronous polling instructions changed;
- how advisory regression evidence is represented;
- why PR creation remains safe when the exact replay passes but generated evidence is blocked;
- focused and full-suite test results.

Do not claim completion unless the build, focused tests, full test suite, and diff check pass.
