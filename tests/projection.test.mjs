import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttentionProjection } from '../projection.mjs';

function makeDefinition(maxSegments) {
  const ctx = {
    get(key) {
      if (key !== 'tokenMeter') return undefined;
      return {
        estimateMessage(message) {
          return Math.ceil(JSON.stringify(message).length / 4);
        },
      };
    },
  };
  return createAttentionProjection(ctx, { maxSegments: maxSegments || 50 });
}

function appendMessage(state, def, seq, type, data, surfaceOp) {
  return def.apply(state, {
    type: type,
    seq: seq,
    time: seq * 10,
    surfaceOp: surfaceOp || 'append',
    data: data,
  });
}

test('projection reconstructs surface segments and tool names', () => {
  const def = makeDefinition();
  let state = def.init({ id: 'session-test', createdAt: 1, cwd: '/tmp', agentPreset: 'standard' });
  assert.equal(def.key, 'attentionLens');
  assert.equal(def.stateVersion, 1);
  assert.equal(def.wire.view(state), state);

  state = def.apply(state, {
    type: 'request/context', seq: 1, time: 10,
    data: { provider: 'deepseek-account', model: 'deepseek-flash', contextWindow: 128000 },
  });
  state = def.apply(state, {
    type: 'request/header', seq: 2, time: 20,
    data: { header: { tools: [{ name: 'read' }, { name: 'edit' }] }, reason: 'initial' },
  });
  state = appendMessage(state, def, 10, 'user/message', {
    role: 'user', id: 'm1', content: [{ type: 'text', text: 'You must keep auth compatible.' }],
  });
  state = appendMessage(state, def, 11, 'assistant/message', {
    turn: 1, step: 1,
    message: { role: 'assistant', id: 'm2', content: [{ type: 'text', text: 'I will read the file.' }] },
    usage: { inputTokens: 900, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  state = def.apply(state, {
    type: 'tool/call', seq: 12, time: 120,
    data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' },
  });
  state = appendMessage(state, def, 13, 'tool/result', {
    turn: 1, step: 1,
    message: {
      role: 'tool', id: 'm3', toolCallId: 'c1', isError: false,
      content: [{ type: 'text', text: 'file content' }],
    },
    meta: { path: '/tmp/auth.ts' },
  });

  assert.equal(state.contextWindow, 128000);
  assert.equal(state.model, 'deepseek-flash');
  assert.ok(state.toolsTokens > 0);
  assert.equal(state.toolCount, 2);
  assert.equal(state.lastInputTokens, 900);
  assert.equal(state.segments.length, 3);
  assert.deepEqual(state.segments.map((segment) => segment.kind), ['user', 'assistant', 'file']);
  assert.equal(state.segments[2].tool, 'read');
  assert.equal(state.pendingTools.c1, undefined);
  assert.ok(state.segments[2].preview.includes('auth.ts'));
});

test('surface replacement replaces the target node in place', () => {
  const def = makeDefinition();
  let state = def.init({ id: 'session-test', createdAt: 1 });
  state = appendMessage(state, def, 10, 'user/message', {
    role: 'user', id: 'm1', content: [{ type: 'text', text: 'original prompt' }],
  });
  state = appendMessage(state, def, 11, 'assistant/message', {
    turn: 1, step: 1,
    message: { role: 'assistant', id: 'm2', content: [{ type: 'text', text: 'reply' }] },
    usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  state = appendMessage(state, def, 20, 'user/message', {
    role: 'user', id: 'm4', content: [{ type: 'text', text: 'replacement prompt' }],
  }, { op: 'replace', startSeq: 10, endSeq: 10 });

  assert.equal(state.segments.length, 2);
  assert.equal(state.segments[0].id, 's20');
  assert.ok(state.segments[0].preview.includes('replacement'));
  assert.equal(state.segments.some((segment) => segment.id === 's10'), false);
});

test('segment cap merges the oldest context into an aggregate', () => {
  const def = makeDefinition(20);
  let state = def.init({ id: 'session-test', createdAt: 1 });
  for (let i = 0; i < 40; i++) {
    state = appendMessage(state, def, 100 + i, 'user/message', {
      role: 'user', id: 'm' + i, content: [{ type: 'text', text: 'message ' + i }],
    });
  }
  assert.ok(state.segments.length <= 20);
  assert.equal(state.segments[0].id, 'other');
  assert.ok(state.segments[0].tokens > 0);
});

test('unknown events leave the state reference unchanged', () => {
  const def = makeDefinition();
  const state = def.init({ id: 'session-test', createdAt: 1 });
  const next = def.apply(state, { type: 'permission/preset', seq: 1, data: { mode: 'ask' } });
  assert.equal(next, state);
});

test('injected user context is separated from real user intent', () => {
  const def = makeDefinition();
  let state = def.init({ id: 'session-test', createdAt: 1 });
  state = appendMessage(state, def, 1, 'user/message', {
    role: 'user', id: 'm1', source: { kind: 'user' },
    content: [{ type: 'text', text: 'hello' }],
  });
  state = appendMessage(state, def, 2, 'user/message', {
    role: 'user', id: 'm2', source: { kind: 'time-context' },
    content: [{ type: 'text', text: 'Time sampled while preparing turn 1.' }],
  });
  assert.equal(state.segments[0].kind, 'user');
  assert.equal(state.segments[0].source, 'user');
  assert.equal(state.segments[1].kind, 'context');
  assert.equal(state.segments[1].source, 'time-context');
});
