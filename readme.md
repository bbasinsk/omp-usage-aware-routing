# OMP usage-aware routing

An [OMP](https://omp.sh/) plugin that gives the assistant live quota context when it chooses subagent models.

Balanced routing weighs task suitability and quota pressure together. It does not force a weaker model because its quota is healthier.

## Install

1. Preview the GitHub installation:

   ```sh
   omp plugin install --dry-run 'github:bbasinsk/omp-usage-aware-routing'
   ```

2. Install the plugin:

   ```sh
   omp plugin install 'github:bbasinsk/omp-usage-aware-routing'
   ```

3. Start a new OMP session to load the extension.

For a reproducible installation, pin the release tag:

```sh
omp plugin install 'github:bbasinsk/omp-usage-aware-routing#v1.0.0'
```

Git installations use OMP's user plugin directory. They do not support project scope.

If you already load `usage-aware-routing.ts` as a loose extension, disable or move that copy before loading this plugin.
Do not load both copies.

## Requirements

- OMP with plugin support, `omp usage --json`, and the task discovery module.
- Authenticated providers that expose subscription quota data through OMP.
- The `task` tool enabled for prompt guidance.

The plugin uses your existing agents and model roles. It does not install agents, assign models, or add provider credentials.
OMP runs the TypeScript entry directly. No build step or additional runtime dependency is required.

## Strategies

Use these commands inside an OMP session:

```text
/quota-strategy
/quota-strategy balanced
/quota-strategy targeted
/quota-strategy targeted anthropic
/quota-strategy targeted openai-codex
```

The first command shows the current strategy. `targeted` without a provider opens a provider picker.
Provider names come from available usage data. The default strategy is `balanced`.

### Balanced

- Prefer healthier quota routes for routine work when expected results are comparable.
- Prefer the stronger-fitting model when it improves correctness, judgment, completeness, or reduces rework.
- Do not downgrade solely because another route has a lower deficit or appears earlier in the quota order.
- Do not choose a stronger model without a task-specific benefit.

Quota rankings are advisory. Balanced mode does not reject task calls because of quota pressure.
It leaves provider availability and exhaustion handling to OMP.

### Targeted

Prefer eligible models from the selected provider, including models behind their expected usage pace.
The task guard rejects off-target selections when target-provider candidates exist.

A target route reaches its reserve when an applicable window has 10% or less remaining, or a non-OK status.
Saved reset credits permit continued target preference. The extension does not redeem those credits.

The assistant can bypass targeted routing for required specialization or an explicit model request with this task marker:

```text
[quota-route-exception: required specialization]
```

The guard cannot assess task suitability. The assistant must choose a capable agent or explain the specialization exception.

## Quota context

The extension reads quota data through `omp usage --json` and shares a disk cache across sessions.
It refreshes snapshots after 30 minutes or when a reported window resets.
If refresh fails, it keeps the previous snapshot. Without a snapshot, it adds no quota guidance.

Prompt context includes remaining quota, reset times, usage pace, saved reset credits, and resolved agent quota rankings.
Pace compares remaining quota with the fraction of the quota window still remaining.

Provider-wide windows apply to every matching model. Model-specific and tier-specific windows also apply to their matching models.
Codex Chat and Spark meters remain separate.

## Local state

| File | Purpose | Environment override |
| --- | --- | --- |
| `~/.omp/cache/usage-routing.json` | Shared quota snapshot | `OMP_USAGE_ROUTING_CACHE` |
| `~/.omp/cache/usage-routing-strategy.json` | Strategy shared across sessions | `OMP_USAGE_ROUTING_STRATEGY` |

Changing or uninstalling the plugin does not delete these files.

## Trust

OMP plugins run with OMP's filesystem and process permissions. They are not sandboxed.
This plugin runs the OMP usage command, reads agent definitions, and writes quota and strategy files.
The normalized cache excludes account identifiers and credentials. OMP handles provider authentication and usage requests.

## Update or remove

Reinstall the Git source to get its current default branch, then restart OMP:

```sh
omp plugin install 'github:bbasinsk/omp-usage-aware-routing'
```

Remove the plugin by package name, then restart OMP:

```sh
omp plugin uninstall omp-usage-aware-routing
```

## Development

Run the regression suite with [Bun](https://bun.sh/):

```sh
bun test
```

Load the package for a development session:

```sh
omp --extension .
```

See OMP's [plugin documentation](https://omp.sh/docs/plugins) and [extension authoring guide](https://omp.sh/docs/extension-authoring).
