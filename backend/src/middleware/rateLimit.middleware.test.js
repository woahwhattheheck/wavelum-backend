const jwt = require('jsonwebtoken');
const {
  SlidingWindowCounter,
  createRateLimiter,
  getGlobalIdentity,
  resolveRateLimitConfig,
} = require('./rateLimit.middleware');

describe('rateLimit.middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('reads positive environment overrides and keeps safe defaults', () => {
    process.env.RATE_LIMIT_WINDOW_MS = '30000';
    process.env.RATE_LIMIT_IP_MAX = '80';
    process.env.RATE_LIMIT_USER_MAX = '120';
    process.env.RATE_LIMIT_AUTH_MAX = '10';

    expect(resolveRateLimitConfig()).toEqual({
      windowMs: 30000,
      ipMax: 80,
      userMax: 120,
      authMax: 10,
    });
  });

  test('weights the previous bucket for a sliding-window count', async () => {
    let now = 59000;
    const counter = new SlidingWindowCounter({ now: () => now });

    await counter.hit('ip:test', 60000);
    await counter.hit('ip:test', 60000);

    now = 90000;
    const result = await counter.hit('ip:test', 60000);

    expect(result.totalHits).toBe(2);
  });

  test('keys authenticated requests by verified user identity', () => {
    process.env.JWT_SECRET = 'rate-limit-test-secret';
    const token = jwt.sign({ address: 'GABC123' }, process.env.JWT_SECRET);
    const config = {
      windowMs: 60000,
      ipMax: 100,
      userMax: 75,
      authMax: 10,
    };
    const identity = getGlobalIdentity(
      {
        headers: { authorization: `Bearer ${token}` },
        ip: '127.0.0.1',
      },
      config,
    );

    expect(identity.scope).toBe('user');
    expect(identity.limit).toBe(75);
    expect(identity.key).toMatch(/^user:/);
  });

  test('authenticated requests remain subject to the per-IP ceiling', async () => {
    process.env.JWT_SECRET = 'rate-limit-test-secret';
    const token = jwt.sign({ address: 'GABC123' }, process.env.JWT_SECRET);
    const hits = new Map();
    const counter = {
      hit: jest.fn(async (key) => {
        const totalHits = (hits.get(key) || 0) + 1;
        hits.set(key, totalHits);
        return { totalHits, resetTime: Date.now() + 60000 };
      }),
    };
    const limiter = createRateLimiter({
      mode: 'global',
      counter,
      skip: () => false,
      configResolver: () => ({
        windowMs: 60000,
        ipMax: 1,
        userMax: 100,
        authMax: 10,
      }),
    });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      ip: '127.0.0.1',
    };
    const res = {
      set: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    await limiter(req, res, next);
    await limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(counter.hit).toHaveBeenCalledWith(expect.stringMatching(/^ip:/), 60000);
    expect(counter.hit).toHaveBeenCalledWith(expect.stringMatching(/^user:/), 60000);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitInfo: expect.objectContaining({ scope: 'ip' }),
      }),
    );
  });

  test('enforces a per-auth-endpoint limit with legacy rate headers', async () => {
    let hits = 0;
    const counter = {
      hit: jest.fn(async () => ({
        totalHits: ++hits,
        resetTime: Date.now() + 60000,
      })),
    };
    const limiter = createRateLimiter({
      mode: 'auth',
      counter,
      skip: () => false,
      configResolver: () => ({
        windowMs: 60000,
        ipMax: 100,
        userMax: 100,
        authMax: 1,
      }),
    });
    const req = {
      headers: {},
      ip: '127.0.0.1',
      method: 'POST',
      originalUrl: '/api/auth/login',
    };
    const res = {
      set: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    await limiter(req, res, next);
    await limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'X-RateLimit-Limit': '1',
        'X-RateLimit-Remaining': '0',
      }),
    );
    expect(res.set).toHaveBeenCalledWith(
      'Retry-After',
      expect.any(String),
    );
    expect(res.status).toHaveBeenCalledWith(429);
  });
});
