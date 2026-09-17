# MVP closure fixes

- Persist settings before activating them. Create the data directory on first save and surface disk failures.
- Parse conversation PATCH responses and import the API in the archive handler.
- Regenerate only the latest assistant message. Reuse the original user message, evidence and selected skills. Preserve the old answer until success and reject stale targets.
- Store imported conclusions as pending memory candidates. Preserve existing confirmed memories during reanalysis. Report candidate capacity failures in job warnings.
- Stop executing tools after STOP or ASK_USER, supply skipped results for remaining tool call IDs, and request a final answer with tools disabled.

Verification covers first-save persistence, failed saves, successful and failed regeneration, both stop strategies, import candidates, and frontend request contracts. No real model traffic is required by these regression checks.
