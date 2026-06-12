# Obelisk For Codex Evals

This benchmark exercises Obelisk For Codex as a local structured Codex-history query runtime. It intentionally does not create a human session browser, wiki, or natural-language memory store.

Primary command:

```powershell
node evals/obelisk-codex/runners/run-api-eval.mjs --lane all --stage baseline
```

The synthetic lane runs against generated fake HOME directories under `evals/obelisk-codex/.tmp/`. The local lane runs against the user's real `~/.codex` only for redacted smoke metrics.
