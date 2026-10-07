# GraphQL Query Protection: Depth and Cost Limits

The GraphQL endpoint validates every incoming operation before execution.
Two limits apply, implemented in `src/graphql/middleware/queryGuards.js`
and wired into Apollo Server via `validationRules`.

## Depth limit

An operation may nest at most **7 levels** of fields, counted from the
operation root. Fragment spreads and inline fragments are resolved when
counting, so fragments cannot be used to hide depth. Recursive fragment
cycles are rejected. Rejected operations return
`Operation <name> exceeds the maximum query depth of 7`.

## Cost limit

An operation's estimated cost must not exceed **1000 points**:

- Every field costs 1 point by default.
- Numeric list-size arguments (`first`, `last`, `limit`, `take`,
  `pageSize`) multiply the cost of that field's whole subtree — e.g.
  `users(first: 600) { name posts { title } }` costs
  `(1 + 1 + (1 + 1)) * 600 = 2400`.
- Field-level overrides can be registered in the `fieldCosts` map passed
  to `costLimitRule` for fields that are disproportionately expensive.
- Fragment spreads count their cost at each usage site; recursive cycles
  are rejected.

Rejected operations return
`Operation <name> exceeds the maximum query cost of 1000`.

## Rate limiting

Per-field rate limiting already applies through
`middleware/rateLimit.js` (`adaptiveRateLimitMiddleware`): tiered budgets
for unauthenticated (50/15 min), user (200/15 min) and admin
(1000/15 min) traffic, with stricter tiers on expensive operations.
The depth/cost rules above run at validation time, before any resolver —
including rate-limit middleware — executes.
