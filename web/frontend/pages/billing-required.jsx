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

  function openPricing(interval) {
    setRedirecting(true);
    const path =
      interval === "annual" ? "/billing/start?interval=annual" : "/billing/start";
    window.location.assign(withShopQuery(path));
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
        subtitle="A Pro plan is required before you can use the app dashboard."
      >
        <Layout>
          <Layout.Section>
            <Card sectioned>
              <p style={{ marginTop: 0, color: "#475569", lineHeight: 1.7 }}>
                The Pro plan unlocks the dashboard. Payment is approved through
                Shopify and billed to your existing Shopify invoice — access is
                granted automatically once you approve the charge. If you
                decline, you will come back to this page and can try again
                whenever you are ready.
              </p>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Button
                  primary
                  loading={redirecting}
                  onClick={() => openPricing("monthly")}
                >
                  Subscribe — $30/month
                </Button>
                <Button
                  loading={redirecting}
                  onClick={() => openPricing("annual")}
                >
                  Subscribe — $300/year (save 17%)
                </Button>
              </div>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </Frame>
  );
}
