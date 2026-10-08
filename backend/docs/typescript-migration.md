# TypeScript strict-mode migration (#42)

The backend contains **11 tracked first-party TypeScript files** plus hundreds of legacy JavaScript files. This change makes strict TypeScript checks explicit and puts a blocking `npm run typecheck` step in the **lint stage**. It does **not** certify the old JavaScript files as type-safe, and the compiler must actually pass before this can be considered complete.

## Projects and commands

- The root `tsconfig.json` references the backend project for IDE/build-tool discovery.
- `backend/tsconfig.json` opts into `strict: true` and includes all `backend/src/**/*.ts` files, including the existing TypeScript test utilities. It excludes generated `dist` and dependency directories, not application code.
- Run `cd backend && npm ci && npm run typecheck` for the focused no-emit compiler check. No test suites are needed for a configuration-only validation.
- The workflow's lint job runs `typecheck` as a blocking command, and on pull requests compares newly added `backend/src/**/*.js` files with the base commit to require at least one *typed* JSDoc tag.

## JavaScript compatibility and migration

Legacy JavaScript remains runtime JS. The strict TypeScript project deliberately sets `allowJs: false`; this is **not** a claim that hundreds of existing JS files satisfy `checkJs`. New JS must carry typed `@param`, `@returns`, `@typedef`, `@type`, `@template`, or `@implements` JSDoc. Prefer new TypeScript for critical Express boundaries.

Migrate by subsystem: authentication/request principal → Express route inputs and validation → service return types → Soroban/worker boundary objects. Convert one critical module at a time to TypeScript while keeping the deployed CommonJS module path stable, and include that module in the strict compiler project. For existing JS, add typed JSDoc before considering `checkJs` adoption. Track unresolved compiler errors and missing third-party declarations; never bypass errors with an unexplained exclusion, `// @ts-nocheck`, or broad ambient `any` modules.

## Verification and acceptance status

A committed strict config and a configured CI gate are **not evidence of a green compiler**. Run the exact focused `npm run typecheck` against installed locked dependencies, fix all diagnostics, and verify the lint job before marking issue #42 accepted. The remaining 348-ish JavaScript files require staged coverage, and critical Express-to-TS migration is explicitly still outstanding. GrantFox reward eligibility is conditional on sponsor review.
