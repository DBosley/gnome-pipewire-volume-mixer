import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        imports: 'readonly',
        global: 'readonly',
        log: 'readonly',
        logError: 'readonly',
        print: 'readonly',
        printerr: 'readonly',
        globalThis: 'readonly',
        // GNOME Shell globals
        Main: 'readonly',
        Meta: 'readonly',
        Shell: 'readonly',
        St: 'readonly',
        Clutter: 'readonly',
        GObject: 'readonly',
        GLib: 'readonly',
        Gio: 'readonly',
        // Test globals
        describe: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
        module: 'readonly'
      }
    },
    rules: {
      // Allow unused vars that start with _
      'no-unused-vars': ['error', { 
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      // GNOME Shell uses different conventions
      'no-undef': 'off',
      // Allow empty catch blocks
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['__tests__/**/*.js', '**/*.test.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
        global: 'writable',
        TextDecoder: 'readonly'
      }
    },
    rules: {
      // Tests often have unused parameters in mocks
      'no-unused-vars': ['error', { 
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_|^mock'
      }],
      // Allow undef in tests for mocking
      'no-undef': 'off'
    }
  },
  {
    ignores: [
      'node_modules/',
      'dist/',
      'build/',
      '*.min.js',
      'coverage/',
      '.git/',
      'docs/**/*',
      'debug-cache.js'
    ]
  }
];