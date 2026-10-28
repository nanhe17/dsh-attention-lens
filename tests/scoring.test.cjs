const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../client.js');

function segment(id, seq, kind, tokens, turn, preview, extra) {
  return Object.assign({
    id: id,
    seq: seq,
    kind: kind,
    tokens: tokens,
    turn: turn,
    step: 0,
    tool: '',
    preview: preview,
    kws: S.keywordsOf(preview, 10),
    error: false,
    approx: true,
  }, extra || {});
}

function buildView(extraSegments, options) {
  const segments = [
    segment('s0', 0, 'system', 2000, 0, 'You are an AI agent powered by DeepSeek Harness. Follow the must constraints.'),
    segment('spec', 1, 'user', 800, 1, 'You must keep the auth flow backward compatible. Never store tokens in localStorage.'),
    segment('s2', 2, 'assistant', 1200, 1, 'I will inspect the auth module and then patch it.'),
    segment('s3', 3, 'file', 6000, 1, 'auth.ts: export function login with token refresh', { tool: 'read' }),
    segment('s4', 4, 'tool_result', 7000, 2, 'test output: 12 passed, 1 failed in auth refresh', { tool: 'bash', error: true }),
  ];
  for (let i = 0; i < 24; i++) {
    segments.push(segment('s' + (10 + i), 10 + i, 'tool_result', 900 + i * 40, 3 + (i % 8), 'verbose tool output line ' + i + ' for the auth flow'));
  }
  segments.push(segment('recent', 100, 'user', 400, 40, 'Now add the refresh token path and keep the auth constraints.'));
  if (extraSegments) segments.push.apply(segments, extraSegments);
  return Object.assign({
    v: 1,
    sessionId: 'session-test',
    title: 'Auth flow refactor',
    model: 'deepseek-flash',
    provider: 'deepseek-account',
    contextWindow: 128000,
    createdAt: 1,
    cwd: '/tmp',
    agentPreset: 'standard',
    segments: segments,
    toolsTokens: 3000,
    toolCount: 12,
    toolNames: ['read', 'edit', 'bash', 'web_search'],
    lastInputTokens: 60000,
    usage: { input: 58000, output: 4000, cacheRead: 0, cacheWrite: 0 },
    turnTimes: { 1: { start: 1, end: 1200 }, 2: { start: 1200, end: 2400 }, 40: { start: 2400, end: 3600 } },
    compactions: 0,
    maxTurn: 40,
    pendingTools: {},
    updatedAt: 1,
    revision: 1,
  }, options || {});
}

test('shares normalize to one', () => {
  const report = S.buildReport(buildView(), { pins: new Set() });
  const total = report.base.segments.reduce((sum, item) => sum + item.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'shares sum to ' + total);
  assert.ok(report.base.segments.every((item) => item.share >= 0));
});

test('positional prior is U-shaped', () => {
  assert.ok(S.positionPrior(0.05) > S.positionPrior(0.5));
  assert.ok(S.positionPrior(0.95) > S.positionPrior(0.5));
});

test('pinning an anchor raises its share', () => {
  const view = buildView();
  const unpinned = S.buildReport(view, { pins: new Set() });
  const pinned = S.buildReport(view, { pins: new Set(['spec']) });
  const before = unpinned.base.segments.find((item) => item.id === 'spec').share;
  const after = pinned.base.segments.find((item) => item.id === 'spec').share;
  assert.ok(after > before, 'pinned ' + after + ' should exceed ' + before);
});

test('adding context dilutes an early spec', () => {
  const base = S.buildReport(buildView(), { pins: new Set(['spec']) });
  const extra = [];
  for (let i = 0; i < 20; i++) {
    extra.push(segment('x' + i, 200 + i, 'tool_result', 2400, 41 + i, 'more verbose output ' + i));
  }
  const grown = S.buildReport(buildView(extra, { maxTurn: 60 }), { pins: new Set(['spec']) });
  const before = base.base.segments.find((item) => item.id === 'spec').share;
  const after = grown.base.segments.find((item) => item.id === 'spec').share;
  assert.ok(after < before, 'diluted ' + after + ' should be below ' + before);
});

test('forecast returns a horizon and a countdown for a pinned anchor', () => {
  const report = S.buildReport(buildView(), { pins: new Set(['spec']), horizon: 12, threshold: 0.05 });
  assert.equal(report.forecast.points.length, 12);
  assert.ok(report.forecast.anchors.length >= 1);
  const anchor = report.forecast.anchors[0];
  assert.equal(anchor.id, 'spec');
  assert.ok(anchor.timeToThreshold === null || anchor.timeToThreshold >= 1);
  assert.ok(report.forecast.assumptions.avgTurnTokens > 0);
});

test('phase classification recognizes implement and debug', () => {
  const view = buildView();
  const phases = S.classifyPhases(view, [
    segment('a', 1, 'file', 100, 1, 'write auth.ts', { tool: 'edit' }),
    segment('b', 2, 'tool_result', 100, 2, 'test failed with error', { tool: 'bash', error: true }),
    segment('c', 3, 'file', 100, 3, 'read package.json', { tool: 'read' }),
  ]);
  assert.equal(phases[0].phase, 'implement');
  assert.equal(phases[1].phase, 'debug');
  assert.equal(phases[2].phase, 'explore');
});

test('heatmap rows align with series turns', () => {
  const report = S.buildReport(buildView(), { pins: new Set(['spec']) });
  assert.ok(report.heatmap.rows.length <= 12);
  assert.equal(report.heatmap.rows[0].cells.length, report.heatmap.turns.length);
  assert.ok(report.series.points.length > 0);
});

test('short sessions return an empty report', () => {
  const report = S.buildReport({ segments: [] }, {});
  assert.equal(report.empty, true);
});
