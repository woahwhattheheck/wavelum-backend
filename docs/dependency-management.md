# Dependency management

This repository intentionally has two Node.js package roots:

- `/` — the root services, workers, NestJS application, migrations, and shared tooling.
- `/backend` — the vesting-vault Express backend and its test/E2E tooling.

They are independent install surfaces. Each package root owns its own `package.json` and npm v3 `package-lock.json`; dependency changes must update the lockfile beside that manifest. Do not copy dependencies between the two manifests just to make one install command cover both applications.

## Reproducible installs

Use `npm ci` rather than `npm install` for normal CI and release installs:

```bash
npm ci
npm --prefix backend ci
```

The root package carries `.npmrc` with `legacy-peer-deps=true`. This is an explicit compatibility policy for the current inherited graph: `express@5` coexists with legacy `apollo-server-express@3`, whose published peer range is Express 4. The setting preserves the existing dependency choices while making the lockfile reproducible. It is not a claim that the peer mismatch is resolved; remove the setting when the legacy Apollo integration is migrated or removed.

The dependency-audit CI job uses `--ignore-scripts` because its purpose is lock/install validation rather than application builds. Existing application jobs continue to perform their normal installs and validations.

## Direct version-range policy

Direct npm registry dependencies and devDependencies use caret semver ranges (for example, `^4.8.3`). Exact pins are exceptional: if an incompatibility or incident requires one, add the package to `exactPinAllowlist` in `scripts/dependency-audit.cjs` and explain the reason in the pull request.

Git, file, wildcard, tag, and unbounded direct dependency specs are rejected by the validator unless the policy is deliberately changed.

## CI checks

`scripts/dependency-audit.cjs validate` checks both package roots before the quality gate:

1. both lockfiles are npm lockfile v3 files;
2. each lockfile's root dependency and devDependency maps exactly match its sibling `package.json`;
3. direct version ranges follow the caret/exact-pin policy.

The `dependency-audit` workflow job then runs deterministic `npm ci --ignore-scripts` installs in both package roots. A manifest/lock mismatch or un-installable locked graph fails the job and therefore blocks the green-light gate.

The same job also reports:

- total locked package count and direct dependency counts;
- missing license metadata;
- GPL/AGPL license metadata discovered in either lockfile;
- current `npm outdated --json` counts for both package roots.

GPL/AGPL and outdated-package findings are intentionally informational, matching the campaign requirement: they are surfaced in the GitHub Actions summary without turning a licensing or freshness observation into an automatic policy decision.
