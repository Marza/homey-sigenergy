const js = require('@eslint/js');
const globals = require('globals');
const html = require('eslint-plugin-html');
const rules = {
  ...js.configs.recommended.rules,
  eqeqeq: ['error', 'always'],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
};
module.exports = [
  {
    ignores: [
      'node_modules/**',
      '.homeybuild/**',
      'coverage/**',
      'dist/**',
      'settings/source-status.js',
      'settings/simulator.js',
      'settings/cost-model.js',
      'widgets/energy-overview/public/widget-layout.js',
      'settings/charging-planner.js',
      'widgets/energy-overview/public/source-status.js',
      'settings/price-coverage.js',
      'settings/tariff-config.js',
      'widgets/energy-overview/public/tariff-config.js',
      'widgets/energy-overview/public/price-coverage.js',
    ],
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules,
  },
  {
    files: ['lib/source-status.js', 'settings/tibber-data.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['settings/**/*.html', 'widgets/**/*.html'],
    plugins: { html },
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        Homey: 'readonly',
        SourceStatus: 'readonly',
        Simulator: 'readonly',
        CostModel: 'readonly',
        ChargingPlanner: 'readonly',
        SolarPreview: 'readonly',
        TibberDataSettings: 'readonly',
        WidgetLayout: 'readonly',
        PriceCoverage: 'readonly',
        TariffConfig: 'readonly',
      },
    },
    rules: {
      ...rules,
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^onHomeyReady$',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
