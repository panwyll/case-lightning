/** Every model the engine is configured with is sent only the parameters it accepts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportsAdaptiveThinking } from '../../../lib/server/engine/llm';
import { config } from '../../../lib/server/config';

test('the classifier (Haiku 4.5) gets no adaptive thinking or effort; the Claude 5 readers do', () => {
  assert.equal(supportsAdaptiveThinking('claude-haiku-4-5'), false);
  assert.equal(supportsAdaptiveThinking('claude-haiku-4-5-20251001'), false);
  assert.equal(supportsAdaptiveThinking('claude-sonnet-4-5'), false);
  for (const m of ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5']) assert.equal(supportsAdaptiveThinking(m), true, m);
  assert.equal(supportsAdaptiveThinking(config.engineClassifyModel), !/haiku/i.test(config.engineClassifyModel));
});
