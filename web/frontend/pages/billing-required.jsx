// @ts-check
import React, { useEffect, useState } from "react";
import { Button, Card, Frame, Layout, Loading, Page } from "@shopify/polaris";
import { useNavigate } from "react-router-dom";
import { useAppQuery } from "../hooks";
import { withShopQuery } from "../utils/shop";

export default function BillingRequired() {
  const navigate = useNavigate();
  const [redirecting, setRedirecting] = useState(false);
  const { data: subscriptionData, isLoading } = useAppQuery({
    url: withShopQuery("/api/hasActiveSubscription"),
    reactQueryOptions: {
      // This endpoint is not cheap: every call is a GraphQL round-trip to Shopify plus a
      // possible offline-token refresh. The poll only exists to unlock the dashboard once the
      // merchant approves a plan in Shopify admin, so seconds of latency there cost nothing —
      // whereas the old 2s interval could issue a new request before the previous one returned.
      refetchInterval: 15000,
      staleTime: 0,
    },
  });

  function openPricing() {
    setRedirecting(true);
    window.location.assign(withShopQuery("/billing/start"));
  }

  // Only the "active plan" case navigates automatically. This page used to also auto-redirect
  // merchants to Shopify's plan page on load, which made declining a charge inescapable: decline
  // → land back here → bounced straight out again, with no way to stay in the app. Requiring a
  // click fixes that, and the click doubles as the user gesture a cross-origin iframe needs to
  // navigate the top frame.
  useEffect(() => {
    if (isLoading) return;
    if (subscriptionData?.hasActiveSubscription === true) {
      navigate("/", { replace: true });
    }
  }, [isLoading, navigate, subscriptionData]);

  return (
    <Frame>
      {/* Tying this to isFetching made the loading bar flash on every poll, forever. */}
      {(redirecting || isLoading) && <Loading />}
      <Page
        title="Plan required"
        subtitle="A Shopify managed Pro plan is required before merchants can use the app dashboard."
      >
        <Layout>
          <Layout.Section>
            <Card sectioned>
              <p style={{ marginTop: 0, color: "#475569", lineHeight: 1.7 }}>
                Shopify handles plan selection and payment approval for this app.
                Choose a plan to unlock the dashboard — access is granted
                automatically once the subscription is approved. If you decline,
                you will come back to this page and can try again whenever you
                are ready.
              </p>

              <Button primary loading={redirecting} onClick={openPricing}>
                Choose a plan
              </Button>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </Frame>
  );
}
