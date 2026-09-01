# DSH Compatibility Evidence — Logic Probe

Evidence for the DSH STORE fixed-Commit contract: per-release install / start /
uninstall verification of this plugin's native dsh bundle against the DSH
releases listed in `dsh.compatibility.dshReleases` (same author-remediation
track as [AI-Scarlett/DSH-Store#251](https://github.com/AI-Scarlett/DSH-Store/issues/251)).

## Environment

| Item | Value |
|---|---|
| Host | Windows 11 (x64), build 19045 |
| Node.js | v24.17.0 |
| npm | 11.13.0 |
| pnpm | 11.21.0 |
| Test date | 2026-09-01 |
| Package under test | `dsh-logicprobe` 0.5.5 (bundle patch `cordis.patch.yml`, entry id `logicprobe`) |

## Method (one disposable profile per version)

Each DSH release was installed into its own runtime directory and tested with a
fresh `DSH_HOME` so no state leaked between versions:

```bash
# 1) install: fresh profile, plugin added as a file: dependency
dsh plugin --profile lp add "file:<this-repo>"            # pnpm add succeeds

# 2) mount check: composed tree contains the plugin row, enabled
dsh --profile lp --dump-config                             # id: logicprobe / enabled: true

# 3) start: headless boot with a deliberately invalid API key.
#    Expected: tree mounts and the app reaches the model-provider stage,
#    failing only with AUTH for the fake key; no plugin load errors.
DEEPSEEK_API_KEY=fake-key-for-boot-test dsh --profile headless "reply OK"

# 4) uninstall: plugin removed, row gone from the composed tree
dsh plugin --profile lp remove dsh-logicprobe
dsh --profile lp --dump-config                             # no logicprobe row
```

The headless `AUTH` rejection proves the profile booted with the plugin applied
(any bundle apply error would surface before the provider call). End-to-end
model calls were not exercised (no real provider key used).

## Results

| dsh release | install | dump-config row | start (headless boot) | uninstall |
|---|---:|---:|---:|---:|
| 0.1.0-rc.7 | pass | pass | pass (AUTH-only) | pass |
| 0.1.0-rc.8 | pass | pass | pass (AUTH-only) | pass |
| 0.1.1-rc.1 | pass | pass | pass (AUTH-only) | pass |
| 0.1.1-rc.2 | pass | pass | pass (AUTH-only) | pass |
| 0.1.2-alpha.2 | pass | pass | pass (AUTH-only) | pass |
| 0.1.2-alpha.3 | pass | pass | pass (AUTH-only) | pass |

## Declared compatibility (package.json)

```json
"engines": { "node": ">=20" },
"dsh": {
  "engines": { "dsh": ">=0.1.0-rc.7" },
  "compatibility": {
    "dsh": "^0.1.0-rc.7 || ^0.1.1-rc.1 || ^0.1.2-alpha.2 || ^0.1.2-alpha.3",
    "dshReleases": {
      "0.1.0-rc.7": "compatible",
      "0.1.0-rc.8": "compatible",
      "0.1.1-rc.1": "compatible",
      "0.1.1-rc.2": "compatible",
      "0.1.2-alpha.2": "compatible",
      "0.1.2-alpha.3": "compatible"
    },
    "profiles": ["headless"]
  }
}
```

## Notes

- `dsh.engines.dsh` was relaxed from `>=0.1.1-rc.1` to `>=0.1.0-rc.7` to match
  the verified rc.7 result.
- Windows-only evidence; other platforms were not exercised.
