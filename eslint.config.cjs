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

      'settings/cost-model.js',
      'widgets/*/public/widget-layout.js',

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
    files: [
      'lib/source-status.js',
      'settings/tibber-history-prices.js',
      'settings/contract-versions.js',
      'settings/household-forecast.js',

      'settings/household-settings.js',
      'settings/data-diagnostics.js',
      'settings/grid-day.js',
      'settings/settings-assistant.js',
      'widgets/*/public/history-widget.js',
      'widgets/battery-plan/public/chart.js',
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['test/browser/**/*.cjs'],
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
        SettingsNavigation: 'readonly',
        SettingsAssistant: 'readonly',
        SourceStatus: 'readonly',

        CostModel: 'readonly',

        TibberHistoryPricesSettings: 'readonly',
        ContractVersions: 'readonly',
        HouseholdForecastView: 'readonly',

        HouseholdSettings: 'readonly',
        DataDiagnosticsSettings: 'readonly',
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
          varsIgnorePattern: '^(onHomeyReady|showTab)$',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
