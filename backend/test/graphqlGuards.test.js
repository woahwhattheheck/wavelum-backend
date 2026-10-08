/**
 * Focused tests for src/graphql/middleware/queryGuards.js.
 * Exercises the real validation rules through graphql-js `validate`
 * against a minimal schema — the rules are schema-agnostic, so this
 * covers the exact code wired into Apollo Server's `validationRules`.
 */
const { parse, buildSchema, validate } = require('graphql');
const { depthLimitRule, costLimitRule, runtimeCostLimitPlugin } = require('../src/graphql/middleware/queryGuards');

const schema = buildSchema(`
  type User { id: ID!, name: String, posts(first: Int): [Post], followers(first: Int): [User] }
  type Post { id: ID!, title: String, author: User }
  type Query { user(id: ID!): User, users(first: Int): [User], post(id: ID!): Post }
  type Mutation { createPost(title: String!): Post }
`);

const errors = (query, rules) => validate(schema, parse(query), rules).map((e) => e.message);

describe('depthLimitRule', () => {
  const rule = () => depthLimitRule(7);

  it('accepts shallow queries', () => {
    expect(errors('{ user { name } }', [rule()])).toEqual([]);
  });

  it('accepts depth exactly at the limit', () => {
    // user1 posts2 author3 posts4 author5 posts6 title7 = depth 7
    const q = '{ user { posts { author { posts { author { posts { title } } } } } } }';
    expect(errors(q, [rule()])).toEqual([]);
  });

  it('rejects queries deeper than the limit', () => {
    const q = '{ user { posts { author { posts { author { posts { author { title } } } } } } } }';
    const errs = errors(q, [rule()]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/maximum query depth of 7/);
    expect(errs[0]).toMatch(/depth: 8/);
  });

  it('counts depth through fragment spreads', () => {
    const q = `
      { user { ...UserDeep } }
      fragment UserDeep on User { posts { author { posts { author { posts { author { title } } } } } } }
    `;
    expect(errors(q, [rule()])[0]).toMatch(/depth: 8/);
  });

  it('rejects recursive fragment cycles instead of hanging', () => {
    const q = `
      { user { ...A } }
      fragment A on User { posts { author { ...B } } }
      fragment B on User { posts { author { ...A } } }
    `;
    const errs = errors(q, [rule()]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/maximum query depth/);
  });

  it('names anonymous operations in the error', () => {
    const deep = '{ user { posts { author { posts { author { posts { author { id } } } } } } } }';
    expect(errors(deep, [rule()])[0]).toMatch(/anonymous/);
  });
});

describe('costLimitRule', () => {
  const rule = () => costLimitRule({ maxCost: 1000 });

  it('accepts ordinary queries under budget', () => {
    const q = '{ user { id name posts { title } } }';
    expect(errors(q, [rule()])).toEqual([]);
  });

  it('rejects wide queries over budget', () => {
    const parts = [];
    for (let i = 0; i < 1200; i += 1) parts.push(`f${i}: user { id }`);
    const q = `{ ${parts.join(' ')} }`;
    expect(errors(q, [rule()])[0]).toMatch(/maximum query cost of 1000/);
  });

  it('multiplies subtree cost by list-size arguments', () => {
    // users(1) + name(1) + posts(1)+title(1) => subtree cost 4, x 600 = 2400
    const q = '{ users(first: 600) { name posts { title } } }';
    const errs = errors(q, [rule()]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/estimated cost: 2400/);
  });

  it('does not multiply when list args are small', () => {
    const q = '{ users(first: 10) { name } }'; // (1 + 1) * 10 = 20
    expect(errors(q, [rule()])).toEqual([]);
  });

  it('honors per-field cost overrides', () => {
    const pricey = costLimitRule({ maxCost: 10, fieldCosts: { users: 50 } });
    expect(errors('{ users { id } }', [pricey])[0]).toMatch(/estimated cost/);
    const cheap = costLimitRule({ maxCost: 10 });
    expect(errors('{ user { id } }', [cheap])).toEqual([]);
  });

  it('applies to mutations as well as queries', () => {
    const wide = `{ ${Array.from({ length: 1200 }, (_, i) => `m${i}: createPost(title: "x") { id }`).join(' ')} }`;
    expect(errors(wide, [rule()])[0]).toMatch(/maximum query cost/);
  });
});


describe('runtimeCostLimitPlugin', () => {
  const runCostCheck = async (query, variables) => {
    const document = parse(query);
    const operation = document.definitions.find((d) => d.kind === 'OperationDefinition');
    const listener = await runtimeCostLimitPlugin({ maxCost: 1000 }).requestDidStart();
    return listener.didResolveOperation({ document, operation, request: { variables } });
  };

  it('allows a bounded variable but blocks oversized GraphQL pagination variables', async () => {
    const query = 'query Page($count: Int!) { users(first: $count) { id } }';
    // Static validation cannot see the caller's variables, so the Apollo
    // request-time hook must enforce the size before running resolvers.
    expect(errors(query, [costLimitRule({ maxCost: 1000 })])).toEqual([]);
    await expect(runCostCheck(query, { count: 10 })).resolves.toBeUndefined();
    await expect(runCostCheck(query, { count: 600 })).rejects.toThrow(/maximum query cost of 1000/);
  });

  it('honors default variable values but fails closed on missing list sizes', async () => {
    const withDefault = 'query Page($count: Int = 10) { users(first: $count) { id } }';
    await expect(runCostCheck(withDefault, {})).resolves.toBeUndefined();
    await expect(runCostCheck(withDefault, { count: 600 })).rejects.toThrow(/maximum query cost/);
    const missing = 'query Page($count: Int) { users(first: $count) { id } }';
    await expect(runCostCheck(missing, {})).rejects.toThrow(/maximum query cost/);
  });
});
