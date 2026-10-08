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
const { GraphQLError, Kind, valueFromASTUntyped } = require('graphql');

const LIST_SIZE_ARGS = new Set(['first', 'last', 'limit', 'take', 'pageSize']);
const NESTED_PAGINATION_FIELDS = new Set([
  'vestingHistory',
  'claimHistory',
  'searchVestingSchedules',
]);

function selectionsDepth(selectionSet, fragments, stack, depth, memo = new Map(), depthCap = Infinity) {
  let max = depth;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const childDepth = depth + 1;
      if (childDepth > depthCap) return childDepth;
      if (childDepth > max) max = childDepth;
      if (selection.selectionSet) {
        const sub = selectionsDepth(selection.selectionSet, fragments, stack, childDepth, memo, depthCap);
        if (sub > max) max = sub;
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const sub = selectionsDepth(selection.selectionSet, fragments, stack, depth, memo, depthCap);
      if (sub > max) max = sub;
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (stack.includes(name)) return Number.MAX_SAFE_INTEGER;
      const fragment = fragments[name];
      if (!fragment) continue;
      // Each fragment's depth is relative to its spread site and can be
      // reused at any parent depth. Without this memo, an acyclic diamond
      // of fragment spreads expands exponentially before validation finishes.
      if (!memo.has(name)) {
        memo.set(name, selectionsDepth(fragment.selectionSet, fragments, [...stack, name], 0, memo, depthCap));
      }
      const relative = memo.get(name);
      const sub = relative === Number.MAX_SAFE_INTEGER
        ? Number.MAX_SAFE_INTEGER : depth + relative;
      if (sub > depthCap) return sub;
      if (sub > max) max = sub;
    }
    if (max > depthCap) return max;
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
      const depth = selectionsDepth(node.selectionSet, fragments, [node.name ? node.name.value : null], 0, new Map(), maxDepth);
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

function argMultiplier(fieldNode, variables) {
  let multiplier = 1;
  for (const arg of fieldNode.arguments || []) {
    if (!LIST_SIZE_ARGS.has(arg.name.value)) continue;

    let n;
    if (arg.value.kind === Kind.INT) {
      n = Number(arg.value.value);
    } else if (arg.value.kind === Kind.VARIABLE) {
      // Validation-time rules cannot inspect request variables. At request
      // time, reject any missing, invalid, or unbounded list-size variable.
      if (variables === undefined) continue;
      n = variables[arg.value.name.value];
      if (!Number.isSafeInteger(n) || n < 0) return Number.MAX_SAFE_INTEGER;
    } else {
      return Number.MAX_SAFE_INTEGER;
    }

    if (!Number.isSafeInteger(n) || n < 0) return Number.MAX_SAFE_INTEGER;
    if (n > multiplier) multiplier = n;
  }
  return multiplier;
}

function paginationCostMultiplier(fieldNode, variables) {
  if (!NESTED_PAGINATION_FIELDS.has(fieldNode.name.value)) return 1;

  const arg = (fieldNode.arguments || []).find((item) => item.name.value === 'pagination');
  if (!arg) return 1;

  // Static validation cannot resolve request variables. Still price any
  // literal first/last value we can see; defer a wholly variable size to the
  // request-time plugin, where variables are available.
  if (variables === undefined) {
    if (arg.value.kind === Kind.VARIABLE) return 1;
    if (arg.value.kind !== Kind.OBJECT) return Number.MAX_SAFE_INTEGER;

    let multiplier = null;
    let deferred = false;
    for (const field of arg.value.fields || []) {
      if (field.name.value !== 'first' && field.name.value !== 'last') continue;
      if (field.value.kind === Kind.VARIABLE) {
        deferred = true;
        continue;
      }
      if (field.value.kind !== Kind.INT) return Number.MAX_SAFE_INTEGER;
      const n = Number(field.value.value);
      if (!Number.isSafeInteger(n) || n < 0) return Number.MAX_SAFE_INTEGER;
      multiplier = multiplier === null ? n : Math.max(multiplier, n);
    }
    if (multiplier !== null) return Math.max(1, multiplier);
    if (deferred) return 1;
    // PaginationInput.first defaults to 50 when the object is present but
    // neither first nor last supplies a concrete bound.
    return 50;
  }

  let pagination;
  try {
    pagination = valueFromASTUntyped(arg.value, variables);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
  if (pagination === undefined || pagination === null ||
      typeof pagination !== 'object' || Array.isArray(pagination)) {
    return Number.MAX_SAFE_INTEGER;
  }

  const sizes = [];
  for (const name of ['first', 'last']) {
    const n = pagination[name];
    if (n === undefined || n === null) continue;
    if (!Number.isSafeInteger(n) || n < 0) return Number.MAX_SAFE_INTEGER;
    sizes.push(n);
  }
  const multiplier = sizes.length ? Math.max(...sizes) : 50;
  return Math.max(1, multiplier);
}

function selectionsCost(selectionSet, fragments, stack, fieldCosts, defaultCost, variables, memo = new Map(), costCap = Number.MAX_SAFE_INTEGER) {
  let cost = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const fieldCost = fieldCosts[selection.name.value] ?? defaultCost;
      let sub = fieldCost;
      if (selection.selectionSet) {
        sub += selectionsCost(selection.selectionSet, fragments, stack, fieldCosts, defaultCost, variables, memo, costCap);
      }
      const multiplier = Math.max(
        argMultiplier(selection, variables),
        paginationCostMultiplier(selection, variables)
      );
      cost += sub * multiplier;
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      cost += selectionsCost(selection.selectionSet, fragments, stack, fieldCosts, defaultCost, variables, memo, costCap);
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (stack.includes(name)) return Number.MAX_SAFE_INTEGER;
      const fragment = fragments[name];
      if (!fragment) continue;
      // Count each occurrence in the *cost*, but evaluate the fragment's
      // contents only once per operation. Runtime and static requests each
      // receive a fresh memo, so variable-sized list costs cannot leak.
      if (!memo.has(name)) {
        memo.set(name, selectionsCost(
          fragment.selectionSet, fragments, [...stack, name],
          fieldCosts, defaultCost, variables, memo, costCap
        ));
      }
      cost += memo.get(name);
    }
    if (!Number.isFinite(cost) || cost >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
    // Once the cost exceeds the configured limit, this operation will be
    // rejected. Stop walking a potentially enormous remaining selection tree.
    // Fragments memoize a lower bound (costCap + 1) after this cutoff, so
    // later spreads cannot accidentally be accepted because of truncation.
    if (cost > costCap) return costCap + 1;
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
      const cost = selectionsCost(node.selectionSet, fragments, [node.name ? node.name.value : null], fieldCosts, defaultCost, undefined, new Map(), maxCost);
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

/**
 * Recheck the selected operation's cost after Apollo has resolved its operation
 * and received variables, but before any GraphQL resolver executes.
 * The validation-time rule still handles literal-sized queries cheaply.
 */
function runtimeCostLimitPlugin({ maxCost, fieldCosts = {}, defaultCost = 1 }) {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation(requestContext) {
          const operation = requestContext.operation;
          if (!operation) return;

          const fragments = {};
          for (const def of requestContext.document.definitions) {
            if (def.kind === Kind.FRAGMENT_DEFINITION) fragments[def.name.value] = def;
          }
          const variables = Object.assign(
            Object.create(null),
            requestContext.request.variables || {}
          );
          for (const def of operation.variableDefinitions || []) {
            const name = def.variable.name.value;
            if (!Object.prototype.hasOwnProperty.call(variables, name) && def.defaultValue) {
              variables[name] = valueFromASTUntyped(def.defaultValue);
            }
          }
          const cost = selectionsCost(
            operation.selectionSet,
            fragments,
            [operation.name ? operation.name.value : null],
            fieldCosts,
            defaultCost,
            variables,
            new Map(),
            maxCost
          );
          if (cost > maxCost) {
            const label = operation.name ? '"' + operation.name.value + '"' : 'anonymous';
            throw new GraphQLError(
              'Operation ' + label + ' exceeds the maximum query cost of ' +
              maxCost + ' (estimated cost: ' + cost + ').',
              [operation]
            );
          }
        }
      };
    }
  };
}

module.exports = { depthLimitRule, costLimitRule, runtimeCostLimitPlugin };
