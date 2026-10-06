const base = require('./jest.config');

module.exports = {
  ...base,
  displayName: 'integration',
  testMatch: [
    '<rootDir>/test/integration/**/*.test.js',
    '<rootDir>/test/integration/**/*.spec.js',
  ],
};
