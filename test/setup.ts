// Local agent-observation flags are intentionally enabled in .env while the
// feature is being exercised manually. Keep them from silently changing the
// normal behavior expected by the automated test suite.
process.env.SHERLOCK_FORCE_REPRODUCER_AGENT = "false";
process.env.SHERLOCK_FIXER_MIN_INSPECTIONS = "0";
