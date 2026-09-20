# dsh-model-sync

Mirror each configured llm-pi-ai provider's advertised model list into the
Settings → Models section, so the model dropdown shows the provider's full
model list without hand-entry. Discovery goes through the llm service's
`discoverModels('llm-pi-ai', …)` — `GET {baseURL}/models` for
OpenAI-compatible routes, the installed catalog for catalog routes.

## Manual sync

Every activation of the plugin runs one sync pass: the first boot, and any
manual re-enable. To refresh the model lists on demand, open the Plugins page
(sidebar → Plugins), expand the `dsh-model-sync` card, and flick the
`model-sync` row's switch off, then on again — the re-enable restarts the
plugin, so the pass runs ~1.5 s later and re-reads every provider's
advertised list. The settings section is written only when a sync changed at
least one provider's models.

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
  rejected id clears the rejection. Detection diffs *consecutive* syncs within
  one activation, so a manual re-enable never triggers it — the re-enable
  resets the in-memory baseline, and a single activation sync re-adds a
  deleted id. Deletion detection stays live only with a positive
  `intervalMinutes`.

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
    intervalMinutes: 0   # 0 = once per activation (boot or re-enable);
                         # N = also repeat every N minutes
    #     NB: a positive interval also enables deletion detection (rejected)
    prune: false         # true = remove auto-added ids no longer advertised
    # providers: [amd-server]   # optional: restrict which providers to sync
```

Every activation — first boot or a manual re-enable from the Plugins page —
runs one sync ~1.5 s after the `llm`/`settings` services are ready; a positive
`intervalMinutes` repeats it on that cadence.

## Notes

- A provider whose endpoint is down is skipped with a warning; a discovery
  error never fails the row.
- Every pass logs its trigger — `[dsh-model-sync] activation sync: …` for
  boot/re-enable, `… interval sync: …` for the repeating timer — so a manual
  toggle is visible in the host log.
- `npm test` (node:test fake timers) needs Node ≥ 20.4, and ≥ 21.3 to silence
  the `--disable-warning` flag; the plugin itself only requires `engines`'s
  `>=18`.
