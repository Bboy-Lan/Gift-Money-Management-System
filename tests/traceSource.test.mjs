import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/lib/traceSource.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { resolveTraceSource } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const entries = [{ id: 'a', personId: 'p', bookId: 'b' }, { id: 'b', personId: 'q', bookId: 'c' }];

test('trace uses exact entry identity, and never guesses missing or ambiguous person records', () => {
  assert.deepEqual(resolveTraceSource('gift_entry', 'a', entries), entries[0]);
  assert.deepEqual(resolveTraceSource('return_gift', 'a', entries), entries[0]);
  assert.deepEqual(resolveTraceSource('person', 'p', entries), entries[0]);
  assert.equal(resolveTraceSource('gift_entry', 'missing', entries), null);
  assert.equal(resolveTraceSource('person', 'p', [...entries, { id: 'c', personId: 'p', bookId: 'c' }]), null);
  assert.equal(resolveTraceSource('vault', 'p', entries), null);
});
