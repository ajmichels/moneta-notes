import globals from 'globals';
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';

export default defineConfig([
    {
        files: [ '**/*.js' ],
        ignores: [
            "**/htmx.min.js",
        ],
        languageOptions: {
            sourceType: 'module',
            ecmaVersion: 2024,
            globals: {
                ...globals.node,
            },
        },
        plugins: {
            js,
        },
        extends: [
            'js/recommended',
        ],
        rules: {
            'max-len': [ 'warn', {
                code: 130,
                tabWidth: 4,
                comments: 100,
            } ],
            'no-eval': 'error',
            'func-style': [ 'error', 'declaration', {
                allowArrowFunctions: true,
            } ],
            'prefer-arrow-callback': 'warn',
            'prefer-const': 'error',
            'max-lines-per-function': [ 'warn', {
                max: 50,
                skipBlankLines: true,
                skipComments: true,
            } ],
            'max-depth': [ 'warn', 2 ],
            'max-lines': [ 'warn', 999 ],
            'max-nested-callbacks': [ 'error', 3 ],
            'max-params': [ 'warn', 5 ],
            'max-statements': [ 'warn', 30 ],
            'new-cap': [ 'error', {
                newIsCap: true,
                newIsCapExceptions: [],
                capIsNew: true,
                capIsNewExceptions: [ 'Router' ],
            } ],
            'no-console': 'error',
            'no-else-return': 'error',
            'no-extend-native': 'error',
            'no-extra-bind': 'error',
            'no-loop-func': 'error',
            'no-lonely-if': 'error',
            // 'no-magic-numbers': 'error',
            'no-nested-ternary': 'error',
            'no-new-func': 'error',
            'no-new-wrappers': 'error',
            'no-object-constructor': 'error',
            'no-throw-literal': 'error',
            'no-underscore-dangle': 'error',
            'no-unneeded-ternary': 'error',
            'no-unused-expressions': 'error',
            'no-useless-call': 'error',
            'no-useless-concat': 'error',
            'no-useless-computed-key': 'error',
            'no-useless-rename': 'error',
            'no-useless-constructor': 'error',
            'no-useless-return': 'error',
            'comma-dangle': [ 'error', 'always-multiline' ],
        },
    },
    {
        files: [ '**/*.spec.js' ],
        rules: {
            'max-depth': [ 'warn', 3 ],
            'max-lines': 'off',
            'max-lines-per-function': 'off',
            'max-nested-callbacks': [ 'error', 6 ],
            'max-params': [ 'warn', 5 ],
            'max-statements': [ 'warn', 60 ],
        },
    },
]);
