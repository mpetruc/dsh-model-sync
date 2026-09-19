# dsh-model-sync

Mirror each configured llm-pi-ai provider's advertised model list into the
Settings → Models section, so the model dropdown shows the provider's full
model list without hand-entry. Discovery goes through the llm service's
`discoverModels('llm-pi-ai', …)` — `GET {baseURL}/models` for
OpenAI-compatible routes, the installed catalog for catalog routes.

## Sync rules

- **Adds** — discovered ids that are not configured yet are appended (with
  `name` / `contextWindow` / `maxTokens` / `input` metadata when the listing
  reports them). Existing entries are never rewritten: ids, order, and any
  hand-entered capacities (`contextWindow`, `maxTokens`, `input`,
  `reasoningEfforts`, `compat`) survive every sync.
- **Prune** (`prune: true`) — ids the plugin previously auto-added that are
  no longer advertised are removed. Hand-entered entries are never pruned.
- **Rejected** — a tracked id that is still advertised but disappears from
  the configured list is treated as a deliberate deletion, remembered, and
  not re-added. Manually re-adding a rejected id clears the rejection.

Provenance lives in the `model-sync` settings namespace
(`providers.<name>.added` / `.rejected`). Entries configured before this
version have no provenance and count as hand-entered; clearing the provider's
`models` list once and letting the plugin rebuild it gives every entry full
tracking.

## Configuration

The bundle inserts a `model-sync` row:

```yaml
- id: model-sync
  name: dsh-model-sync
  config:
    intervalMinutes: 0   # 0 = once at boot; N = also repeat every N minutes
    prune: false         # true = remove auto-added ids no longer advertised
    # providers: [amd-server]   # optional: restrict which providers to sync
```

The first sync runs ~1.5 s after the `llm`/`settings` services are ready; a
positive `intervalMinutes` repeats it on that cadence. Namespaces are written
only when something changed.

## Notes

- A provider whose endpoint is down is skipped with a warning; a discovery
  error never fails the row.
