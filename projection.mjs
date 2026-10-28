import { z } from 'zod';
import {
  classifyTool,
  contentText,
  heuristicTokens,
  keywordsOf,
  previewText,
} from './tokens.mjs';

const ANY = z.any();
const PREVIEW_LIMIT = 140;

function str(value) {
  return typeof value === 'string' ? value : '';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function baseName(path) {
  const value = String(path ?? '');
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
}

function changed(state, now, patch) {
  return {
    ...state,
    ...patch,
    revision: (state.revision ?? 0) + 1,
    updatedAt: now || Date.now(),
  };
}

function safeGet(ctx, key) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Price one event's model-visible content. The token meter's fixed heuristic is
 * preferred because it keeps every consumer's measurement consistent; the local
 * fallback only covers hosts where the meter is not mounted.
 */
function estimateEventTokens(ctx, event, message, text) {
  const meter = safeGet(ctx, 'tokenMeter');
  let tokens = 0;
  let approx = true;
  if (meter && typeof meter.estimateMessage === 'function' && message) {
    try {
      const measured = Number(meter.estimateMessage(message));
      if (Number.isFinite(measured) && measured > 0) {
        tokens = measured;
        approx = false;
      }
    } catch {
      // Fall through to the local estimate.
    }
  }
  if (tokens <= 0) {
    const source = text || (message ? JSON.stringify(message) : '');
    tokens = heuristicTokens(source);
  }
  const outputTokens = num(event.data?.usage?.outputTokens);
  if (outputTokens > tokens) tokens = outputTokens;
  return { tokens: Math.max(0, Math.round(tokens)), approx };
}

function mergeOverflow(segments, maxSegments) {
  if (segments.length <= maxSegments) return segments;
  const overflow = segments.length - maxSegments;
  const hasSystem = segments[0]?.kind === 'system' && segments[0]?.id !== 'other';
  const start = hasSystem ? 1 : 0;
  const existingOtherIndex = segments.findIndex((s) => s.id === 'other');
  const existingOther = existingOtherIndex >= 0 ? segments[existingOtherIndex] : null;
  const candidates = segments
    .slice(start)
    .filter((s) => s.id !== 'other');
  const removeCount = Math.min(candidates.length, overflow + 32);
  const removed = candidates.slice(0, removeCount);
  const removedIds = new Set(removed.map((s) => s.id));
  const kept = segments.filter((s) => !removedIds.has(s.id) && s.id !== 'other');
  const tokens = removed.reduce((total, s) => total + s.tokens, 0) + (existingOther?.tokens ?? 0);
  const turn = removed.reduce(
    (lowest, s) => Math.min(lowest, s.turn ?? lowest),
    existingOther?.turn ?? Number.POSITIVE_INFINITY,
  );
  const other = {
    id: 'other',
    seq: -1,
    kind: 'other',
    tokens,
    turn: Number.isFinite(turn) ? turn : 0,
    step: 0,
    tool: '',
    preview: `${removed.length + (existingOther ? 1 : 0)} earlier segments`,
    kws: [],
    error: false,
    approx: true,
  };
  return hasSystem ? [kept[0], other, ...kept.slice(1)] : [other, ...kept];
}

function insertSegment(state, segment, event, maxSegments) {
  let segments = state.segments.filter((s) => s.id !== segment.id);
  const op = event.surfaceOp;
  if (op && typeof op === 'object' && op.op === 'replace') {
    const startSeq = num(op.startSeq);
    const endSeq = num(op.endSeq);
    let index = segments.findIndex((s) => s.seq >= startSeq && s.seq <= endSeq);
    segments = segments.filter((s) => !(s.seq >= startSeq && s.seq <= endSeq));
    if (index < 0) index = segments.length;
    segments.splice(index, 0, segment);
  } else {
    segments.push(segment);
  }
  return mergeOverflow(segments, maxSegments);
}

function addSurface(state, event, now, tool, ctx, maxSegments) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const type = event.type;
  const isToolResult = type === 'tool/result';
  const isSummary = type === 'compaction/summary';
  const message = type === 'user/message' ? data : data.message;
  const text = contentText(message?.content) || (isSummary ? str(data.summary) : '');
  const toolCallId = str(message?.toolCallId) || str(data.toolCallId);
  const toolName = tool || (toolCallId ? state.pendingTools?.[toolCallId] ?? '' : '');
  const sourceKind = str(message?.source?.kind);
  let kind;
  if (isToolResult) kind = classifyTool(toolName);
  else if (isSummary) kind = 'summary';
  else if (type === 'user/message') {
    // Runtime context, time snapshots, and skill catalogs are model-visible user
    // messages, but they are not user intent. Giving them the user weight would
    // let infrastructure crowd out the actual request.
    kind = sourceKind.length > 0 && sourceKind !== 'user' ? 'context' : 'user';
  } else kind = type.replace('/message', '');
  const path = str(data.meta?.path);
  const preview = previewText(
    path && kind === 'file' ? `${baseName(path)}: ${text}` : text,
    PREVIEW_LIMIT,
  );
  const tokens = estimateEventTokens(ctx, event, message, text);
  const turn = num(data.turn) || state.maxTurn;
  const segment = {
    id: `s${event.seq}`,
    seq: num(event.seq),
    kind,
    tokens: tokens.tokens,
    turn,
    step: num(data.step),
    tool: toolName,
    source: sourceKind,
    preview,
    kws: keywordsOf(text || preview),
    error: Boolean(message?.isError || data.error !== undefined),
    approx: tokens.approx,
  };
  const pendingTools = { ...state.pendingTools };
  if (toolCallId) delete pendingTools[toolCallId];
  let usage = state.usage;
  let lastInputTokens = state.lastInputTokens;
  if (type === 'assistant/message' && data.usage) {
    usage = {
      input: state.usage.input + num(data.usage.inputTokens),
      output: state.usage.output + num(data.usage.outputTokens),
      cacheRead: state.usage.cacheRead + num(data.usage.cacheReadTokens),
      cacheWrite: state.usage.cacheWrite + num(data.usage.cacheWriteTokens),
    };
    lastInputTokens = Math.max(lastInputTokens, num(data.usage.inputTokens));
  }
  return changed(state, now, {
    segments: insertSegment(state, segment, event, maxSegments),
    pendingTools,
    usage,
    lastInputTokens,
    maxTurn: Math.max(state.maxTurn, turn),
  });
}

function initialState(header) {
  const h = header && typeof header === 'object' ? header : {};
  return {
    v: 1,
    sessionId: str(h.id),
    title: '',
    model: '',
    provider: '',
    contextWindow: 0,
    createdAt: num(h.createdAt),
    cwd: str(h.cwd),
    agentPreset: str(h.agentPreset),
    segments: [],
    toolsTokens: 0,
    toolCount: 0,
    toolNames: [],
    lastInputTokens: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    turnTimes: {},
    compactions: 0,
    maxTurn: 0,
    pendingTools: {},
    updatedAt: 0,
    revision: 0,
  };
}

/**
 * Build the `attentionLens` session projection.
 *
 * The reducer only reconstructs model-visible context and prices it. Scoring,
 * pinning, and forecasting stay on the client so a pin change never requires a
 * host write or a session-log mutation.
 */
export function createAttentionProjection(ctx, config = {}) {
  const maxSegments = Math.max(20, Math.min(2000, num(config.maxSegments) || 400));

  return {
    key: 'attentionLens',
    stateVersion: 1,
    stateSchema: ANY,
    init: (header) => initialState(header),
    apply: (state, event) => {
      if (!state || !event || typeof event !== 'object') return state;
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      const now = num(event.time) || Date.now();
      switch (event.type) {
        case 'turn/start': {
          const turn = num(data.turn);
          const previous = state.turnTimes[turn] ?? {};
          return changed(state, now, {
            maxTurn: Math.max(state.maxTurn, turn),
            turnTimes: { ...state.turnTimes, [turn]: { ...previous, start: now } },
          });
        }
        case 'turn/end': {
          const turn = num(data.turn);
          const previous = state.turnTimes[turn] ?? {};
          return changed(state, now, {
            maxTurn: Math.max(state.maxTurn, turn),
            turnTimes: { ...state.turnTimes, [turn]: { ...previous, end: now } },
          });
        }
        case 'request/context':
          return changed(state, now, {
            provider: str(data.provider),
            model: str(data.model),
            contextWindow: num(data.contextWindow),
          });
        case 'request/header': {
          const tools = Array.isArray(data.header?.tools) ? data.header.tools : [];
          const toolNames = tools
            .map((tool) => str(tool?.name) || str(tool?.function?.name))
            .filter(Boolean);
          return changed(state, now, {
            toolsTokens: heuristicTokens(JSON.stringify(tools)),
            toolCount: tools.length,
            toolNames,
          });
        }
        case 'agent-preset/selected':
          return changed(state, now, {
            agentPreset:
              str(data.preset) || str(data.id) || str(data.name) || str(data.agentPreset),
          });
        case 'session/title':
          return changed(state, now, { title: str(data.title) });
        case 'tool/call': {
          const callId = str(data.callId);
          if (!callId) return state;
          return changed(state, now, {
            pendingTools: { ...state.pendingTools, [callId]: str(data.name) },
          });
        }
        case 'tool/result':
          return addSurface(
            state,
            event,
            now,
            str(state.pendingTools?.[str(data.message?.toolCallId)]),
            ctx,
            maxSegments,
          );
        case 'user/message':
        case 'assistant/message':
        case 'system/message':
        case 'developer/message':
          return addSurface(state, event, now, '', ctx, maxSegments);
        case 'compaction/start':
          return changed(state, now, { compactions: state.compactions + 1 });
        case 'compaction/summary':
          if (data.message || str(data.summary)) {
            return addSurface(state, event, now, '', ctx, maxSegments);
          }
          return state;
        case 'compaction/end':
        case 'compaction/prune':
          return state;
        default:
          return state;
      }
    },
    wire: {
      viewSchema: ANY,
      view: (state) => state,
    },
  };
}
