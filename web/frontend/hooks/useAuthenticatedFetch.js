import { withShopQuery } from "../utils/shop";

/**
 * A hook that returns an auth-aware fetch function.
 *
 * App Bridge 4 (loaded via the app-bridge.js script tag in index.html) patches the global `fetch`
 * to carry a session token on same-origin requests, but relying on that implicitly is fragile —
 * if the CDN script fails to load, requests silently go out unauthenticated. The server now
 * requires a verified session token on every /api/* route, so the token is attached explicitly
 * here via `shopify.idToken()`, which returns a fresh signed JWT.
 *
 * This wrapper also:
 * 1. Checks the response for the `X-Shopify-API-Request-Failure-Reauthorize` header.
 * 2. Redirects the merchant through OAuth again when that header is present.
 *
 * @returns {Function} fetch function
 */
export function useAuthenticatedFetch() {
  return async (uri, options = {}) => {
    const headers = new Headers(options.headers || {});

    try {
      const idToken = await window.shopify?.idToken?.();
      if (idToken) {
        headers.set("Authorization", `Bearer ${idToken}`);
      }
    } catch (_error) {
      // Leave the request unauthenticated. The server answers 401 with the reauthorize headers
      // below, which sends the merchant back through OAuth rather than failing silently.
    }

    const response = await fetch(uri, { ...options, headers });
    checkHeadersForReauthorization(response.headers);
    return response;
  };
}

function checkHeadersForReauthorization(headers) {
  if (headers.get("X-Shopify-API-Request-Failure-Reauthorize") === "1") {
    const authUrlHeader =
      headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url") ||
      `/api/auth`;
    const redirectUri = authUrlHeader.startsWith("/")
      ? `https://${window.location.host}${authUrlHeader}`
      : authUrlHeader;
    const authStartUrl = new URL(withShopQuery("/auth/start"), window.location.origin);
    const authUrl = new URL(redirectUri, window.location.origin);
    const shop = authUrl.searchParams.get("shop");
    if (shop) {
      authStartUrl.searchParams.set("shop", shop);
    }
    authStartUrl.searchParams.set("redirectUri", redirectUri);
    window.location.assign(authStartUrl.toString());
  }
}
