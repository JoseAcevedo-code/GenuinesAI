/**
 * Single source of truth for site identity. The name, owner, and canonical URL
 * were previously duplicated across the layout metadata, the page copy, and two
 * outbound `User-Agent` headers, so they drifted apart whenever one changed.
 */

export const SITE_NAME = "GenuinesAI";
export const SITE_TAGLINE = "Thoughtful answers. Clearer thinking.";
export const SITE_DESCRIPTION =
  "A thoughtful AI conversation experience for clearer thinking, useful answers, and focused action.";
export const SITE_URL = "https://genuines-ai.acevedo-jose20188.chatgpt.site";
export const OWNER_NAME = "Jose";

/** Identifies this app to the public feeds and APIs it reads. */
export const USER_AGENT = `${SITE_NAME}/1.0 (+${SITE_URL})`;
