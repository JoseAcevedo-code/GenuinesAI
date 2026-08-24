/** Cloudflare Worker entry point for the vinext-starter template. */
// D1's type is imported rather than pulled in globally: the Workers global types
// redefine Request/Response and would conflict with the DOM lib the app uses.
import type { D1Database } from "@cloudflare/workers-types";
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

/**
 * The static-asset binding, described against the DOM `Request`/`Response` that
 * the rest of the app and the vinext handler use. Cloudflare's own `Fetcher`
 * type is expressed in Workers-flavoured Request/Response and does not line up
 * with the handler's signature.
 */
interface AssetFetcher {
  fetch(request: Request): Response | Promise<Response>;
}

interface Env {
  ASSETS: AssetFetcher;
  DB?: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

/**
 * Baseline hardening headers. The site has no third-party embedding or framing
 * requirement, so denying it costs nothing and closes off clickjacking; the
 * others stop MIME sniffing and full-URL referrer leakage to the outbound links
 * rendered in search results.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=(), payment=(), usb=()",
};

function withSecurityHeaders(response: Response): Response {
  // Header maps on some runtime responses are immutable, so clone before writing.
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(name, value);
  }
  return secured;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return withSecurityHeaders(await handleImageOptimization(request, {
        fetchAsset: async (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths));
    }

    return withSecurityHeaders(await handler.fetch(request, env, ctx));
  },
};

export default worker;
