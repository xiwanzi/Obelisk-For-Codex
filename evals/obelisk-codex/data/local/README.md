# Local Lane

`items.local.jsonl` is intentionally empty at first. Local reality ground truth depends on private user history and should be curated by a human.

The automated runner still performs a privacy-preserving smoke check against real `~/.codex` when available:

- counts are saved;
- session ids, project paths, file paths, and workflow ids are hashed;
- no raw snippets, titles, tool output, private code, or original JSONL lines are written to reports.
