/** Model catalogue shared by the client UI and the server route. */

export type ModelDefinition = {
  name: string;
  detail: string;
  /** How many live sources a request for this model may return. */
  resultLimit: number;
  /** OpenAI Responses API model used by the server. Never exposed as a key. */
  apiModel: "gpt-5.6-terra" | "gpt-5.6-luna" | "gpt-5.6-sol";
  reasoningEffort: "low" | "medium" | "high";
  searchContextSize: "low" | "medium" | "high";
  maxOutputTokens: number;
};

export const MODELS: readonly ModelDefinition[] = [
  {
    name: "GenuinesAI Pro",
    detail: "Smart, balanced answers",
    resultLimit: 7,
    apiModel: "gpt-5.6-terra",
    reasoningEffort: "medium",
    searchContextSize: "medium",
    maxOutputTokens: 3200,
  },
  {
    name: "GenuinesAI Fast",
    detail: "Quick everyday help",
    resultLimit: 5,
    apiModel: "gpt-5.6-luna",
    reasoningEffort: "low",
    searchContextSize: "low",
    maxOutputTokens: 2200,
  },
  {
    name: "GenuinesAI Reason",
    detail: "Deeper analysis and research",
    resultLimit: 10,
    apiModel: "gpt-5.6-sol",
    reasoningEffort: "high",
    searchContextSize: "high",
    maxOutputTokens: 5200,
  },
];

export const DEFAULT_MODEL = MODELS[0];

export function isKnownModel(name: string): boolean {
  return MODELS.some((model) => model.name === name);
}

/**
 * Resolves an untrusted `model` value from a request body to a known model.
 * Unknown values fall back to the default instead of being matched loosely,
 * so a caller cannot steer behaviour with an arbitrary string.
 */
export function resolveModel(value: unknown): ModelDefinition {
  if (typeof value !== "string") return DEFAULT_MODEL;
  return MODELS.find((model) => model.name === value) ?? DEFAULT_MODEL;
}
