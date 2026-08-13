import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPrompts } from './prompts.js';

describe('registerPrompts', () => {
    it('does not throw when called against a real McpServer with no prompts to register', () => {
        const server = new McpServer({ name: 'mnotes-mcp', version: '0.1.0' });

        expect(() => registerPrompts(server)).not.toThrow();
    });
});
