/* global window, document, localStorage */
/**
 * Attention Lens client half.
 *
 * This file is a classic script for the DSH client module loader, and is also
 * requirable from Node tests (the scoring functions are exported there).
 *
 * The model is deliberately explicit: the provider API does not expose attention
 * weights, so every share below is an estimate built from a positional prior,
 * content salience, lexical relevance, age, and user anchors. The UI labels it
 * as an estimate; never present these numbers as measured attention.
 */
(function (global) {
  'use strict';

  var VERSION = 1;
  var DEFAULTS = { preset: 'balanced', threshold: 0.05, horizon: 12 };
  var PRESETS = {
    balanced: {
      system: 1.6, tools: 1.2, user: 1.3, context: 0.55, goal: 1.4, todo: 1.4,
      developer: 1.2, assistant: 0.9, tool_result: 0.55, file: 0.8, web: 0.5,
      subagent: 0.7, summary: 0.9, attachment: 0.7, unobserved: 1.0, other: 0.4,
    },
    recency: {
      system: 1.35, tools: 1.0, user: 1.15, context: 0.6, goal: 1.2, todo: 1.2,
      developer: 1.0, assistant: 1.15, tool_result: 0.85, file: 0.95, web: 0.7,
      subagent: 0.85, summary: 0.8, attachment: 0.8, unobserved: 0.9, other: 0.5,
    },
    instruction: {
      system: 1.9, tools: 1.35, user: 1.6, context: 0.45, goal: 1.8, todo: 1.8,
      developer: 1.4, assistant: 0.8, tool_result: 0.4, file: 0.65, web: 0.45,
      subagent: 0.6, summary: 1.0, attachment: 0.65, unobserved: 1.1, other: 0.35,
    },
  };

  var CONSTRAINT_RE = /\b(must|never|only|required|always|do not|don\’t|don't|shall)\b/i;
  var CONSTRAINT_CJK_RE = /必须|不要|禁止|只能|务必|一定|不得|仅限/;
  var CODE_RE = /[{};]|=>|\b(function|const|let|class|import|export|return)\b/;
  var PATH_RE = /<path>|[a-z]:\\|\/(?:[\w.-]+\/){1,}/i;
  var TOOL_READ_RE = /read|grep|glob|list|search|view|ls\b/i;
  var TOOL_WRITE_RE = /write|edit|apply_patch|replace|create|bash|shell|powershell/i;
  var TOOL_WEB_RE = /web|search|fetch|browser|http/i;
  var TOOL_TODO_RE = /todo|plan|goal/i;
  var TOOL_REVIEW_RE = /diff|git|review/i;
  var TEST_RE = /test|spec|error|fail|assert/i;

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function str(value) {
    return typeof value === 'string' ? value : '';
  }

  function pct(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return (Number(value) * 100).toFixed(1) + '%';
  }

  function fmtTokens(value) {
    var n = num(value);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function fmtMs(value) {
    var n = num(value);
    if (n <= 0) return '';
    if (n < 1000) return Math.round(n) + 'ms';
    return (n / 1000).toFixed(1) + 's';
  }

  function positionPrior(x) {
    var value = clamp(num(x), 0, 1);
    return 0.2
      + 0.55 * Math.exp(-value / 0.18)
      + 0.45 * Math.exp(-(1 - value) / 0.12);
  }

  function isConstraint(text) {
    var value = String(text || '');
    return CONSTRAINT_RE.test(value) || CONSTRAINT_CJK_RE.test(value);
  }

  function isCode(text) {
    return CODE_RE.test(String(text || ''));
  }

  function isPath(text) {
    return PATH_RE.test(String(text || ''));
  }

  function keywordsOf(text, limit) {
    var value = String(text || '').slice(0, 8000).toLowerCase();
    var counts = new Map();
    var stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'are', 'you', 'your', 'not', 'but', 'what', 'when', 'where', 'which', 'who', 'how', 'into', 'than', 'then', 'there', 'their', 'them', 'they', 'its', 'about', 'after', 'before', 'because', 'while', 'also', 'just', 'only', 'more', 'most', 'some', 'such', 'very', 'like', 'over', 'under', 'again', 'still', 'each', 'other', 'same', 'use', 'used', 'using']);
    var words = value.match(/[a-z][a-z0-9_+-]{1,}/g) || [];
    for (var i = 0; i < words.length; i++) {
      if (words[i].length < 3 || stop.has(words[i])) continue;
      counts.set(words[i], (counts.get(words[i]) || 0) + 1);
    }
    var runs = value.match(/[\u3400-\u9fff\uf900-\ufaff]{2,}/g) || [];
    for (var r = 0; r < runs.length; r++) {
      for (var j = 0; j < runs[r].length - 1; j++) {
        var bigram = runs[r].slice(j, j + 2);
        counts.set(bigram, (counts.get(bigram) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); })
      .slice(0, limit || 12)
      .map(function (entry) { return entry[0]; });
  }

  function weightsFor(preset) {
    return PRESETS[preset] || PRESETS.balanced;
  }

  function previewHash(segment) {
    var text = str(segment.preview);
    return text.length + ':' + text.slice(0, 40) + ':' + text.slice(-20);
  }

  function addSyntheticSegments(view, unobservedTokens) {
    var source = Array.isArray(view && view.segments) ? view.segments : [];
    var segments = source.map(function (segment) { return Object.assign({}, segment); });
    var toolsTokens = num(view && view.toolsTokens);
    var toolNames = Array.isArray(view && view.toolNames) ? view.toolNames : [];
    if (toolsTokens > 0) {
      segments.unshift({
        id: 'tools', seq: -2, kind: 'tools', tokens: toolsTokens, turn: 0, step: 0,
        tool: '', preview: String(num(view.toolCount)) + ' tool schemas',
        kws: toolNames.slice(0, 24), error: false, approx: true,
      });
    }
    var observed = segments.reduce(function (total, segment) { return total + num(segment.tokens); }, 0);
    var unobserved = unobservedTokens !== undefined && unobservedTokens !== null
      ? num(unobservedTokens)
      : Math.max(0, num(view && view.lastInputTokens) - observed);
    if (unobserved > 0) {
      segments.splice(toolsTokens > 0 ? 1 : 0, 0, {
        id: 'unobserved', seq: -3, kind: 'unobserved', tokens: unobserved, turn: 0, step: 0,
        tool: '', preview: 'Unobserved context (hidden system/tool content)',
        kws: [], error: false, approx: true,
      });
    }
    var total = segments.reduce(function (sum, segment) { return sum + num(segment.tokens); }, 0);
    var maxTurn = num(view && view.maxTurn);
    for (var i = 0; i < segments.length; i++) {
      if (num(segments[i].turn) > maxTurn) maxTurn = num(segments[i].turn);
    }
    var acc = 0;
    for (var j = 0; j < segments.length; j++) {
      var segment = segments[j];
      segment.tokens = Math.max(0, Math.round(num(segment.tokens)));
      segment.start = acc;
      segment.end = acc + segment.tokens;
      segment.position = total > 0 ? acc / total : 0;
      segment.midPosition = total > 0 ? (acc + segment.tokens / 2) / total : 0;
      acc += segment.tokens;
      segment.age = Math.max(0, maxTurn - num(segment.turn));
    }
    return {
      segments: segments,
      totalTokens: total,
      observedTokens: segments
        .filter(function (segment) { return segment.id !== 'unobserved'; })
        .reduce(function (sum, segment) { return sum + segment.tokens; }, 0),
      unobservedTokens: unobserved,
      maxTurn: maxTurn,
    };
  }

  function latestUser(segments, maxTurn) {
    var best = null;
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (segment.kind !== 'user') continue;
      if (maxTurn !== undefined && maxTurn !== null && num(segment.turn) > maxTurn) continue;
      if (!best || num(segment.seq) > num(best.seq)) best = segment;
    }
    return best;
  }

  function queryKeywords(view, segments, maxTurn) {
    var user = latestUser(segments, maxTurn);
    if (user && Array.isArray(user.kws) && user.kws.length > 0) return user.kws;
    var title = str(view && view.title);
    return title ? keywordsOf(title, 10) : [];
  }

  function scoreSegments(view, options) {
    var opts = options || {};
    var pins = opts.pins instanceof Set ? opts.pins : new Set(opts.pins || []);
    var built = addSyntheticSegments(view, opts.unobservedTokens);
    var maxTurn = opts.maxTurn !== undefined ? num(opts.maxTurn) : built.maxTurn;
    var segments = opts.prefixTurn !== undefined
      ? built.segments.filter(function (segment) { return segment.seq < 0 || num(segment.turn) <= num(opts.prefixTurn); })
      : built.segments;
    if (segments.length === 0) {
      return {
        segments: [], totalTokens: 0, observedTokens: 0, unobservedTokens: 0,
        maxTurn: maxTurn, queryKws: [], pins: pins,
        metrics: {
          totalTokens: 0, contextWindow: num(view && view.contextWindow) || 128000,
          contextUsed: 0, criticalShare: 0, criticalTokens: 0, coverage80: 0,
          coldZoneShare: 0, anchorCount: 0, unobservedTokens: 0,
        },
      };
    }
    var total = segments.reduce(function (sum, segment) { return sum + segment.tokens; }, 0);
    var acc = 0;
    for (var i = 0; i < segments.length; i++) {
      segments[i].start = acc;
      segments[i].end = acc + segments[i].tokens;
      segments[i].position = total > 0 ? acc / total : 0;
      segments[i].midPosition = total > 0 ? (acc + segments[i].tokens / 2) / total : 0;
      acc += segments[i].tokens;
    }
    var queryKws = Array.isArray(opts.queryKws) && opts.queryKws.length > 0
      ? opts.queryKws
      : opts.prefixTurn !== undefined
        ? queryKeywords(view, built.segments, opts.prefixTurn)
        : queryKeywords(view, segments, maxTurn);
    var weights = weightsFor(opts.preset);
    var n = segments.length;
    var df = new Map();
    for (var q = 0; q < queryKws.length; q++) {
      var keyword = queryKws[q];
      var count = 0;
      for (var s = 0; s < n; s++) {
        if (Array.isArray(segments[s].kws) && segments[s].kws.indexOf(keyword) >= 0) count++;
      }
      df.set(keyword, count);
    }
    var rawScores = new Array(n);
    var maxRaw = 0;
    for (var i2 = 0; i2 < n; i2++) {
      var segment = segments[i2];
      var raw = 0;
      if (Array.isArray(segment.kws)) {
        for (var k = 0; k < queryKws.length; k++) {
          if (segment.kws.indexOf(queryKws[k]) >= 0) {
            var frequency = df.get(queryKws[k]) || 0;
            raw += Math.log(1 + (n - frequency + 0.5) / (frequency + 0.5));
          }
        }
      }
      rawScores[i2] = raw;
      if (raw > maxRaw) maxRaw = raw;
    }
    var hashCounts = new Map();
    for (var h = 0; h < n; h++) {
      var hash = previewHash(segments[h]);
      hashCounts.set(hash, (hashCounts.get(hash) || 0) + 1);
    }
    var constraintKinds = { user: 1, system: 1, developer: 1, goal: 1, todo: 1 };
    var hasConstraint = segments.some(function (segment) {
      return constraintKinds[segment.kind] && isConstraint(segment.preview);
    });
    var autoAnchorId = null;
    if (pins.size === 0 && !hasConstraint) {
      var firstUser = segments.filter(function (segment) { return segment.kind === 'user'; })[0];
      var firstSystem = segments.filter(function (segment) { return segment.kind === 'system'; })[0];
      autoAnchorId = firstUser ? firstUser.id : firstSystem ? firstSystem.id : (segments[0] ? segments[0].id : null);
    }
    var totalWeight = 0;
    for (var i3 = 0; i3 < n; i3++) {
      var item = segments[i3];
      var typeWeight = num(weights[item.kind]) || num(weights.tool_result);
      var prior = positionPrior(item.midPosition);
      var relevance = maxRaw > 0 ? 0.5 + clamp(rawScores[i3] / maxRaw, 0, 1) : 1;
      var salience = 1;
      if (item.error) salience *= 1.3;
      if (isCode(item.preview)) salience *= 1.1;
      if (isConstraint(item.preview)) salience *= 1.2;
      if ((hashCounts.get(previewHash(item)) || 0) > 1) salience *= 1.15;
      if (isPath(item.preview)) salience *= 1.05;
      var age = Math.exp(-clamp(item.age, 0, 200) / 20);
      var pin = pins.has(item.id) ? 1.8 : 1;
      item.factors = { pos: prior, type: typeWeight, rel: relevance, sal: salience, age: age, pin: pin };
      item.weight = prior * typeWeight * relevance * salience * age * pin;
      item.isPinned = pins.has(item.id);
      item.isCritical = item.isPinned
        || (pins.size === 0
          && ((constraintKinds[item.kind] && isConstraint(item.preview)) || item.id === autoAnchorId));
      totalWeight += item.weight;
    }
    for (var i4 = 0; i4 < n; i4++) {
      var scored = segments[i4];
      scored.share = totalWeight > 0 ? scored.weight / totalWeight : 0;
      scored.density = scored.share / Math.max(0.001, scored.tokens / 1000);
    }
    var critical = segments.filter(function (segment) { return segment.isCritical; });
    var criticalShare = critical.reduce(function (sum, segment) { return sum + segment.share; }, 0);
    var criticalTokens = critical.reduce(function (sum, segment) { return sum + segment.tokens; }, 0);
    var byShare = segments.slice().sort(function (a, b) { return b.share - a.share; });
    var covered = 0;
    var coveredTokens = 0;
    for (var c = 0; c < byShare.length && covered < 0.8; c++) {
      covered += byShare[c].share;
      coveredTokens += byShare[c].tokens;
    }
    var coldZoneShare = segments
      .filter(function (segment) { return segment.midPosition >= 0.3 && segment.midPosition <= 0.7; })
      .reduce(function (sum, segment) { return sum + segment.share; }, 0);
    var contextWindow = num(view && view.contextWindow) || 128000;
    var metrics = {
      totalTokens: total,
      contextWindow: contextWindow,
      contextUsed: contextWindow > 0 ? total / contextWindow : 0,
      criticalShare: criticalShare,
      criticalTokens: criticalTokens,
      coverage80: total > 0 ? coveredTokens / total : 0,
      coldZoneShare: coldZoneShare,
      anchorCount: critical.length,
      unobservedTokens: built.unobservedTokens,
    };
    return {
      segments: segments,
      totalTokens: total,
      observedTokens: built.observedTokens,
      unobservedTokens: built.unobservedTokens,
      maxTurn: maxTurn,
      queryKws: queryKws,
      pins: pins,
      metrics: metrics,
    };
  }

  function avgTurnTokens(view, maxTurn) {
    var byTurn = new Map();
    var source = Array.isArray(view && view.segments) ? view.segments : [];
    for (var i = 0; i < source.length; i++) {
      var segment = source[i];
      if (num(segment.seq) < 0) continue;
      var turn = num(segment.turn);
      byTurn.set(turn, (byTurn.get(turn) || 0) + num(segment.tokens));
    }
    var turns = Array.from(byTurn.keys()).sort(function (a, b) { return a - b; });
    var recent = turns.slice(-5);
    if (recent.length === 0) return 2000;
    var total = recent.reduce(function (sum, turn) { return sum + byTurn.get(turn); }, 0);
    return Math.max(400, total / recent.length);
  }

  function forecast(view, options, base) {
    var opts = options || {};
    var horizon = clamp(Math.round(num(opts.horizon) || DEFAULTS.horizon), 1, 40);
    var threshold = clamp(num(opts.threshold) || DEFAULTS.threshold, 0.005, 0.5);
    var pins = base.pins;
    var anchorSegments = base.segments.filter(function (segment) { return pins.has(segment.id); });
    if (anchorSegments.length === 0) {
      anchorSegments = base.segments
        .filter(function (segment) { return segment.isCritical; })
        .sort(function (a, b) { return b.share - a.share; })
        .slice(0, 3);
    }
    var anchors = anchorSegments.map(function (segment) {
      return {
        id: segment.id,
        label: segment.preview || segment.kind,
        kind: segment.kind,
        auto: pins.size === 0,
      };
    });
    var avg = avgTurnTokens(view, base.maxTurn);
    function simulate(scale) {
      var points = [];
      for (var step = 1; step <= horizon; step++) {
        var turn = base.maxTurn + step;
        var syntheticTokens = avg * scale;
        var synthetic = [
          { id: 'p' + step + 'a', seq: -1000 - step * 2, kind: 'assistant', tokens: syntheticTokens * 0.3, turn: turn, step: 0, tool: '', preview: '(projected assistant)', kws: base.queryKws, error: false, approx: true },
          { id: 'p' + step + 't', seq: -1001 - step * 2, kind: 'tool_result', tokens: syntheticTokens * 0.7, turn: turn, step: 0, tool: '', preview: '(projected tool output)', kws: base.queryKws, error: false, approx: true },
        ];
        var simView = Object.assign({}, view, {
          segments: (Array.isArray(view && view.segments) ? view.segments : []).concat(synthetic),
          maxTurn: turn,
        });
        var scored = scoreSegments(simView, {
          preset: opts.preset, pins: pins, unobservedTokens: base.unobservedTokens,
          maxTurn: turn, queryKws: base.queryKws,
        });
        var shares = {};
        for (var a = 0; a < anchors.length; a++) {
          var found = scored.segments.filter(function (segment) { return segment.id === anchors[a].id; })[0];
          shares[anchors[a].id] = found ? found.share : 0;
        }
        points.push({
          turn: turn,
          criticalShare: scored.metrics.criticalShare,
          low: 0,
          high: 0,
          shares: shares,
        });
      }
      return points;
    }
    var main = simulate(1);
    var low = simulate(0.7);
    var high = simulate(1.3);
    for (var i = 0; i < main.length; i++) {
      main[i].low = low[i] ? low[i].criticalShare : main[i].criticalShare;
      main[i].high = high[i] ? high[i].criticalShare : main[i].criticalShare;
    }
    var anchorForecasts = anchors.map(function (anchor) {
      var current = base.segments.filter(function (segment) { return segment.id === anchor.id; })[0];
      var currentShare = current ? current.share : 0;
      var timeToThreshold = null;
      for (var step = 0; step < main.length; step++) {
        var value = main[step].shares[anchor.id];
        if (value !== undefined && value < threshold) {
          timeToThreshold = step + 1;
          break;
        }
      }
      return {
        id: anchor.id,
        label: anchor.label,
        kind: anchor.kind,
        auto: anchor.auto,
        currentShare: currentShare,
        timeToThreshold: timeToThreshold,
        points: main.map(function (point) { return point.shares[anchor.id] || 0; }),
      };
    });
    return {
      points: main,
      anchors: anchorForecasts,
      assumptions: {
        avgTurnTokens: Math.round(avg),
        horizon: horizon,
        threshold: threshold,
        band: [0.7, 1.3],
      },
    };
  }

  function computeSeries(view, options) {
    var opts = options || {};
    var base = scoreSegments(view, opts);
    if (base.segments.length === 0) return { turns: [], points: [], maxTurn: 0 };
    var maxTurn = base.maxTurn;
    var start = Math.max(1, maxTurn - 19);
    var points = [];
    for (var turn = start; turn <= maxTurn; turn++) {
      var scored = scoreSegments(view, {
        preset: opts.preset, pins: opts.pins,
        unobservedTokens: base.unobservedTokens,
        prefixTurn: turn, maxTurn: turn,
      });
      var map = new Map();
      for (var i = 0; i < scored.segments.length; i++) {
        map.set(scored.segments[i].id, scored.segments[i].share);
      }
      points.push({
        turn: turn,
        criticalShare: scored.metrics.criticalShare,
        totalTokens: scored.totalTokens,
        map: map,
      });
    }
    return { turns: points.map(function (point) { return point.turn; }), points: points, maxTurn: maxTurn };
  }

  function classifyPhases(view, segments) {
    var byTurn = new Map();
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (num(segment.seq) < 0) continue;
      var turn = num(segment.turn);
      if (!byTurn.has(turn)) byTurn.set(turn, []);
      byTurn.get(turn).push(segment);
    }
    var turns = Array.from(byTurn.keys()).sort(function (a, b) { return a - b; });
    var result = [];
    for (var t = 0; t < turns.length; t++) {
      var turn = turns[t];
      var items = byTurn.get(turn);
      var tools = items.map(function (item) { return str(item.tool); }).filter(Boolean);
      var joined = tools.join(' ');
      var hasError = items.some(function (item) { return item.error; });
      var hasTest = TEST_RE.test(joined) || items.some(function (item) { return TEST_RE.test(item.preview); });
      var hasWrite = TOOL_WRITE_RE.test(joined);
      var hasRead = TOOL_READ_RE.test(joined) || items.some(function (item) { return item.kind === 'file'; });
      var hasWeb = TOOL_WEB_RE.test(joined) || items.some(function (item) { return item.kind === 'web'; });
      var hasTodo = TOOL_TODO_RE.test(joined);
      var hasReview = TOOL_REVIEW_RE.test(joined);
      var hasHandoff = items.some(function (item) { return item.kind === 'summary'; });
      var hasAssistant = items.some(function (item) { return item.kind === 'assistant'; });
      var phase;
      if (hasError || (hasTest && hasWrite)) phase = 'debug';
      else if (hasWrite) phase = 'implement';
      else if (hasWeb || hasRead) phase = 'explore';
      else if (hasTodo) phase = 'plan';
      else if (hasReview) phase = 'review';
      else if (hasHandoff) phase = 'handoff';
      else if (hasAssistant) phase = 'respond';
      else phase = 'idle';
      var tokens = items.reduce(function (sum, item) { return sum + num(item.tokens); }, 0);
      var timing = view && view.turnTimes ? view.turnTimes[turn] : null;
      var ms = timing && timing.start && timing.end ? num(timing.end) - num(timing.start) : 0;
      result.push({ turn: turn, phase: phase, tokens: tokens, tools: tools.length, ms: ms });
    }
    return result;
  }

  function buildHeatmap(base, series, top) {
    var rows = top.map(function (segment) {
      return {
        id: segment.id,
        label: segment.preview || segment.kind,
        kind: segment.kind,
        tool: segment.tool,
        cells: series.points.map(function (point) { return point.map.get(segment.id) || 0; }),
      };
    });
    var max = 0;
    for (var i = 0; i < rows.length; i++) {
      for (var j = 0; j < rows[i].cells.length; j++) {
        if (rows[i].cells[j] > max) max = rows[i].cells[j];
      }
    }
    return { rows: rows, turns: series.turns, max: max };
  }

  function riskOf(metrics, fc) {
    if (!metrics || metrics.anchorCount === 0) return 'unknown';
    var countdown = fc.anchors.some(function (anchor) {
      return anchor.timeToThreshold !== null && anchor.timeToThreshold <= 3;
    });
    if (countdown || metrics.criticalShare < 0.04 || metrics.contextUsed > 0.85) return 'high';
    if (metrics.criticalShare < 0.08 || metrics.coldZoneShare > 0.7 || metrics.contextUsed > 0.65) return 'medium';
    return 'low';
  }

  function buildReport(view, options) {
    var opts = options || {};
    if (!view || !Array.isArray(view.segments) || view.segments.length === 0) {
      return { empty: true, reason: view ? 'short' : 'wait' };
    }
    var pins = opts.pins instanceof Set ? opts.pins : new Set(opts.pins || []);
    var settings = {
      preset: opts.preset || DEFAULTS.preset,
      threshold: opts.threshold !== undefined ? opts.threshold : DEFAULTS.threshold,
      horizon: opts.horizon !== undefined ? opts.horizon : DEFAULTS.horizon,
      pins: pins,
    };
    var base = scoreSegments(view, settings);
    if (base.segments.length === 0) return { empty: true, reason: 'short' };
    var series = computeSeries(view, {
      preset: settings.preset, pins: pins,
    });
    var fc = forecast(view, settings, base);
    var phases = classifyPhases(view, base.segments);
    var top = base.segments
      .filter(function (segment) { return segment.kind !== 'tools' && segment.kind !== 'unobserved'; })
      .sort(function (a, b) { return b.share - a.share; })
      .slice(0, 20);
    var heatmap = buildHeatmap(base, series, top.slice(0, 12));
    var risk = riskOf(base.metrics, fc);
    return {
      empty: false,
      view: view,
      base: base,
      settings: settings,
      series: series,
      forecast: fc,
      phases: phases,
      top: top,
      heatmap: heatmap,
      anchors: fc.anchors,
      metrics: base.metrics,
      risk: risk,
      pins: pins,
    };
  }

  var SCORING = {
    version: VERSION,
    DEFAULTS: DEFAULTS,
    PRESETS: PRESETS,
    positionPrior: positionPrior,
    keywordsOf: keywordsOf,
    scoreSegments: scoreSegments,
    computeSeries: computeSeries,
    forecast: forecast,
    classifyPhases: classifyPhases,
    buildReport: buildReport,
    riskOf: riskOf,
    pct: pct,
    fmtTokens: fmtTokens,
    fmtMs: fmtMs,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SCORING;
  }

  if (typeof window === 'undefined' || !window.__ModuleLoader__) return;

  window.__ModuleLoader__.load({
    id: 'dsh-attention-lens',
    factory: function (require) {
      var React = require('react');
      var h = React.createElement;
      var useState = React.useState;
      var useMemo = React.useMemo;
      var useSyncExternalStore = React.useSyncExternalStore;

      var EN = {
        'view.attention': 'Attention',
        'title': 'Attention Lens',
        'subtitle': 'Estimated attention share — not raw model attention.',
        'badge.estimate': 'Estimate',
        'risk.label': 'Dilution risk',
        'risk.low': 'Low',
        'risk.medium': 'Medium',
        'risk.high': 'High',
        'risk.unknown': 'No anchors yet',
        'metric.context': 'Context',
        'metric.critical': 'Critical share',
        'metric.coverage': '80% attention on',
        'metric.cold': 'Cold zone',
        'metric.hidden': 'Unobserved',
        'metric.tokens': 'of window',
        'curve.title': 'Attention curve',
        'curve.hint': 'Estimated density per token across context position. Solid = estimate; dashed = positional prior; the middle is the cold zone.',
        'curve.start': 'start',
        'curve.now': 'now',
        'curve.cold': 'cold zone',
        'curve.prior': 'Position prior',
        'heatmap.title': 'Attention heatmap',
        'heatmap.hint': 'Rows are segments; columns are turns. Darker means more estimated attention.',
        'anchors.title': 'Anchors',
        'anchors.empty': 'Pin a segment below to track its dilution.',
        'anchors.auto': 'Auto anchor',
        'anchors.countdown': 'Below threshold in {n} turns',
        'anchors.holds': 'Above threshold through the forecast',
        'anchors.pin': 'Pin',
        'anchors.unpin': 'Unpin',
        'segments.title': 'Segments',
        'segments.hint': 'Top segments by estimated share. Click one to inspect its factors.',
        'detail.title': 'Why this share',
        'detail.empty': 'Click a segment to inspect its factors.',
        'detail.formula': 'share = weight ÷ total weight',
        'detail.preview': 'Preview',
        'detail.tokens': 'tokens',
        'detail.density': 'density',
        'detail.approx': 'approximate tokens',
        'forecast.title': 'Dilution forecast',
        'forecast.hint': 'Projection, not a prophecy. It assumes the current token growth continues and no compaction runs.',
        'forecast.assume': 'Assumes {tokens} tokens/turn over {turns} turns; threshold {pct}.',
        'forecast.empty': 'Pin an anchor to get a countdown.',
        'phase.plan': 'Plan',
        'phase.explore': 'Explore',
        'phase.implement': 'Implement',
        'phase.debug': 'Debug',
        'phase.review': 'Review',
        'phase.handoff': 'Handoff',
        'phase.respond': 'Respond',
        'phase.idle': 'Idle',
        'kind.system': 'System',
        'kind.tools': 'Tools',
        'kind.user': 'User',
        'kind.context': 'Context',
        'kind.assistant': 'Assistant',
        'kind.developer': 'Developer',
        'kind.tool_result': 'Tool',
        'kind.file': 'File',
        'kind.web': 'Web',
        'kind.subagent': 'Subagent',
        'kind.summary': 'Summary',
        'kind.attachment': 'Attachment',
        'kind.unobserved': 'Hidden',
        'kind.other': 'Earlier',
        'settings.title': 'Attention Lens',
        'settings.preset': 'Model preset',
        'settings.balanced': 'Balanced',
        'settings.recency': 'Recency-heavy',
        'settings.instruction': 'Instruction-heavy',
        'settings.threshold': 'Anchor threshold',
        'settings.horizon': 'Forecast turns',
        'settings.reset': 'Reset',
        'settings.note': 'Settings are stored in this browser. All figures are estimates.',
        'settings.how': 'How this is estimated',
        'settings.how.body': 'The provider does not expose attention weights. Attention Lens models an estimated share from position (a U-shaped primacy/recency prior), segment type, lexical relevance to the current query, content salience, age, and your anchors. Treat it as a context-engineering signal, not a measurement.',
        'empty.wait': 'Waiting for session data…',
        'empty.short': 'This session is too short for an attention curve.',
        'empty.noProjection': 'The Attention projection is not mounted for this session.',
        'mini.title': 'Attention: {pct} critical share',
        'footer.note': 'Estimates only. DeepSeek API does not expose attention weights.',
      };

      var ZH = {
        'view.attention': '注意力',
        'title': '注意力透镜',
        'subtitle': '估计注意力份额——不是模型的原始注意力。',
        'badge.estimate': '估计',
        'risk.label': '稀释风险',
        'risk.low': '低',
        'risk.medium': '中',
        'risk.high': '高',
        'risk.unknown': '还没有锚点',
        'metric.context': '上下文',
        'metric.critical': '关键信息份额',
        'metric.coverage': '80% 注意力覆盖',
        'metric.cold': '冷区',
        'metric.hidden': '未观测',
        'metric.tokens': '窗口占用',
        'curve.title': '注意力曲线',
        'curve.hint': '按上下文位置排列的每 token 估计注意力密度。实线 = 估计值；虚线 = 位置先验；中间是冷区。',
        'curve.start': '开始',
        'curve.now': '现在',
        'curve.cold': '冷区',
        'curve.prior': '位置先验',
        'heatmap.title': '注意力热力图',
        'heatmap.hint': '行是段落，列是轮次；越深表示估计注意力越高。',
        'anchors.title': '锚点',
        'anchors.empty': '在下方 pin 一个段落，追踪它的稀释。',
        'anchors.auto': '自动锚点',
        'anchors.countdown': '还有 {n} 轮跌破阈值',
        'anchors.holds': '预测范围内仍在阈值之上',
        'anchors.pin': 'Pin',
        'anchors.unpin': '取消 Pin',
        'segments.title': '段落',
        'segments.hint': '按估计份额排序的前 20 个段落；点击查看因子。',
        'detail.title': '为什么是这个份额',
        'detail.empty': '点击一个段落查看它的因子。',
        'detail.formula': '份额 = 权重 ÷ 总权重',
        'detail.preview': '预览',
        'detail.tokens': 'tokens',
        'detail.density': '密度',
        'detail.approx': 'token 数为近似值',
        'forecast.title': '稀释预测',
        'forecast.hint': '这是投影，不是预言；假设当前 token 增长速度延续，且不触发压缩。',
        'forecast.assume': '假设每轮 {tokens} tokens，共 {turns} 轮；阈值 {pct}。',
        'forecast.empty': 'Pin 一个锚点才能看到倒计时。',
        'phase.plan': '计划',
        'phase.explore': '探索',
        'phase.implement': '实现',
        'phase.debug': '调试',
        'phase.review': '审查',
        'phase.handoff': '交接',
        'phase.respond': '回复',
        'phase.idle': '空闲',
        'kind.system': '系统',
        'kind.tools': '工具',
        'kind.user': '用户',
        'kind.context': '上下文注入',
        'kind.assistant': '助手',
        'kind.developer': '开发者',
        'kind.tool_result': '工具',
        'kind.file': '文件',
        'kind.web': '网页',
        'kind.subagent': '子代理',
        'kind.summary': '摘要',
        'kind.attachment': '附件',
        'kind.unobserved': '隐藏',
        'kind.other': '更早',
        'settings.title': '注意力透镜',
        'settings.preset': '模型预设',
        'settings.balanced': '均衡',
        'settings.recency': '偏近端',
        'settings.instruction': '偏指令',
        'settings.threshold': '锚点阈值',
        'settings.horizon': '预测轮数',
        'settings.reset': '重置',
        'settings.note': '设置保存在本浏览器；所有数字都是估计值。',
        'settings.how': '它是怎么估的',
        'settings.how.body': '模型 API 不返回注意力权重。注意力透镜用位置先验（U 型 primacy/recency）、段落类型、与当前 query 的词面相关性、内容显著性、年龄和你的锚点，估计每个段落的注意力份额。把它当作上下文工程信号，而不是测量值。',
        'empty.wait': '正在等待会话数据…',
        'empty.short': '会话太短，暂时没有注意力曲线。',
        'empty.noProjection': '这个会话没有挂载注意力投影。',
        'mini.title': '注意力：关键信息份额 {pct}',
        'footer.note': '仅为估计值。DeepSeek API 不返回注意力权重。',
      };

      function L(t, key, fallback) {
        if (typeof t !== 'function') return fallback;
        try {
          var value = t(key);
          if (typeof value === 'string' && value.length > 0 && value !== key) return value;
        } catch (error) {
          // Fall back to the bundled English copy.
        }
        return fallback;
      }

      function format(template, values) {
        var output = String(template || '');
        Object.keys(values || {}).forEach(function (key) {
          output = output.split('{' + key + '}').join(String(values[key]));
        });
        return output;
      }

      var SETTINGS_KEY = 'dsh-attention-lens:settings:v1';
      var settingsListeners = new Set();
      var settingsSnapshot = null;

      function readSettings() {
        if (settingsSnapshot) return settingsSnapshot;
        var stored = null;
        try {
          stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        } catch (error) {
          stored = null;
        }
        settingsSnapshot = Object.assign({}, DEFAULTS, stored && typeof stored === 'object' ? stored : {});
        return settingsSnapshot;
      }

      function subscribeSettings(listener) {
        settingsListeners.add(listener);
        return function () { settingsListeners.delete(listener); };
      }

      function writeSettings(patch) {
        settingsSnapshot = Object.assign({}, readSettings(), patch);
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsSnapshot));
        } catch (error) {
          // Private browsing or a locked-down renderer; keep the in-memory value.
        }
        settingsListeners.forEach(function (listener) { listener(); });
      }

      function useSettings() {
        return useSyncExternalStore(subscribeSettings, readSettings, readSettings);
      }

      var PIN_PREFIX = 'dsh-attention-lens:pins:v1:';
      var pinStores = new Map();

      function pinStore(sessionId) {
        var key = PIN_PREFIX + str(sessionId);
        if (pinStores.has(key)) return pinStores.get(key);
        var listeners = new Set();
        var snapshot = null;
        function read() {
          if (snapshot) return snapshot;
          var stored = null;
          try {
            stored = JSON.parse(localStorage.getItem(key) || '[]');
          } catch (error) {
            stored = null;
          }
          snapshot = new Set(Array.isArray(stored) ? stored.filter(function (id) { return typeof id === 'string'; }) : []);
          return snapshot;
        }
        function toggle(id) {
          var next = new Set(read());
          if (next.has(id)) next.delete(id);
          else next.add(id);
          snapshot = next;
          try {
            localStorage.setItem(key, JSON.stringify(Array.from(next)));
          } catch (error) {
            // Keep the in-memory value.
          }
          listeners.forEach(function (listener) { listener(); });
        }
        function subscribe(listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        }
        var store = { read: read, toggle: toggle, subscribe: subscribe };
        pinStores.set(key, store);
        return store;
      }

      function usePins(sessionId) {
        var store = useMemo(function () { return pinStore(sessionId); }, [sessionId]);
        var pins = useSyncExternalStore(store.subscribe, store.read, store.read);
        return { pins: pins, toggle: store.toggle };
      }

      var CSS = [
        '.al-root{box-sizing:border-box;width:100%;height:100%;overflow:auto;padding:20px 24px 150px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;line-height:1.45;}',
        '.al-root *{box-sizing:border-box;}',
        '.al-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px;}',
        '.al-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
        '.al-title{margin:0;font-size:20px;line-height:1.2;font-weight:650;letter-spacing:-0.01em;}',
        '.al-sub{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;margin-top:3px;}',
        '.al-badge{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:999px;padding:1px 7px;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#6b7280);background:var(--dsw-alias-bg-layer-1,#fff);}',
        '.al-risk{white-space:nowrap;border-radius:999px;padding:5px 10px;font-size:11px;font-weight:600;border:1px solid transparent;}',
        '.al-risk-high{color:var(--dsw-alias-state-error-primary,#b91c1c);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 35%,transparent);}',
        '.al-risk-medium{color:var(--dsw-alias-state-warn-label,#92400e);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 35%,transparent);}',
        '.al-risk-low{color:var(--dsw-alias-state-success-primary,#15803d);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 35%,transparent);}',
        '.al-risk-unknown{color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-bg-layer-2,#f3f4f6);border-color:var(--dsw-alias-border-l1,#e5e7eb);}',
        '.al-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin-bottom:14px;}',
        '.al-metric{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);padding:11px 13px;min-width:0;}',
        '.al-label{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.al-value{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:2px;letter-spacing:-0.01em;}',
        '.al-subvalue{font-size:10px;color:var(--dsw-alias-label-tertiary,#9ca3af);margin-top:1px;font-variant-numeric:tabular-nums;}',
        '.al-card{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);padding:14px;min-width:0;}',
        '.al-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:9px;}',
        '.al-card-title{font-size:13px;font-weight:650;margin:0;}',
        '.al-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);margin:0 0 10px;}',
        '.al-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:14px;margin-bottom:14px;}',
        '.al-stack{display:flex;flex-direction:column;gap:14px;min-width:0;}',
        '.al-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}',
        '.al-curve{width:100%;height:auto;display:block;overflow:visible;}',
        '.al-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:var(--dsw-alias-label-secondary,#6b7280);margin-top:6px;}',
        '.al-legend-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:1px;}',
        '.al-heat-wrap{overflow-x:auto;padding-bottom:4px;}',
        '.al-heat{display:grid;gap:2px;min-width:520px;align-items:center;}',
        '.al-heat-label{font-size:10px;color:var(--dsw-alias-label-secondary,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:6px;}',
        '.al-heat-cell{height:16px;border-radius:3px;background:transparent;min-width:8px;}',
        '.al-heat-turn{font-size:9px;color:var(--dsw-alias-label-tertiary,#9ca3af);text-align:center;font-variant-numeric:tabular-nums;}',
        '.al-phase-row{display:grid;gap:2px;margin-bottom:3px;align-items:center;}',
        '.al-phase-block{height:8px;border-radius:2px;}',
        '.al-phase-label{font-size:9px;color:var(--dsw-alias-label-tertiary,#9ca3af);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}',
        '.al-list{display:flex;flex-direction:column;gap:5px;max-height:300px;overflow:auto;}',
        '.al-row{display:flex;align-items:center;gap:8px;border:1px solid transparent;border-radius:9px;padding:5px 6px;min-width:0;}',
        '.al-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);}',
        '.al-row-on{border-color:color-mix(in srgb,var(--dsw-alias-accent,#2563eb) 45%,transparent);background:var(--dsw-alias-accent-soft,color-mix(in srgb,var(--dsw-alias-accent,#2563eb) 8%,transparent));}',
        '.al-row-btn{appearance:none;border:0;background:transparent;color:inherit;font:inherit;text-align:left;flex:1;min-width:0;cursor:pointer;padding:0;display:flex;align-items:center;gap:7px;}',
        '.al-row-btn:focus-visible{outline:2px solid var(--dsw-alias-accent,#2563eb);outline-offset:2px;border-radius:5px;}',
        '.al-row-main{min-width:0;flex:1;}',
        '.al-row-preview{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.al-row-meta{font-size:9px;color:var(--dsw-alias-label-tertiary,#9ca3af);display:flex;gap:6px;margin-top:1px;}',
        '.al-row-share{font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;}',
        '.al-tag{display:inline-flex;align-items:center;border-radius:4px;padding:0 4px;font-size:9px;line-height:15px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;background:var(--dsw-alias-bg-layer-2,#f9fafb);}',
        '.al-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:7px;padding:3px 7px;font:inherit;font-size:10px;cursor:pointer;white-space:nowrap;}',
        '.al-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);}',
        '.al-btn:focus-visible{outline:2px solid var(--dsw-alias-accent,#2563eb);outline-offset:2px;}',
        '.al-btn-on{background:var(--dsw-alias-accent,#2563eb);border-color:var(--dsw-alias-accent,#2563eb);color:var(--dsw-alias-accent-ink,#fff);}',
        '.al-btn-on:hover{background:var(--dsw-alias-button-primary-hover,#1d4ed8);}',
        '.al-detail-preview{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);padding:8px;font-size:10px;line-height:1.45;max-height:110px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#4b5563);}',
        '.al-factor{display:grid;grid-template-columns:64px minmax(0,1fr) 42px;align-items:center;gap:7px;margin:4px 0;font-size:10px;}',
        '.al-factor-name{color:var(--dsw-alias-label-secondary,#6b7280);}',
        '.al-factor-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);overflow:hidden;}',
        '.al-factor-fill{height:100%;border-radius:999px;background:var(--dsw-alias-accent,#2563eb);}',
        '.al-factor-value{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#6b7280);}',
        '.al-empty{border:1px dashed var(--dsw-alias-border-l2,#d1d5db);border-radius:12px;padding:26px 18px;text-align:center;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;}',
        '.al-mini{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 2px;cursor:default;color:var(--dsw-alias-label-tertiary,#9ca3af);}',
        '.al-mini-label{font-size:9px;letter-spacing:.05em;text-transform:uppercase;}',
        '.al-settings{max-width:640px;padding:0;}',
        '.al-settings .al-card{margin-bottom:12px;}',
        '.al-form-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#f3f4f6);}',
        '.al-form-row:last-child{border-bottom:0;}',
        '.al-form-label{font-size:12px;}',
        '.al-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;overflow:hidden;}',
        '.al-seg button{appearance:none;border:0;border-right:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:10px;padding:5px 8px;cursor:pointer;}',
        '.al-seg button:last-child{border-right:0;}',
        '.al-seg button[aria-pressed="true"]{background:var(--dsw-alias-accent,#2563eb);color:var(--dsw-alias-accent-ink,#fff);}',
        '.al-range{width:150px;accent-color:var(--dsw-alias-accent,#2563eb);}',
        '.al-formula{font-size:10px;color:var(--dsw-alias-label-tertiary,#9ca3af);margin-top:4px;}',
        '.al-footer{font-size:10px;color:var(--dsw-alias-label-tertiary,#9ca3af);margin-top:8px;}',
        '@media (max-width:860px){.al-grid{grid-template-columns:1fr;}.al-root{padding:14px 14px 34px;}}',
        '@media (prefers-reduced-motion:reduce){.al-root *{transition:none!important;animation:none!important;}}',
      ].join('\n');

      function Styles() {
        return h('style', null, CSS);
      }

      var PHASE_COLORS = {
        plan: '#8b5cf6', explore: '#0ea5e9', implement: '#22c55e', debug: '#ef4444',
        review: '#f59e0b', handoff: '#64748b', respond: '#6366f1', idle: '#94a3b8',
      };

      function kindLabel(t, kind) {
        return L(t, 'kind.' + kind, kind);
      }

      function phaseLabel(t, phase) {
        return L(t, 'phase.' + phase, phase);
      }

      function riskLabel(t, risk) {
        return L(t, 'risk.' + risk, risk);
      }

      function Metric(props) {
        return h('div', { className: 'al-metric' },
          h('div', { className: 'al-label' }, props.label),
          h('div', { className: 'al-value' }, props.value),
          props.sub ? h('div', { className: 'al-subvalue' }, props.sub) : null);
      }

      function Hero(props) {
        var t = props.t;
        var report = props.report;
        return h('div', { className: 'al-head' },
          h('div', null,
            h('div', { className: 'al-title-row' },
              h('h2', { className: 'al-title' }, L(t, 'title', 'Attention Lens')),
              h('span', { className: 'al-badge' }, L(t, 'badge.estimate', 'Estimate'))),
            h('div', { className: 'al-sub' }, L(t, 'subtitle', 'Estimated attention share — not raw model attention.'))),
          h('div', { className: 'al-risk al-risk-' + report.risk },
            L(t, 'risk.label', 'Dilution risk') + ': ' + riskLabel(t, report.risk)));
      }

      function Metrics(props) {
        var t = props.t;
        var m = props.metrics;
        return h('div', { className: 'al-metrics' },
          h(Metric, {
            label: L(t, 'metric.context', 'Context'),
            value: fmtTokens(m.totalTokens),
            sub: pct(m.contextUsed) + ' ' + L(t, 'metric.tokens', 'of window'),
          }),
          h(Metric, {
            label: L(t, 'metric.critical', 'Critical share'),
            value: m.anchorCount > 0 ? pct(m.criticalShare) : '—',
            sub: m.anchorCount > 0 ? fmtTokens(m.criticalTokens) + ' tokens' : L(t, 'anchors.empty', 'Pin an anchor'),
          }),
          h(Metric, {
            label: L(t, 'metric.coverage', '80% attention on'),
            value: pct(m.coverage80),
            sub: 'tokens',
          }),
          h(Metric, {
            label: L(t, 'metric.cold', 'Cold zone'),
            value: pct(m.coldZoneShare),
            sub: '30–70%',
          }),
          h(Metric, {
            label: L(t, 'metric.hidden', 'Unobserved'),
            value: fmtTokens(m.unobservedTokens),
            sub: 'hidden context',
          }));
      }

      function curveBins(segments, total) {
        var bins = new Array(100).fill(0);
        for (var i = 0; i < segments.length; i++) {
          var segment = segments[i];
          if (segment.tokens <= 0 || total <= 0) continue;
          var from = clamp(Math.floor(segment.position * 100), 0, 99);
          var to = clamp(Math.floor((segment.end / total) * 100), from, 99);
          var count = Math.max(1, to - from + 1);
          for (var b = from; b <= to; b++) bins[b] += segment.share / count;
        }
        return bins;
      }

      function Curve(props) {
        var t = props.t;
        var segments = props.segments;
        var total = props.total;
        var anchors = props.anchors;
        var bins = curveBins(segments, total);
        var max = 0;
        for (var i = 0; i < bins.length; i++) if (bins[i] > max) max = bins[i];
        var W = 760;
        var H = 175;
        var left = 38;
        var right = 16;
        var top = 10;
        var bottom = 26;
        var innerW = W - left - right;
        var innerH = H - top - bottom;
        var x = function (index) { return left + (index / 99) * innerW; };
        var y = function (value) { return top + (1 - (max > 0 ? value / max : 0)) * innerH; };
        var points = bins.map(function (value, index) { return [x(index), y(value)]; });
        var line = points.map(function (point, index) { return (index === 0 ? 'M' : 'L') + point[0].toFixed(1) + ' ' + point[1].toFixed(1); }).join(' ');
        var area = line + ' L' + x(99).toFixed(1) + ' ' + (top + innerH).toFixed(1)
          + ' L' + x(0).toFixed(1) + ' ' + (top + innerH).toFixed(1) + ' Z';
        var prior = bins.map(function (_, index) { return positionPrior((index + 0.5) / 100); });
        var maxPrior = Math.max.apply(null, prior.concat([0.01]));
        var priorLine = prior.map(function (value, index) {
          return (index === 0 ? 'M' : 'L') + x(index).toFixed(1) + ' '
            + (top + (1 - value / maxPrior) * innerH).toFixed(1);
        }).join(' ');
        var coldX = x(30);
        var coldW = x(70) - coldX;
        var anchorMarks = anchors.map(function (anchor) {
          var segment = segments.filter(function (item) { return item.id === anchor.id; })[0];
          if (!segment) return null;
          var bin = clamp(Math.floor(segment.position * 100), 0, 99);
          return h('circle', {
            key: anchor.id, cx: x(bin), cy: y(bins[bin]), r: 3.4,
            fill: 'var(--dsw-alias-state-warn-primary,#f59e0b)',
            stroke: 'var(--dsw-alias-bg-layer-1,#fff)', strokeWidth: 1.2,
          }, h('title', null, (anchor.label || anchor.id) + ' · ' + pct(anchor.currentShare)));
        });
        var systemSegment = segments.filter(function (item) { return item.kind === 'system'; })[0];
        var userSegments = segments.filter(function (item) { return item.kind === 'user'; });
        var querySegment = userSegments[userSegments.length - 1];
        var queryMark = querySegment ? h('circle', {
          cx: x(clamp(Math.floor(querySegment.position * 100), 0, 99)),
          cy: y(bins[clamp(Math.floor(querySegment.position * 100), 0, 99)]),
          r: 3.2, fill: 'var(--dsw-alias-accent,#2563eb)',
          stroke: 'var(--dsw-alias-bg-layer-1,#fff)', strokeWidth: 1.2,
        }, h('title', null, 'current query · ' + pct(querySegment.share))) : null;
        return h('div', null,
          h('div', { className: 'al-card-head' },
            h('h3', { className: 'al-card-title' }, L(t, 'curve.title', 'Attention curve')),
            h('span', { className: 'al-row-meta' }, L(t, 'badge.estimate', 'Estimate'))),
          h('p', { className: 'al-hint' }, L(t, 'curve.hint', 'Estimated density per token across context position.')),
          h('svg', {
            className: 'al-curve', viewBox: '0 0 ' + W + ' ' + H,
            role: 'img', 'aria-label': L(t, 'curve.title', 'Attention curve'),
          },
            h('rect', { x: coldX, y: top, width: coldW, height: innerH, rx: 6, fill: 'color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 9%,transparent)' }),
            [0.25, 0.5, 0.75].map(function (level) {
              return h('line', {
                key: 'grid' + level, x1: left, x2: W - right,
                y1: top + innerH * level, y2: top + innerH * level,
                stroke: 'var(--dsw-alias-border-l1,#e5e7eb)', strokeWidth: 0.7,
                strokeDasharray: level === 0.5 ? '3 4' : undefined,
              });
            }),
            h('path', { d: priorLine, fill: 'none', stroke: 'var(--dsw-alias-label-tertiary,#9ca3af)', strokeWidth: 1.2, strokeDasharray: '4 5', opacity: 0.6 }),
            h('path', { d: area, fill: 'color-mix(in srgb,var(--dsw-alias-accent,#2563eb) 12%,transparent)' }),
            h('path', { d: line, fill: 'none', stroke: 'var(--dsw-alias-accent,#2563eb)', strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }),
            h('line', { x1: x(99), x2: x(99), y1: top, y2: top + innerH, stroke: 'var(--dsw-alias-border-l2,#d1d5db)', strokeWidth: 1, strokeDasharray: '2 3' }),
            systemSegment ? h('circle', {
              cx: x(clamp(Math.floor(systemSegment.position * 100), 0, 99)),
              cy: y(bins[clamp(Math.floor(systemSegment.position * 100), 0, 99)]),
              r: 3.2, fill: 'var(--dsw-alias-state-success-primary,#22c55e)',
              stroke: 'var(--dsw-alias-bg-layer-1,#fff)', strokeWidth: 1.2,
            }, h('title', null, 'system · ' + pct(systemSegment.share))) : null,
            anchorMarks,
            queryMark,
            h('text', { x: left, y: H - 8, fontSize: 10, fill: 'var(--dsw-alias-label-tertiary,#9ca3af)' }, L(t, 'curve.start', 'start')),
            h('text', { x: left + innerW * 0.5, y: H - 8, textAnchor: 'middle', fontSize: 10, fill: 'var(--dsw-alias-label-tertiary,#9ca3af)' }, L(t, 'curve.cold', 'cold zone')),
            h('text', { x: W - right, y: H - 8, textAnchor: 'end', fontSize: 10, fill: 'var(--dsw-alias-label-tertiary,#9ca3af)' }, L(t, 'curve.now', 'now'))));
      }

      function Heatmap(props) {
        var t = props.t;
        var heatmap = props.heatmap;
        var phases = props.phases;
        var turns = heatmap.turns;
        var phaseByTurn = new Map();
        for (var p = 0; p < phases.length; p++) phaseByTurn.set(phases[p].turn, phases[p]);
        if (turns.length === 0 || heatmap.rows.length === 0) {
          return h('div', null,
            h('div', { className: 'al-card-head' },
              h('h3', { className: 'al-card-title' }, L(t, 'heatmap.title', 'Attention heatmap'))),
            h('p', { className: 'al-hint' }, L(t, 'heatmap.hint', 'Rows are segments; columns are turns.')));
        }
        var columns = '150px repeat(' + turns.length + ',minmax(10px,1fr))';
        return h('div', null,
          h('div', { className: 'al-card-head' },
            h('h3', { className: 'al-card-title' }, L(t, 'heatmap.title', 'Attention heatmap')),
            h('span', { className: 'al-row-meta' }, turns.length > 0 ? 'T' + turns[0] + '–T' + turns[turns.length - 1] : '')),
          h('p', { className: 'al-hint' }, L(t, 'heatmap.hint', 'Rows are segments; columns are turns.')),
          h('div', { className: 'al-heat-wrap' },
            h('div', { className: 'al-phase-row', style: { gridTemplateColumns: columns } },
              h('div', { className: 'al-phase-label' }, 'phase'),
              turns.map(function (turn) {
                var phase = phaseByTurn.get(turn);
                var name = phase ? phase.phase : 'idle';
                return h('div', {
                  key: 'p' + turn, className: 'al-phase-block',
                  title: 'T' + turn + ' · ' + phaseLabel(t, name) + (phase && phase.ms ? ' · ' + fmtMs(phase.ms) : ''),
                  style: { background: PHASE_COLORS[name] || PHASE_COLORS.idle, opacity: 0.8 },
                });
              })),
            h('div', { className: 'al-heat', style: { gridTemplateColumns: columns } },
              [h('div', { key: 'corner', className: 'al-heat-label' }, 'segment')].concat(
                turns.map(function (turn) {
                  return h('div', { key: 't' + turn, className: 'al-heat-turn' }, String(turn));
                }),
                heatmap.rows.flatMap(function (row) {
                  var cells = [h('div', { key: 'l' + row.id, className: 'al-heat-label', title: row.label },
                    h('span', { className: 'al-tag', style: { marginRight: 4 } }, kindLabel(t, row.kind)),
                    row.label.slice(0, 26))];
                  for (var c = 0; c < row.cells.length; c++) {
                    var value = row.cells[c];
                    var alpha = heatmap.max > 0 ? 0.06 + (value / heatmap.max) * 0.88 : 0.03;
                    cells.push(h('div', {
                      key: row.id + '-' + c, className: 'al-heat-cell',
                      title: 'T' + turns[c] + ' · ' + pct(value),
                      style: { background: value > 0 ? 'color-mix(in srgb,var(--dsw-alias-accent,#2563eb) ' + Math.round(alpha * 100) + '%,transparent)' : 'transparent' },
                    }));
                  }
                  return cells;
                })))));
      }

      function AnchorList(props) {
        var t = props.t;
        var anchors = props.anchors;
        var pins = props.pins;
        var onToggle = props.onToggle;
        return h('div', null,
          h('div', { className: 'al-card-head' },
            h('h3', { className: 'al-card-title' }, L(t, 'anchors.title', 'Anchors')),
            h('span', { className: 'al-row-meta' }, String(pins.size))),
          anchors.length === 0
            ? h('p', { className: 'al-hint' }, L(t, 'anchors.empty', 'Pin a segment below to track its dilution.'))
            : h('div', { className: 'al-list' }, anchors.map(function (anchor) {
              var pinned = pins.has(anchor.id);
              return h('div', { key: anchor.id, className: 'al-row' },
                h('div', { className: 'al-row-main' },
                  h('div', { className: 'al-row-preview', title: anchor.label }, anchor.label || anchor.id),
                  h('div', { className: 'al-row-meta' },
                    h('span', { className: 'al-tag' }, kindLabel(t, anchor.kind)),
                    anchor.auto ? h('span', { className: 'al-tag' }, L(t, 'anchors.auto', 'Auto anchor')) : null,
                    h('span', null, pct(anchor.currentShare)),
                    h('span', null, anchor.timeToThreshold !== null
                      ? format(L(t, 'anchors.countdown', 'Below threshold in {n} turns'), { n: anchor.timeToThreshold })
                      : L(t, 'anchors.holds', 'Above threshold through the forecast')))),
                h('button', {
                  type: 'button', className: 'al-btn' + (pinned ? ' al-btn-on' : ''),
                  'aria-pressed': pinned,
                  onClick: function () { onToggle(anchor.id); },
                }, pinned ? L(t, 'anchors.unpin', 'Unpin') : L(t, 'anchors.pin', 'Pin')));
            })));
      }

      function SegmentList(props) {
        var t = props.t;
        var segments = props.segments;
        var pins = props.pins;
        var selected = props.selected;
        var onSelect = props.onSelect;
        var onToggle = props.onToggle;
        return h('div', null,
          h('div', { className: 'al-card-head' },
            h('h3', { className: 'al-card-title' }, L(t, 'segments.title', 'Segments')),
            h('span', { className: 'al-row-meta' }, String(segments.length))),
          h('p', { className: 'al-hint' }, L(t, 'segments.hint', 'Top segments by estimated share.')),
          h('div', { className: 'al-list' }, segments.map(function (segment) {
            var pinned = pins.has(segment.id);
            return h('div', {
              key: segment.id, className: 'al-row' + (selected === segment.id ? ' al-row-on' : ''),
            },
              h('button', {
                type: 'button', className: 'al-row-btn',
                onClick: function () { onSelect(segment.id); },
                title: segment.preview || segment.kind,
              },
                h('span', { className: 'al-tag' }, kindLabel(t, segment.kind)),
                h('span', { className: 'al-row-main' },
                  h('span', { className: 'al-row-preview' }, segment.preview || segment.kind),
                  h('span', { className: 'al-row-meta' },
                    h('span', null, 'T' + segment.turn),
                    segment.tool ? h('span', null, segment.tool) : null,
                    h('span', null, fmtTokens(segment.tokens) + ' ' + L(t, 'detail.tokens', 'tokens'))))),
              h('span', { className: 'al-row-share' }, pct(segment.share)),
              h('button', {
                type: 'button', className: 'al-btn' + (pinned ? ' al-btn-on' : ''),
                'aria-pressed': pinned,
                onClick: function () { onToggle(segment.id); },
              }, pinned ? L(t, 'anchors.unpin', 'Unpin') : L(t, 'anchors.pin', 'Pin')));
          })));
      }

      function Detail(props) {
        var t = props.t;
        var segment = props.segment;
        if (!segment) {
          return h('div', null,
            h('div', { className: 'al-card-head' }, h('h3', { className: 'al-card-title' }, L(t, 'detail.title', 'Why this share'))),
            h('p', { className: 'al-hint' }, L(t, 'detail.empty', 'Click a segment to inspect its factors.')));
        }
        var factors = [
          ['pos', 'Position', segment.factors ? segment.factors.pos : 1],
          ['type', 'Type', segment.factors ? segment.factors.type : 1],
          ['rel', 'Relevance', segment.factors ? segment.factors.rel : 1],
          ['sal', 'Salience', segment.factors ? segment.factors.sal : 1],
          ['age', 'Age', segment.factors ? segment.factors.age : 1],
          ['pin', 'Pin', segment.factors ? segment.factors.pin : 1],
        ];
        var maxFactor = Math.max.apply(null, factors.map(function (factor) { return factor[2]; }).concat([1]));
        return h('div', null,
          h('div', { className: 'al-card-head' },
            h('h3', { className: 'al-card-title' }, L(t, 'detail.title', 'Why this share')),
            h('span', { className: 'al-row-meta' }, pct(segment.share))),
          h('div', { className: 'al-row-meta', style: { marginBottom: 8 } },
            h('span', { className: 'al-tag' }, kindLabel(t, segment.kind)),
            h('span', null, 'T' + segment.turn),
            segment.tool ? h('span', null, segment.tool) : null,
            h('span', null, fmtTokens(segment.tokens) + ' ' + L(t, 'detail.tokens', 'tokens')),
            h('span', null, L(t, 'detail.density', 'density') + ' ' + Number(segment.density || 0).toFixed(2) + '/1k'),
            segment.approx ? h('span', null, L(t, 'detail.approx', 'approximate tokens')) : null),
          factors.map(function (factor) {
            return h('div', { key: factor[0], className: 'al-factor' },
              h('span', { className: 'al-factor-name' }, factor[1]),
              h('span', { className: 'al-factor-track' },
                h('span', { className: 'al-factor-fill', style: { width: clamp(factor[2] / maxFactor * 100, 2, 100) + '%' } })),
              h('span', { className: 'al-factor-value' }, '×' + Number(factor[2]).toFixed(2)));
          }),
          h('div', { className: 'al-formula' }, L(t, 'detail.formula', 'share = weight ÷ total weight')),
          h('div', { style: { marginTop: 9 } },
            h('div', { className: 'al-label', style: { marginBottom: 4 } }, L(t, 'detail.preview', 'Preview')),
            h('div', { className: 'al-detail-preview al-mono' }, segment.preview || '—')));
      }

      function ForecastChart(props) {
        var t = props.t;
        var fc = props.forecast;
        var points = fc.points;
        if (points.length === 0) {
          return h('p', { className: 'al-hint' }, L(t, 'forecast.empty', 'Pin an anchor to get a countdown.'));
        }
        var W = 420;
        var H = 150;
        var left = 34;
        var right = 12;
        var top = 12;
        var bottom = 26;
        var innerW = W - left - right;
        var innerH = H - top - bottom;
        var maxValue = Math.max(0.2, Math.max.apply(null, points.map(function (point) { return point.high || point.criticalShare; })) * 1.2);
        var x = function (index) { return left + (points.length <= 1 ? 0 : (index / (points.length - 1)) * innerW); };
        var y = function (value) { return top + (1 - clamp(value / maxValue, 0, 1)) * innerH; };
        var line = points.map(function (point, index) { return (index === 0 ? 'M' : 'L') + x(index).toFixed(1) + ' ' + y(point.criticalShare).toFixed(1); }).join(' ');
        var upper = points.map(function (point, index) { return (index === 0 ? 'M' : 'L') + x(index).toFixed(1) + ' ' + y(point.high).toFixed(1); }).join(' ');
        var lower = points.slice().reverse().map(function (point, index) {
          var original = points.length - 1 - index;
          return 'L' + x(original).toFixed(1) + ' ' + y(point.low).toFixed(1);
        }).join(' ');
        var thresholdY = y(fc.assumptions.threshold);
        return h('div', null,
          h('svg', { className: 'al-curve', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': L(t, 'forecast.title', 'Dilution forecast') },
            h('line', { x1: left, x2: W - right, y1: thresholdY, y2: thresholdY, stroke: 'var(--dsw-alias-state-warn-primary,#f59e0b)', strokeWidth: 1, strokeDasharray: '4 4' }),
            h('path', { d: upper + lower + ' Z', fill: 'color-mix(in srgb,var(--dsw-alias-accent,#2563eb) 10%,transparent)' }),
            h('path', { d: line, fill: 'none', stroke: 'var(--dsw-alias-accent,#2563eb)', strokeWidth: 2, strokeLinejoin: 'round' }),
            points.map(function (point, index) {
              return h('circle', {
                key: point.turn, cx: x(index), cy: y(point.criticalShare), r: 2,
                fill: 'var(--dsw-alias-accent,#2563eb)',
              }, h('title', null, 'T' + point.turn + ' · ' + pct(point.criticalShare)));
            }),
            h('text', { x: left, y: H - 7, fontSize: 9, fill: 'var(--dsw-alias-label-tertiary,#9ca3af)' }, 'T' + points[0].turn),
            h('text', { x: W - right, y: H - 7, textAnchor: 'end', fontSize: 9, fill: 'var(--dsw-alias-label-tertiary,#9ca3af)' }, 'T' + points[points.length - 1].turn),
            h('text', { x: left, y: thresholdY - 3, fontSize: 9, fill: 'var(--dsw-alias-state-warn-primary,#b45309)' }, pct(fc.assumptions.threshold))));
      }

      function ForecastCard(props) {
        var t = props.t;
        var fc = props.forecast;
        return h('div', null,
          h('div', { className: 'al-card-head' },
            h('h3', { className: 'al-card-title' }, L(t, 'forecast.title', 'Dilution forecast')),
            h('span', { className: 'al-row-meta' }, L(t, 'badge.estimate', 'Estimate'))),
          h('p', { className: 'al-hint' }, L(t, 'forecast.hint', 'Projection, not a prophecy.')),
          h(ForecastChart, { forecast: fc, t: t }),
          h('div', { className: 'al-formula' },
            format(L(t, 'forecast.assume', 'Assumes {tokens} tokens/turn over {turns} turns; threshold {pct}.'), {
              tokens: fmtTokens(fc.assumptions.avgTurnTokens),
              turns: fc.assumptions.horizon,
              pct: pct(fc.assumptions.threshold),
            })),
          fc.anchors.length > 0 ? h('div', { className: 'al-list', style: { marginTop: 8 } }, fc.anchors.map(function (anchor) {
            return h('div', { key: anchor.id, className: 'al-row' },
              h('div', { className: 'al-row-main' },
                h('div', { className: 'al-row-preview' }, anchor.label || anchor.id),
                h('div', { className: 'al-row-meta' },
                  h('span', null, pct(anchor.currentShare)),
                  h('span', null, anchor.timeToThreshold !== null
                    ? format(L(t, 'anchors.countdown', 'Below threshold in {n} turns'), { n: anchor.timeToThreshold })
                    : L(t, 'anchors.holds', 'Above threshold through the forecast')))));
          })) : null);
      }

      function Empty(props) {
        var t = props.t;
        var message = props.reason === 'wait'
          ? L(t, 'empty.wait', 'Waiting for session data…')
          : props.reason === 'noProjection'
            ? L(t, 'empty.noProjection', 'The Attention projection is not mounted for this session.')
            : L(t, 'empty.short', 'This session is too short for an attention curve.');
        return h('div', { className: 'al-root' }, h(Styles), h('div', { className: 'al-empty' }, message));
      }

      function AttentionTab(props) {
        var t = props.t;
        var view = typeof props.useProjection === 'function' ? props.useProjection('attentionLens') : undefined;
        var settings = useSettings();
        var pinState = usePins(str(props.sessionId) || str(view && view.sessionId));
        var report = useMemo(function () {
          return buildReport(view, {
            preset: settings.preset, threshold: settings.threshold,
            horizon: settings.horizon, pins: pinState.pins,
          });
        }, [view, settings.preset, settings.threshold, settings.horizon, pinState.pins]);
        var selectionState = useState(null);
        var selected = selectionState[0];
        var setSelected = selectionState[1];
        if (!view) return h(Empty, { t: t, reason: typeof props.useProjection === 'function' ? 'wait' : 'noProjection' });
        if (report.empty) return h(Empty, { t: t, reason: report.reason });
        var selectedSegment = selected
          ? report.base.segments.filter(function (segment) { return segment.id === selected; })[0]
          : null;
        if (!selectedSegment && report.top.length > 0) selectedSegment = report.top[0];
        return h('div', { className: 'al-root' },
          h(Styles),
          h(Hero, { t: t, report: report }),
          h(Metrics, { t: t, metrics: report.metrics }),
          h('div', { className: 'al-card', style: { marginBottom: 14 } },
            h(Curve, {
              t: t, segments: report.base.segments, total: report.base.totalTokens,
              anchors: report.forecast.anchors,
            })),
          h('div', { className: 'al-grid' },
            h('div', { className: 'al-card' },
              h(Heatmap, { t: t, heatmap: report.heatmap, phases: report.phases })),
            h('div', { className: 'al-stack' },
              h('div', { className: 'al-card' },
                h(AnchorList, {
                  t: t, anchors: report.forecast.anchors, pins: pinState.pins,
                  onToggle: pinState.toggle,
                })),
              h('div', { className: 'al-card' },
                h(ForecastCard, { t: t, forecast: report.forecast })))),
          h('div', { className: 'al-grid' },
            h('div', { className: 'al-card' },
              h(SegmentList, {
                t: t, segments: report.top, pins: pinState.pins,
                selected: selectedSegment ? selectedSegment.id : null,
                onSelect: setSelected, onToggle: pinState.toggle,
              })),
            h('div', { className: 'al-card' },
              h(Detail, { t: t, segment: selectedSegment }))),
          h('div', { className: 'al-footer' }, L(t, 'footer.note', 'Estimates only. DeepSeek API does not expose attention weights.')));
      }

      function Sparkline(props) {
        var values = props.values;
        var width = props.width || 72;
        var height = props.height || 18;
        if (!values || values.length === 0) return null;
        var max = Math.max.apply(null, values.concat([0.01]));
        var min = Math.min.apply(null, values.concat([0]));
        var span = Math.max(0.001, max - min);
        var points = values.map(function (value, index) {
          var x = values.length <= 1 ? 1 : (index / (values.length - 1)) * (width - 2) + 1;
          var y = height - 2 - ((value - min) / span) * (height - 4);
          return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        return h('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, 'aria-hidden': 'true' },
          h('polyline', { points: points, fill: 'none', stroke: props.color || 'var(--dsw-alias-accent,#2563eb)', strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round' }));
      }

      function MiniCurve(props) {
        var t = props.t;
        var view = typeof props.useProjection === 'function' ? props.useProjection('attentionLens') : undefined;
        var settings = useSettings();
        var pinState = usePins(str(props.sessionId) || str(view && view.sessionId));
        var series = useMemo(function () {
          if (!view) return { points: [] };
          return computeSeries(view, { preset: settings.preset, pins: pinState.pins });
        }, [view, settings.preset, pinState.pins]);
        if (!view || series.points.length === 0) return null;
        var values = series.points.map(function (point) { return point.criticalShare; });
        var last = values[values.length - 1] || 0;
        var color = last < 0.04 ? 'var(--dsw-alias-state-error-primary,#ef4444)'
          : last < 0.08 ? 'var(--dsw-alias-state-warn-primary,#f59e0b)'
            : 'var(--dsw-alias-state-success-primary,#22c55e)';
        return h('div', {
          className: 'al-mini',
          title: format(L(t, 'mini.title', 'Attention: {pct} critical share'), { pct: pct(last) }),
        },
          h(Sparkline, { values: values, color: color }),
          h('span', { className: 'al-mini-label' }, 'AL'));
      }

      function SettingsPanel(props) {
        var t = props.t;
        var settings = useSettings();
        function update(patch) { writeSettings(patch); }
        var presets = [
          ['balanced', L(t, 'settings.balanced', 'Balanced')],
          ['recency', L(t, 'settings.recency', 'Recency-heavy')],
          ['instruction', L(t, 'settings.instruction', 'Instruction-heavy')],
        ];
        return h('div', { className: 'al-root al-settings' },
          h(Styles),
          h('div', { className: 'al-head' },
            h('div', null,
              h('h2', { className: 'al-title' }, L(t, 'settings.title', 'Attention Lens')),
              h('div', { className: 'al-sub' }, L(t, 'subtitle', 'Estimated attention share — not raw model attention.'))),
            h('span', { className: 'al-badge' }, L(t, 'badge.estimate', 'Estimate'))),
          h('div', { className: 'al-card' },
            h('div', { className: 'al-form-row' },
              h('span', { className: 'al-form-label' }, L(t, 'settings.preset', 'Model preset')),
              h('div', { className: 'al-seg' }, presets.map(function (preset) {
                return h('button', {
                  key: preset[0], type: 'button', 'aria-pressed': settings.preset === preset[0],
                  onClick: function () { update({ preset: preset[0] }); },
                }, preset[1]);
              }))),
            h('div', { className: 'al-form-row' },
              h('span', { className: 'al-form-label' }, L(t, 'settings.threshold', 'Anchor threshold')),
              h('span', { className: 'al-row-meta' }, pct(settings.threshold)),
              h('input', {
                className: 'al-range', type: 'range', min: 0.01, max: 0.2, step: 0.005,
                value: settings.threshold,
                'aria-label': L(t, 'settings.threshold', 'Anchor threshold'),
                onChange: function (event) { update({ threshold: Number(event.target.value) }); },
              })),
            h('div', { className: 'al-form-row' },
              h('span', { className: 'al-form-label' }, L(t, 'settings.horizon', 'Forecast turns')),
              h('span', { className: 'al-row-meta' }, String(settings.horizon)),
              h('input', {
                className: 'al-range', type: 'range', min: 4, max: 40, step: 1,
                value: settings.horizon,
                'aria-label': L(t, 'settings.horizon', 'Forecast turns'),
                onChange: function (event) { update({ horizon: Number(event.target.value) }); },
              })),
            h('div', { className: 'al-form-row' },
              h('span', { className: 'al-form-label' }, L(t, 'settings.note', 'Settings are stored in this browser.')),
              h('button', {
                type: 'button', className: 'al-btn',
                onClick: function () { update(DEFAULTS); },
              }, L(t, 'settings.reset', 'Reset')))),
          h('details', { className: 'al-card' },
            h('summary', { className: 'al-card-title', style: { cursor: 'pointer' } }, L(t, 'settings.how', 'How this is estimated')),
            h('p', { className: 'al-hint', style: { marginTop: 8 } }, L(t, 'settings.how.body', 'The provider does not expose attention weights.')),
            h('div', { className: 'al-formula' }, 'w = P(pos) × T(kind) × R(query) × S(text) × D(age) × A(pin)'),
            h('div', { className: 'al-formula' }, 'share = w ÷ Σw')));
      }

      return {
        inject: ['slots', 'locale'],
        apply: function (ctx) {
          var NS = 'attentionLens';
          ctx.effect(function () {
            return ctx.locale.register(NS, { zh: ZH, en: EN });
          }, 'attention-lens: dictionaries');
          var t = ctx.locale.bind(NS);
          ctx.slots.inject('conversation.view', function () {
            return ctx.slots.register({
              name: 'conversation.view',
              id: 'attention-lens',
              order: 20,
              label: function () { return L(t, 'view.attention', 'Attention'); },
              locale: NS,
            }, AttentionTab);
          });
          ctx.slots.inject('conversation.composer.dock', function () {
            return ctx.slots.register({
              name: 'conversation.composer.dock',
              id: 'attention-mini',
              order: 30,
              locale: NS,
            }, MiniCurve);
          });
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'attention-lens',
              order: 60,
              label: function () { return L(t, 'settings.title', 'Attention Lens'); },
              locale: NS,
            }, SettingsPanel);
          });
        },
      };
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
