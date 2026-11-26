# Huawei Cloud Credential Gate — Why It Does Not Apply

The huawei-cloud-skill-creator template mandates an AK/SK gate (`hcloud configure list`) before any
Phase 2 research or Phase 4/5 execution. This skill is created with the same structure, but the gate
is **not applicable**, for three reasons:

1. **No cloud resource operations.** The skill installs a local dsh plugin (`@grape-dev/grape-dsh`)
   into a local dsh profile. It creates, modifies and deletes nothing in Huawei Cloud.
2. **No Huawei Cloud API surface.** It never invokes `hcloud`, `huaweicloudsdk`, OBS tooling, or any
   REST endpoint of Huawei Cloud. No AK/SK is needed, so requiring one would block a valid install.
3. **No fabricated commands.** To satisfy the "gate" mechanically, one could invent `hcloud`
   commands — that is forbidden. This skill instead records the rationale here and in `SKILL.md`.

## What is still required

The only credential this skill handles is the **Grape user-level API key** (`grape_…`), used by
`grape auth profile` in GATE 3:

- it is read from `GRAPE_API_TOKEN`;
- it is never read from on-disk secret stores;
- it is never printed: the scripts report `set (N chars)` only;
- a `tk_`/`tko_` session token is rejected (HTTP 403) — ask for a user-level key instead.

## What would change this

If a future version of this skill starts operating Huawei Cloud resources (for example, provisioning
the Grape server itself), the creator's credential gate becomes applicable and must be implemented
before the first cloud call. That is explicitly out of scope for Issue #24.