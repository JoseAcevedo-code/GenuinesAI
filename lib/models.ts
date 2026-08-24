/** Model catalogue shared by the client UI and the server route. */

export type ModelDefinition = {
  name: string;
  detail: string;
  /** How many live sources a request for this model may return. */
  resultLimit: number;
};

export const MODELS: readonly ModelDefinition[] = [
  { name: "GenuinesAI Pro", detail: "Balanced and capable", resultLimit: 5 },
  { name: "GenuinesAI Fast", detail: "Quick everyday answers", resultLimit: 3 },
  { name: "GenuinesAI Reason", detail: "Deeper step-by-step thinking", resultLimit: 6 },
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
