import { Spinner } from "@shopify/polaris";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Breaks out of the embedded admin iframe to a full-page URL.
 *
 * App Bridge 4 handles this with a plain `open(url, "_top")` — the legacy
 * `Redirect.create(app).dispatch(Redirect.Action.REMOTE, url)` from
 * @shopify/app-bridge/actions is no longer available.
 */
export default function ExitIframe() {
  const { search } = useLocation();

  useEffect(() => {
    if (!search) return;

    const redirectUri = new URLSearchParams(search).get("redirectUri");
    if (!redirectUri) return;

    open(decodeURIComponent(redirectUri), "_top");
  }, [search]);

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
      <Spinner accessibilityLabel="Redirecting" size="large" />
    </div>
  );
}
