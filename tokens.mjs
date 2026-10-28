/**
 * Host-side text helpers for Attention Lens.
 *
 * Token counts are estimates unless the token-meter service is available. The
 * fixed DSH heuristic underprices CJK text, so the fallback below weights CJK
 * characters separately and is deliberately conservative.
 */

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]{2,}/gu;
const LATIN_WORD = /[a-z][a-z0-9_+-]{1,}/gu;
const MAX_KEYWORD_INPUT = 12000;

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'had',
  'was', 'were', 'are', 'you', 'your', 'can', 'could', 'should', 'would',
  'will', 'not', 'but', 'what', 'when', 'where', 'which', 'who', 'how',
  'into', 'than', 'then', 'there', 'their', 'them', 'they', 'its', 'it\’s',
  'about', 'after', 'before', 'because', 'while', 'also', 'just', 'only',
  'more', 'most', 'some', 'such', 'very', 'like', 'over', 'under', 'again',
  'still', 'each', 'other', 'same', 'use', 'used', 'using', 'get', 'got',
]);

const CJK_STOP = new Set([
  '的', '了', '是', '在', '和', '就', '不', '也', '都', '而', '及', '与',
  '着', '或', '一个', '我们', '你们', '他们', '这个', '那个', '可以',
  '如果', '因为', '所以', '但是', '然后', '现在', '已经', '还是', '没有',
  '需要', '使用', '进行', '这个', '那个', '什么', '怎么', '为什么',
]);

/** Rough token estimate for text without a provider tokenizer. */
export function heuristicTokens(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of value) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.max(1, Math.ceil(cjk + other / 3.2));
}

/** Flatten model content blocks into readable text. */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof content.text === 'string') {
      return content.text;
    }
    return '';
  }
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
      continue;
    }
    if (typeof block.content === 'string' && block.content.length > 0) {
      parts.push(block.content);
      continue;
    }
    if (block.type === 'image') {
      parts.push('[image]');
      continue;
    }
    if (block.type === 'tool-call') {
      const name = typeof block.name === 'string' ? block.name : 'tool';
      parts.push(`[tool call: ${name}]`);
    }
  }
  return parts.join('\n');
}

/** Normalize whitespace and cap a preview at a readable length. */
export function previewText(text, limit = 140) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Lightweight bilingual keyword bag. It is not a tokenizer: it exists so the
 * client can estimate lexical relevance without receiving full tool output.
 */
export function keywordsOf(text, limit = 12) {
  const value = String(text ?? '').slice(0, MAX_KEYWORD_INPUT).toLowerCase();
  if (value.length === 0) return [];
  const counts = new Map();
  for (const word of value.match(LATIN_WORD) ?? []) {
    if (word.length < 3 || STOP.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  for (const run of value.match(CJK_RUN) ?? []) {
    for (let i = 0; i < run.length - 1; i++) {
      const bigram = run.slice(i, i + 2);
      if (CJK_STOP.has(bigram)) continue;
      counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, limit))
    .map(([word]) => word);
}

const FILE_READ = new Set([
  'read', 'read_file', 'grep', 'glob', 'search_files', 'list_dir', 'ls', 'view',
]);
const FILE_WRITE = new Set([
  'write', 'write_file', 'edit', 'edit_file', 'str_replace_editor', 'apply_patch',
  'create_file', 'notebook_edit', 'replace',
]);

/** Map a tool name to the segment kind used by the attention model. */
export function classifyTool(name) {
  const tool = String(name ?? '').toLowerCase();
  if (tool.length === 0) return 'tool_result';
  if (/web[_-]?(search|fetch)|browser|http/.test(tool)) return 'web';
  if (/subagent|delegate|\btask\b/.test(tool)) return 'subagent';
  if (FILE_READ.has(tool) || FILE_WRITE.has(tool) || tool.endsWith('_file')) return 'file';
  if (/todo|plan|goal/.test(tool)) return 'todo';
  return 'tool_result';
}

/** Whether a segment's preview reads like an explicit constraint. */
export function isConstraintText(text) {
  const value = String(text ?? '');
  return /\b(must|never|only|required|always|do not|don\’t|don't|shall)\b/i.test(value)
    || /必须|不要|禁止|只能|务必|一定|不得|仅限/.test(value);
}

/** Whether a preview looks like code or a patch. */
export function looksLikeCode(text) {
  const value = String(text ?? '');
  return /[{};]|=>|\b(function|const|let|class|import|export|return)\b/.test(value)
    || /^\s*[+-]\s/m.test(value);
}

/** Whether a preview carries a filesystem path. */
export function looksLikePath(text) {
  const value = String(text ?? '');
  return /<path>|[a-z]:\\|\/(?:[\w.-]+\/){1,}/i.test(value);
}

/** A short human label for a tool name. */
export function toolLabel(name) {
  const tool = String(name ?? '').trim();
  return tool.length > 0 ? tool : 'tool';
}
