import { withShopQuery } from "../utils/shop";

/**
 * A hook that returns an auth-aware fetch function.
 *
 * With App Bridge 4 (loaded via the app-bridge.js script tag in index.html) the global `fetch`
 * is already session-token aware for same-origin requests, so the legacy
 * `authenticatedFetch(app)` helper from @shopify/app-bridge-utils is no longer needed.
 *
 * This wrapper still:
 * 1. Checks the response for the `X-Shopify-API-Request-Failure-Reauthorize` header.
 * 2. Redirects the merchant through OAuth again when that header is present.
 *
 * @returns {Function} fetch function
 */
export function useAuthenticatedFetch() {
  return async (uri, options) => {
    const response = await fetch(uri, options);
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
