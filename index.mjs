import z from '@deepseek-ai/schemastery';
import { createAttentionProjection } from './projection.mjs';

export const name = 'attention-lens';

// The projection registry owns the lifecycle of the unit registered below.
export const inject = ['sessionProjections'];

export const Config = z.object({
  maxSegments: z.number().default(400),
  tokenizer: z.string().default('auto'),
});

/**
 * Host half: reconstruct model-visible context from committed session events.
 * No tools, model calls, prompt edits, or process launches happen here.
 */
export function apply(ctx, config) {
  ctx.effect(
    () => ctx.sessionProjections.register(createAttentionProjection(ctx, config ?? {})),
    'attention-lens: projection',
  );
}
