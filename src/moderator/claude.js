// Claude-backed moderator: llm.js's prompts, sent to the Anthropic API. Loaded only when Anthropic
// credentials are configured, or FORUM_MODERATOR=claude.
import { SYSTEM, createLlmModerator } from './llm.js';

const MODEL = process.env.FORUM_CLAUDE_MODEL ?? 'claude-opus-5-5';

export async function createClaudeModerator() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  return createLlmModerator('claude', async (prompt, schema) => {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4096,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason !== 'end_turn') {
      throw new Error(`Claude moderator stopped with ${response.stop_reason}`);
    }
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('Claude moderator returned no text');
    return JSON.parse(text);
  });
}
