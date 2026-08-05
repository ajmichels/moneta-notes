import { describe, it, expect } from 'vitest';
import { openDb } from './db.js';

describe('openDb', () => {
    it('loads the sqlite-vec extension', () => {
        const { db } = openDb(':memory:');
        const row = db.prepare('SELECT vec_version() AS version').get();
        expect(typeof row.version).toBe('string');
        db.close();
    });
});
