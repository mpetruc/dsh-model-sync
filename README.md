# dsh-model-sync

Automatically pre-populate the Settings → Models list from each configured
llm-pi-ai provider's own model listing (`GET {baseURL}/models` for
OpenAI-compatible routes, the installed catalog for catalog routes), so the
model dropdown shows the provider's full model list without hand-entry.

## What it does

- Reads the `llm-pi-ai` settings section and, for every provider with a
  `baseURL` (or only the ones listed in `config.providers`), asks the llm
  service to discover the provider's advertised models.
- Merges ids that are not yet configured into the provider's `models` array,
  preserving existing entries — ids, order, and any manually entered
  capacities (`contextWindow`, `maxTokens`, `input`, `reasoningEfforts`,
  `compat`) are never overwritten.
- Writes the section back only when something changed.

## Configuration

The bundle inserts a `model-sync` row:

```yaml
- id: model-sync
  name: dsh-model-sync
  config:
    intervalMinutes: 0   # 0 = once at boot; N = also repeat every N minutes
    # providers: [amd-server]   # optional: restrict which providers to sync
```

## Notes

- Discovery goes through the llm service's `discoverModels('llm-pi-ai', …)`,
  the same code the Settings → Models "Fetch models" button uses.
- A provider whose endpoint is down is skipped with a warning; the plugin
  never fails the row over a discovery error.
