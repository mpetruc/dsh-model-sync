# dsh-model-sync

Mirror each configured llm-pi-ai provider's advertised model list into the
Settings → Models section, so the model dropdown shows the provider's full
model list without hand-entry. Discovery goes through the llm service's
`discoverModels('llm-pi-ai', …)` — `GET {baseURL}/models` for
OpenAI-compatible routes, the installed catalog for catalog routes.

## Sync rules

- **Adds** — discovered ids that are not configured yet are appended with an
  `owner: 'model-sync'` marker (plus `name` / `contextWindow` / `maxTokens` /
  `input` metadata when the listing reports them). Hand-entered entries carry
  no `owner`; existing entries are never rewritten — ids, order, and any
  hand-entered capacities survive every sync.
- **Prune** (`prune: true`) — entries marked `owner: 'model-sync'` that are
  no longer advertised are removed. Hand-entered entries are never pruned.
- **Rejected** — when an owned id that is still advertised disappears between
  two syncs, it is treated as a deliberate deletion, remembered in the
  `model-sync` settings namespace, and not re-added. Manually re-adding a
  rejected id clears the rejection.

Provenance for pruning rides on the per-entry `owner` marker (single source —
no duplicated model list). Only the small per-provider `rejected` id lists
live in the `model-sync` namespace, because a deleted entry's marker is gone
with it. Entries configured before this version have no owner and count as
hand-entered; clearing the provider's `models` list once and letting the
plugin rebuild it gives every entry full tracking.

## Configuration

The bundle inserts a `model-sync` row:

```yaml
- id: model-sync
  name: dsh-model-sync
  config:
    intervalMinutes: 0   # 0 = once at boot; N = also repeat every N minutes
    #     NB: a positive interval also enables deletion detection (rejected)
    prune: false         # true = remove auto-added ids no longer advertised
    # providers: [amd-server]   # optional: restrict which providers to sync
```

The first sync runs ~1.5 s after the `llm`/`settings` services are ready; a
positive `intervalMinutes` repeats it on that cadence. Namespaces are written
only when something changed.

## Notes

- A provider whose endpoint is down is skipped with a warning; a discovery
  error never fails the row.
