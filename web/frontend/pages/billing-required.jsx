// @ts-check
import React, { useEffect, useRef, useState } from "react";
import { Banner, Button, Card, Frame, Layout, Loading, Page } from "@shopify/polaris";
import { useNavigate } from "react-router-dom";
import { useAppQuery } from "../hooks";
import { withShopQuery } from "../utils/shop";

export default function BillingRequired() {
  const navigate = useNavigate();
  const hasAttemptedRedirect = useRef(false);
  const [redirecting, setRedirecting] = useState(false);
  const [banner, setBanner] = useState({ msg: "", status: null });
  const {
    data: subscriptionData,
    isLoading,
  } = useAppQuery({
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

  function openPricing(auto = false) {
    try {
      setRedirecting(true);
      window.location.assign(withShopQuery("/billing/start"));
    } catch (_error) {
      setRedirecting(false);
      if (auto) {
        setBanner({
          msg: "Unable to open Shopify pricing automatically. Use the button below.",
          status: "warning",
        });
      }
    }
  }

  // Gating on isFetching too made this bail on every background poll and re-run twice per poll.
  // isLoading alone is the right signal: in react-query v3 it is true only while there is no
  // data yet, which is exactly when subscriptionData can't be trusted.
  useEffect(() => {
    if (isLoading) return;
    if (subscriptionData?.hasActiveSubscription === true) {
      navigate("/", { replace: true });
      return;
    }

    if (subscriptionData?.hasActiveSubscription !== false) {
      return;
    }

    if (hasAttemptedRedirect.current) return;
    hasAttemptedRedirect.current = true;
    openPricing(true);
  }, [isLoading, navigate, subscriptionData]);

  return (
    <Frame>
      {/* Tying this to isFetching made the loading bar flash on every poll, forever. */}
      {(redirecting || isLoading) && <Loading />}
      <Page
        title="Plan required"
        subtitle="A Shopify managed Pro plan is required before merchants can use the app dashboard."
      >
        {!!banner.msg && <Banner status={banner.status}>{banner.msg}</Banner>}

        <Layout>
          <Layout.Section>
            <Card sectioned>
              <p style={{ marginTop: 0, color: "#475569", lineHeight: 1.7 }}>
                Shopify handles the plan selection and payment approval for this
                app. After the Pro subscription is approved, dashboard access
                unlocks automatically.
              </p>

              <Button primary loading={redirecting} onClick={() => openPricing(false)}>
                Open Shopify pricing
              </Button>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </Frame>
  );
}
