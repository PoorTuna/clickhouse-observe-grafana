/**
 * Thin client for any OpenAI-compatible `/chat/completions` endpoint — hosted (OpenAI, MiniMax,
 * …) or self-hosted (Ollama, vLLM, llama.cpp server, …). Called directly from the browser (no
 * Go backend proxy in this iteration — see AiProviderConfig doc comment in types.ts for the
 * token-secrecy tradeoff that implies).
 */

import { AiProviderConfig } from '../types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Send a chat completion request and return the assistant's raw text content.
 * Throws a readable Error on network failure, non-2xx response, or an unexpected response shape
 * — callers in this feature treat all of those as "best effort failed" and fall back gracefully.
 */
export async function chatCompletion(cfg: AiProviderConfig, messages: ChatMessage[]): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.token) {
    headers['Authorization'] = `Bearer ${cfg.token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0,
        stream: false,
      }),
    });
  } catch (e) {
    throw new Error(`AI request to ${url} failed: ${(e as Error)?.message ?? e}`);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`AI request to ${url} returned ${response.status}: ${bodyText.slice(0, 300)}`);
  }

  const data = await response.json().catch((e) => {
    throw new Error(`AI response from ${url} was not valid JSON: ${(e as Error)?.message ?? e}`);
  });

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`AI response from ${url} had no choices[0].message.content`);
  }
  return content;
}
