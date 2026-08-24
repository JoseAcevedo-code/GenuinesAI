/**
 * The `cloudflare:workers` module is provided by the Workers runtime, not by a
 * package, so `tsc` cannot resolve it on its own. Declaring only the binding
 * surface this app uses keeps the type check honest without pulling Cloudflare's
 * globals in over the DOM lib that the React code relies on.
 */
declare module "cloudflare:workers" {
  import type { D1Database } from "@cloudflare/workers-types";

  export const env: {
    DB?: D1Database;
    [binding: string]: unknown;
  };
}
