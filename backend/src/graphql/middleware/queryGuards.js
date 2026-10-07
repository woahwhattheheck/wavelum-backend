/**
 * GraphQL query guards: depth limiting and cost analysis as Apollo Server
 * `validationRules` (graphql-js validation-rule factories).
 *
 * Zero-dependency: implemented directly on the vendored `graphql` package
 * rather than graphql-depth-limit (unmaintained since 2019) or
 * graphql-query-complexity (field extensions model does not match this
 * schema). Behavior contract matches issue #5: reject queries nested
 * deeper than the limit, and reject queries whose estimated cost exceeds
 * the budget.
 *
 * Cost model (see docs/graphql/QUERY_COST_MODEL.md):
 *   - every field costs `defaultCost` (1) unless overridden in `fieldCosts`
 *   - numeric list-size args (`first`, `last`, `limit`, `take`, `pageSize`)
 *     multiply the cost of that field's subtree
 *   - fragment spreads and inline fragments are resolved into the
 *     operation; recursive fragment cycles are rejected outright
 */
const { GraphQLError, Kind } = require('graphql');

const LIST_SIZE_ARGS = new Set(['first', 'last', 'limit', 'take', 'pageSize']);

function selectionsDepth(selectionSet, fragments, stack, depth) {
  let max = depth;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const childDepth = depth + 1;
      if (childDepth > max) max = childDepth;
      if (selection.selectionSet) {
        const sub = selectionsDepth(selection.selectionSet, fragments, stack, childDepth);
        if (sub > max) max = sub;
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const sub = selectionsDepth(selection.selectionSet, fragments, stack, depth);
      if (sub > max) max = sub;
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (stack.includes(name)) return Number.MAX_SAFE_INTEGER;
      const fragment = fragments[name];
      if (!fragment) continue;
      const sub = selectionsDepth(fragment.selectionSet, fragments, [...stack, name], depth);
      if (sub > max) max = sub;
    }
    if (max === Number.MAX_SAFE_INTEGER) return max;
  }
  return max;
}

/**
 * Apollo `validationRules` entry: rejects operations whose selection depth
 * exceeds `maxDepth` (counted per operation; fragment spreads resolve
 * through the document). Depth 1 = a top-level field of the operation.
 */
function depthLimitRule(maxDepth) {
  return (context) => ({
    OperationDefinition(node) {
      const fragments = {};
      for (const def of context.getDocument().definitions) {
        if (def.kind === Kind.FRAGMENT_DEFINITION) fragments[def.name.value] = def;
      }
      const depth = selectionsDepth(node.selectionSet, fragments, [node.name ? node.name.value : null], 0);
      if (depth > maxDepth) {
        const label = node.name ? `"${node.name.value}"` : 'anonymous';
        context.reportError(
          new GraphQLError(
            `Operation ${label} exceeds the maximum query depth of ${maxDepth} (depth: ${depth}).`,
            [node]
          )
        );
      }
    }
  });
}

function argMultiplier(fieldNode) {
  let multiplier = 1;
  for (const arg of fieldNode.arguments || []) {
    if (LIST_SIZE_ARGS.has(arg.name.value) && arg.value.kind === Kind.INT) {
      const n = parseInt(arg.value.value, 10);
      if (Number.isFinite(n) && n > multiplier) multiplier = n;
    }
  }
  return multiplier;
}

function selectionsCost(selectionSet, fragments, stack, fieldCosts, defaultCost) {
  let cost = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const fieldCost = fieldCosts[selection.name.value] ?? defaultCost;
      let sub = fieldCost;
      if (selection.selectionSet) {
        sub += selectionsCost(selection.selectionSet, fragments, stack, fieldCosts, defaultCost);
      }
      cost += sub * argMultiplier(selection);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      cost += selectionsCost(selection.selectionSet, fragments, stack, fieldCosts, defaultCost);
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (stack.includes(name)) return Number.MAX_SAFE_INTEGER;
      const fragment = fragments[name];
      if (!fragment) continue;
      cost += selectionsCost(fragment.selectionSet, fragments, [...stack, name], fieldCosts, defaultCost);
    }
    if (cost === Number.MAX_SAFE_INTEGER) return cost;
  }
  return cost;
}

/**
 * Apollo `validationRules` entry: rejects operations whose estimated cost
 * exceeds `maxCost`. `fieldCosts` maps field names to per-field costs;
 * every other field defaults to `defaultCost`.
 */
function costLimitRule({ maxCost, fieldCosts = {}, defaultCost = 1 }) {
  return (context) => ({
    OperationDefinition(node) {
      const fragments = {};
      for (const def of context.getDocument().definitions) {
        if (def.kind === Kind.FRAGMENT_DEFINITION) fragments[def.name.value] = def;
      }
      const cost = selectionsCost(node.selectionSet, fragments, [node.name ? node.name.value : null], fieldCosts, defaultCost);
      if (cost > maxCost) {
        const label = node.name ? `"${node.name.value}"` : 'anonymous';
        context.reportError(
          new GraphQLError(
            `Operation ${label} exceeds the maximum query cost of ${maxCost} (estimated cost: ${cost}).`,
            [node]
          )
        );
      }
    }
  });
}

module.exports = { depthLimitRule, costLimitRule };
