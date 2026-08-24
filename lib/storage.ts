/**
 * localStorage keys shared by the client component and the pre-paint theme
 * bootstrap in the root layout. Keeping them here stops the inline script and
 * React from reading different keys after a rename.
 */

export const STORAGE_KEYS = {
  version: "genuinesai-data-version",
  messages: "genuinesai-messages",
  model: "genuinesai-model",
  theme: "genuinesai-theme",
} as const;

/** Bumped whenever a stored transcript is no longer readable by this build. */
export const STORAGE_VERSION = "intent-router-v3";
