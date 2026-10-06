const base = require('./jest.config');

module.exports = {
  ...base,
  displayName: 'unit',
  testMatch: [
    '<rootDir>/test/unit/**/*.test.js',
    '<rootDir>/test/unit/**/*.spec.js',
  ],
};
