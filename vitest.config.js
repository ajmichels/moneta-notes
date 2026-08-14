import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        setupFiles: './vitest.setup.js',
        execArgv: [ '--disable-warning=ExperimentalWarning' ],
    },
});
