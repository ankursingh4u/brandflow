import { Banner, Button, Card, Page, Spinner } from "@shopify/polaris";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

/**
 * Breaks out of the embedded admin iframe to a full-page URL.
 *
 * App Bridge 4 handles this with a plain `open(url, "_top")` — the legacy
 * `Redirect.create(app).dispatch(Redirect.Action.REMOTE, url)` from
 * @shopify/app-bridge/actions is no longer available.
 */

// A cross-origin iframe may only navigate the top frame through App Bridge or on the back of a
// user gesture. This effect has neither if App Bridge failed to load, and a blocked `open()`
// fails silently — so stop showing a bare spinner after this long and offer a button, whose
// click supplies the gesture the automatic attempt lacked.
const STALLED_AFTER_MS = 4000;

export default function ExitIframe() {
  const { search } = useLocation();
  const [stalled, setStalled] = useState(false);

  // URLSearchParams already percent-decodes, so the extra decodeURIComponent() this used to do
  // was a double decode: it mangled any redirectUri containing a literal "%" and threw URIError
  // on a malformed sequence, which surfaced as a blank page.
  const redirectUri = useMemo(
    () => new URLSearchParams(search).get("redirectUri") || "",
    [search]
  );

  useEffect(() => {
    if (!redirectUri) return;

    setStalled(false);
    open(redirectUri, "_top");

    const timer = setTimeout(() => setStalled(true), STALLED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [redirectUri]);

  if (!redirectUri) {
    return (
      <Page>
        <Banner status="critical" title="Nothing to open">
          This page was reached without a destination. Go back to the app and try
          again.
        </Banner>
      </Page>
    );
  }

  if (stalled) {
    return (
      <Page title="Continue in Shopify admin">
        <Card sectioned>
          <p style={{ marginTop: 0, color: "#475569", lineHeight: 1.7 }}>
            The automatic redirect was blocked. Continue to Shopify admin to
            finish.
          </p>

          <Button primary onClick={() => open(redirectUri, "_top")}>
            Continue
          </Button>
        </Card>
      </Page>
    );
  }

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
      <Spinner accessibilityLabel="Redirecting" size="large" />
    </div>
  );
}
