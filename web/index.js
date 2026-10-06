// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import { createHmac, timingSafeEqual } from "crypto";
import express from "express";
import serveStatic from "serve-static";

import shopify from "./shopify.js";
import GDPRWebhookHandlers from "./gdpr.js";

import dotenv from "dotenv";
dotenv.config();

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || "3000", 10);

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const APP_NAME = "BrandFlow";
const PRO_PLAN_NAME = "Pro";
const BILLING_MODE = "managed";
const SHOPIFY_APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || "";
const SHOPIFY_REQUIRE_ACTIVE_PLAN =
  process.env.SHOPIFY_REQUIRE_ACTIVE_PLAN !== "false";

const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  INTERNAL_SERVER_ERROR: 500,
};

const app = express();
app.set("trust proxy", 1);

app.post(
  shopify.config.webhooks.path,
  express.text({ type: "*/*" }),
  async (req, res) => {
    const rawBody = req.body;
    const receivedHmac = req.headers["x-shopify-hmac-sha256"] || "";

    if (!receivedHmac) {
      return res.status(400).send("Missing HMAC header");
    }

    const expectedHmac = createHmac("sha256", process.env.SHOPIFY_API_SECRET || "")
      .update(rawBody, "utf8")
      .digest("base64");

    let valid = false;
    try {
      valid = timingSafeEqual(
        Buffer.from(expectedHmac, "base64"),
        Buffer.from(receivedHmac, "base64")
      );
    } catch (_) {
      valid = false;
    }

    if (!valid) {
      return res.status(401).send("HMAC validation failed");
    }

    const topic = req.headers["x-shopify-topic"] || "";
    const shop = req.headers["x-shopify-shop-domain"] || "";
    const webhookId = req.headers["x-shopify-webhook-id"] || "";
    const topicKey = topic.replace("/", "_").toUpperCase();

    const handler = GDPRWebhookHandlers[topicKey];
    if (handler?.callback) {
      try {
        await handler.callback(topic, shop, rawBody, webhookId);
      } catch (e) {
        console.error("Webhook handler error:", e.message);
      }
    }

    return res.status(200).send();
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get(shopify.config.auth.path, shopify.auth.begin());

app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);

app.get("/auth/start", async (req, res) => {
  const shop = String(
    req.query.shop || req.headers["x-shopify-shop-domain"] || ""
  );

  if (!shop) {
    return handleError(
      res,
      HTTP_STATUS.BAD_REQUEST,
      "Missing shop for auth redirect"
    );
  }

  const redirectUri =
    req.query.redirectUri ||
    `https://${req.get("host")}${shopify.config.auth.path}?shop=${encodeURIComponent(
      shop
    )}`;

  if (isEmbeddedRequest(req)) {
    return res.redirect(
      buildExitIframeRedirect(req, shop, String(redirectUri))
    );
  }

  return res.redirect(String(redirectUri));
});

function getSession(res) {
  return res.locals?.shopify?.session || null;
}

function getOfflineSessionId(shop) {
  if (!shop) return "";

  if (shopify.api?.session?.getOfflineId) {
    return shopify.api.session.getOfflineId(String(shop));
  }

  return `offline_${String(shop)}`;
}

async function loadStoredSessionForShop(shop) {
  if (!shop) return null;

  // Offline tokens expire now that expiringOfflineAccessTokens is enabled, so a stored token
  // cannot be used as-is. ensureValidOfflineSession loads the session, refreshes the token when
  // it is within 5 minutes of expiry, and persists the refreshed session. Reading straight from
  // sessionStorage (below) skips that, which left the app using a stale token until every Admin
  // API call failed with 401 Unauthorized.
  if (typeof shopify.ensureValidOfflineSession === "function") {
    try {
      const validSession = await shopify.ensureValidOfflineSession(shop);
      if (validSession) return validSession;
    } catch (error) {
      // Refresh failed (for example the refresh token itself expired). Fall through so the
      // caller sends the merchant back through OAuth instead of returning a 500.
      console.warn(
        `Could not refresh offline session for ${shop}: ${error.message}`
      );
    }
  }

  const offlineSessionId = getOfflineSessionId(shop);
  if (offlineSessionId && shopify.config.sessionStorage.loadSession) {
    const offlineSession = await shopify.config.sessionStorage.loadSession(
      offlineSessionId
    );
    if (offlineSession) {
      return offlineSession;
    }
  }

  const sessions = await shopify.config.sessionStorage.findSessionsByShop(shop);
  if (!sessions.length) return null;

  return sessions.find((session) => !session.isOnline) || sessions[0];
}

function getStoreHandleFromReferrer(req) {
  const referrer = req.get("referer");
  if (!referrer) {
    return "";
  }

  try {
    const url = new URL(referrer);
    const match = url.pathname.match(/\/store\/([^/]+)\//i);
    return match?.[1] || "";
  } catch (_error) {
    return "";
  }
}

function getShopFromReferrer(req) {
  const storeHandle = getStoreHandleFromReferrer(req);
  if (!storeHandle) {
    return "";
  }

  return shopify.api.utils.sanitizeShop(`${storeHandle}.myshopify.com`) || "";
}

/**
 * Resolve the shop for an authenticated API request from a VERIFIED Shopify session token.
 *
 * This used to read `?shop=` first and only fall back to the bearer token. That meant anyone who
 * knew a store's myshopify domain could call /api/* and read that merchant's data with no
 * credentials at all — the shop was simply asserted by the caller, never proven.
 *
 * decodeSessionToken verifies the JWT's HMAC signature against SHOPIFY_API_SECRET and checks its
 * exp/nbf/aud claims, so the `dest` claim can be trusted as the caller's identity. A token is the
 * only accepted proof; `?shop=` is never consulted here.
 *
 * App Bridge attaches the token as `Authorization: Bearer <jwt>`. Shopify also appends the same
 * signed JWT as an `id_token` query param on embedded app loads, so that is accepted too and gets
 * identical verification.
 */
async function getVerifiedShop(req) {
  const sessionToken =
    req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] ||
    (typeof req.query.id_token === "string" ? req.query.id_token : "");

  if (!sessionToken) {
    return "";
  }

  try {
    const payload = await shopify.api.session.decodeSessionToken(sessionToken);
    return (
      shopify.api.utils.sanitizeShop(
        String(payload.dest || "").replace(/^https:\/\//i, "")
      ) || ""
    );
  } catch (error) {
    console.warn(`Rejected an invalid session token: ${error.message}`);
    return "";
  }
}

async function attachOfflineSession(req, res, next) {
  const existingSession = getSession(res);
  if (existingSession) {
    return next();
  }

  const shop = await getVerifiedShop(req);
  if (!shop) {
    // No verified token, so this is not an authenticated embedded request. Deliberately does NOT
    // fall back to `?shop=` — that fallback was the vulnerability. getShopFromSessionOrRequest is
    // still used below, but only to build the OAuth redirect URL, which discloses nothing.
    return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
  }

  const session = await loadStoredSessionForShop(shop);
  if (!session) {
    return sendReauthorize(res, shop);
  }

  res.locals.shopify = {
    ...(res.locals.shopify || {}),
    session,
  };

  return next();
}

// Express 5 (path-to-regexp v8) rejects bare "*" wildcards; they must be named.
app.use("/api/*splat", attachOfflineSession);

async function getSessionForRequest(req, res) {
  const validatedSession = getSession(res);
  if (validatedSession) {
    return validatedSession;
  }

  // Every /api/* route is behind attachOfflineSession, which only populates res.locals after
  // verifying a session token. Reaching this point on an /api/* path therefore means the token was
  // missing or invalid, so refuse rather than falling through to the unverified lookup below.
  // Uses originalUrl because app.use(path, fn) strips the mount prefix from req.path/req.url.
  if (String(req.originalUrl || "").startsWith("/api/")) {
    return null;
  }

  // Document routes (/billing/start, /welcome) are top-level navigations that cannot carry an
  // Authorization header. They return no merchant data — they only build a redirect URL from the
  // shop — so resolving it from the request is acceptable here.
  const shop =
    req.query.shop ||
    req.headers["x-shopify-shop-domain"] ||
    getShopFromReferrer(req);

  const offlineSession = await loadStoredSessionForShop(String(shop || ""));
  return offlineSession || null;
}

function createGraphQLClient(session) {
  return new shopify.api.clients.Graphql({ session });
}

function formatErrorMessage(error) {
  if (error?.errorData?.length) {
    return error.errorData
      .map((item) => item?.message || JSON.stringify(item))
      .join(" | ");
  }

  if (error?.response?.body?.errors) {
    const responseErrors = error.response.body.errors;
    if (Array.isArray(responseErrors)) {
      return responseErrors
        .map((item) => item?.message || JSON.stringify(item))
        .join(" | ");
    }
  }

  return error?.message || "Unexpected server error";
}

function handleError(res, code, message) {
  console.error(message);
  res.status(code).send({ error: message });
}

function isShopifyUnauthorizedError(error) {
  const message = String(error?.message || "");
  const networkStatusCode = error?.response?.code || error?.networkStatusCode;

  return (
    networkStatusCode === HTTP_STATUS.UNAUTHORIZED ||
    message.includes("401 Unauthorized") ||
    message.includes("GraphQL Client: Unauthorized")
  );
}

function getShopFromSessionOrRequest(req, res) {
  return (
    getSession(res)?.shop ||
    shopify.api.utils.sanitizeShop(
      String(
        req.query.shop ||
          req.headers["x-shopify-shop-domain"] ||
          getShopFromReferrer(req) ||
          ""
      )
    ) ||
    ""
  );
}

function sendReauthorize(res, shop) {
  if (!shop) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).send({
      reauthorize: true,
      error: "Missing or invalid shop for this request",
    });
  }

  const authUrl = `${shopify.config.auth.path}?shop=${encodeURIComponent(shop)}`;

  return res
    .status(HTTP_STATUS.UNAUTHORIZED)
    .set("X-Shopify-API-Request-Failure-Reauthorize", "1")
    .set("X-Shopify-API-Request-Failure-Reauthorize-Url", authUrl)
    .send({
      reauthorize: true,
      authUrl,
    });
}

function getStoreHandle(shop) {
  return String(shop || "").replace(/\.myshopify\.com$/i, "");
}

function getManagedPricingUrl(shop) {
  if (!SHOPIFY_APP_HANDLE) {
    throw new Error("Missing SHOPIFY_APP_HANDLE");
  }
  if (!shop) {
    throw new Error("Missing shop");
  }

  const storeHandle = getStoreHandle(shop);
  if (!storeHandle) {
    throw new Error("Missing store handle");
  }

  return `https://admin.shopify.com/store/${storeHandle}/charges/${SHOPIFY_APP_HANDLE}/pricing_plans`;
}

function getEmbeddedAppAdminUrl(req, shop) {
  const storeHandle = getStoreHandle(shop) || getStoreHandleFromReferrer(req);
  if (!storeHandle || !SHOPIFY_APP_HANDLE) {
    return "";
  }

  return `https://admin.shopify.com/store/${storeHandle}/apps/${SHOPIFY_APP_HANDLE}`;
}

function buildBillingRequiredPath(req) {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return `/billing-required${query}`;
}

function buildExitIframeRedirect(req, shop, redirectUri) {
  const queryParams = new URLSearchParams({
    ...req.query,
    shop: String(shop || ""),
    redirectUri,
  }).toString();

  return `${shopify.config.exitIframePath}?${queryParams}`;
}

function isEmbeddedRequest(req) {
  return req.query.embedded === "1" || Boolean(req.query.host);
}

const BillingManager = {
  async getSubscriptionStatus(session) {
    // When the plan gate is switched off, report an entitled plan everywhere instead of only
    // skipping the server-side middleware. The frontend gates independently of requireActivePlan
    // (pages/index.jsx redirects to /billing-required on hasActiveSubscription === false, which
    // then sends the merchant to the hosted plan page), so reporting "false" here would still
    // bounce merchants out of the app even with the gate disabled.
    if (!SHOPIFY_REQUIRE_ACTIVE_PLAN) {
      return {
        tier: "premium",
        activePlanName: PRO_PLAN_NAME,
        hasActiveSubscription: true,
      };
    }

    const client = createGraphQLClient(session);
    const response = await client.request(GET_ACTIVE_SUBSCRIPTIONS);
    const subscriptions =
      response?.currentAppInstallation?.activeSubscriptions ||
      response?.data?.currentAppInstallation?.activeSubscriptions ||
      [];
    const activeSubscription =
      subscriptions.find((subscription) => {
        const status = String(subscription?.status || "").toUpperCase();
        return !status || status === "ACTIVE" || status === "ACCEPTED";
      }) ||
      subscriptions[0] ||
      null;

    console.log(
      "[billing-status]",
      JSON.stringify({
        shop: session.shop,
        subscriptions: subscriptions.map((subscription) => ({
          id: subscription?.id,
          name: subscription?.name,
          status: subscription?.status,
          test: subscription?.test,
        })),
        activePlanName: activeSubscription?.name || null,
        hasActiveSubscription: Boolean(activeSubscription),
      })
    );

    return {
      tier: activeSubscription ? "premium" : "free",
      activePlanName: activeSubscription?.name || null,
      hasActiveSubscription: Boolean(activeSubscription),
    };
  },
};

async function requireActivePlan(req, res, next) {
  if (!SHOPIFY_REQUIRE_ACTIVE_PLAN) {
    return next();
  }

  try {
    const session = await getSessionForRequest(req, res);
    if (!session) {
      return next();
    }

    const subscription = await BillingManager.getSubscriptionStatus(session);
    res.locals.activeSubscription = subscription;

    if (subscription.hasActiveSubscription) {
      return next();
    }

    const confirmationUrl = getManagedPricingUrl(session.shop);

    if (req.path.startsWith("/api/")) {
      return res.status(HTTP_STATUS.PAYMENT_REQUIRED).send({
        billingRequired: true,
        billingMode: BILLING_MODE,
        confirmationUrl,
        billingRequiredPath: buildBillingRequiredPath(req),
      });
    }

    if (req.query.embedded === "1" || req.query.host) {
      return shopify.redirectOutOfApp({
        req,
        res,
        redirectUri: confirmationUrl,
        shop: session.shop,
      });
    }

    return res.redirect(confirmationUrl);
  } catch (error) {
    if (isShopifyUnauthorizedError(error)) {
      return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
    }

    return handleError(
      res,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      formatErrorMessage(error)
    );
  }
}

const PlanService = {
  async getPlanTier(session) {
    const subscription = await BillingManager.getSubscriptionStatus(session);
    return subscription.tier;
  },

  getOrderLimit(planTier) {
    switch (planTier) {
      case "premium":
        return 1000;
      default:
        return 0;
    }
  },
};

// Optional analytics sink. Previously this POSTed to an empty URL, which threw
// ERR_INVALID_URL on every /api/store-details request and was swallowed, so nothing was ever
// recorded. It is now a no-op unless ANALYTICS_ENDPOINT is configured.
const ANALYTICS_ENDPOINT = process.env.ANALYTICS_ENDPOINT || "";

async function storeShopDetails(shopDetails) {
  if (!ANALYTICS_ENDPOINT) return;

  try {
    await fetch(ANALYTICS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(shopDetails),
    });
  } catch (error) {
    console.error("Analytics store error:", error);
  }
}

app.get("/api/hasActiveSubscription", async (req, res) => {
  try {
    const session = await getSessionForRequest(req, res);
    if (!session) {
      return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
    }

    const subscription = await BillingManager.getSubscriptionStatus(session);

    res.status(HTTP_STATUS.OK).send({
      hasActiveSubscription: subscription.hasActiveSubscription,
      tier: subscription.tier,
      billingMode: BILLING_MODE,
      activePlanName: subscription.activePlanName,
    });
  } catch (error) {
    if (isShopifyUnauthorizedError(error)) {
      return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
    }

    handleError(
      res,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      formatErrorMessage(error)
    );
  }
});

app.get("/api/billing-required", async (req, res) => {
  try {
    const session = await getSessionForRequest(req, res);
    if (!session) {
      return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
    }

    res.status(HTTP_STATUS.OK).send({
      billingRequired: true,
      billingMode: BILLING_MODE,
      shop: session.shop,
      storeHandle: getStoreHandle(session.shop),
      appHandle: SHOPIFY_APP_HANDLE,
      pricingUrl: getManagedPricingUrl(session.shop),
    });
  } catch (error) {
    if (isShopifyUnauthorizedError(error)) {
      return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
    }

    handleError(
      res,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      formatErrorMessage(error)
    );
  }
});

app.get("/billing/start", async (req, res) => {
  try {
    const session = await getSessionForRequest(req, res);
    if (!session) {
      return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
    }

    const redirectUri = getManagedPricingUrl(session.shop);

    if (isEmbeddedRequest(req)) {
      return res.redirect(
        buildExitIframeRedirect(req, session.shop, redirectUri)
      );
    }

    return res.redirect(redirectUri);
  } catch (error) {
    if (isShopifyUnauthorizedError(error)) {
      return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
    }

    handleError(
      res,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      formatErrorMessage(error)
    );
  }
});

app.get("/welcome", async (req, res) => {
  const shop =
    String(req.query.shop || "") ||
    `${getStoreHandleFromReferrer(req)}.myshopify.com`;
  const embeddedAppUrl = getEmbeddedAppAdminUrl(req, shop);

  if (embeddedAppUrl) {
    return res.redirect(embeddedAppUrl);
  }

  return res.redirect("/");
});

app.get("/api/createSubscription", async (req, res) => {
  try {
    const session = await getSessionForRequest(req, res);
    if (!session) {
      return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
    }

    const subscription = await BillingManager.getSubscriptionStatus(session);
    if (subscription.hasActiveSubscription) {
      return res.status(HTTP_STATUS.OK).send({
        isActiveSubscription: true,
        billingMode: BILLING_MODE,
        activePlanName: subscription.activePlanName || PRO_PLAN_NAME,
        tier: "premium",
      });
    }

    res.status(HTTP_STATUS.OK).send({
      confirmationUrl: getManagedPricingUrl(session.shop),
      billingMode: BILLING_MODE,
      activePlanName: PRO_PLAN_NAME,
    });
  } catch (error) {
    if (isShopifyUnauthorizedError(error)) {
      return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
    }

    handleError(
      res,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      formatErrorMessage(error)
    );
  }
});

app.get("/api/cancelSubscription", async (_req, res) => {
  res.status(HTTP_STATUS.BAD_REQUEST).send({
    error:
      "This app uses a single managed plan. Billing changes are managed in Shopify admin.",
  });
});

app.get("/api/scroll-to-top/hasSubscription", async (req, res) => {
  try {
    const session = await getSessionForRequest(req, res);

    if (!session) {
      return handleError(
        res,
        HTTP_STATUS.UNAUTHORIZED,
        "Unable to resolve an app session for this shop"
      );
    }

    const subscription = await BillingManager.getSubscriptionStatus(session);

    res.status(HTTP_STATUS.OK).send({
      hasActiveSubscription: subscription.hasActiveSubscription,
      tier: subscription.tier,
      billingMode: BILLING_MODE,
      activePlanName: subscription.activePlanName,
    });
  } catch (error) {
    handleError(
      res,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      formatErrorMessage(error)
    );
  }
});

app.use(
  ["/api/store-details", "/api/getshop", "/api/scroll-to-top/plan-info"],
  requireActivePlan
);

app.get("/api/scroll-to-top/plan-info", async (req, res) => {
  try {
    const session = await getSessionForRequest(req, res);
    if (!session) {
      return handleError(
        res,
        HTTP_STATUS.UNAUTHORIZED,
        "Unable to resolve an app session for this shop"
      );
    }

    const tier = await PlanService.getPlanTier(session);
    const limit = PlanService.getOrderLimit(tier);

    res.json({
      planTier: tier,
      orderLimit: limit,
      remaining: limit,
      canImportMore: tier === "premium",
    });
  } catch (error) {
    handleError(
      res,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      formatErrorMessage(error)
    );
  }
});

const shopDetailsQuery = `
{
  shop {
    name
    email
    primaryDomain { url host }
    plan { displayName }
  }
}
`;

app.get("/api/store-details", async (req, res) => {
  try {
    const session = await getSessionForRequest(req, res);
    if (!session) {
      return handleError(
        res,
        HTTP_STATUS.UNAUTHORIZED,
        "Unable to resolve an app session for this shop"
      );
    }

    const client = createGraphQLClient(session);
    const response = await client.request(shopDetailsQuery);
    const shop = response?.shop ?? response?.data?.shop ?? {};

    await storeShopDetails({
      appName: APP_NAME,
      storeUrl: shop?.primaryDomain?.url,
      name: shop?.name,
      email: shop?.email,
      plan: shop?.plan?.displayName,
    });

    res.status(HTTP_STATUS.OK).send({
      message: "Shop details fetched successfully",
      data: shop,
    });
  } catch (error) {
    if (isShopifyUnauthorizedError(error)) {
      return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
    }

    handleError(
      res,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      formatErrorMessage(error)
    );
  }
});

app.get("/api/getshop", async (req, res) => {
  try {
    const session = await getSessionForRequest(req, res);
    if (!session) {
      return handleError(
        res,
        HTTP_STATUS.UNAUTHORIZED,
        "Unable to resolve an app session for this shop"
      );
    }

    res.json({ shop: session.shop });
  } catch (error) {
    if (isShopifyUnauthorizedError(error)) {
      return sendReauthorize(res, getShopFromSessionOrRequest(req, res));
    }

    handleError(
      res,
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      formatErrorMessage(error)
    );
  }
});

app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

const serveFrontend = async (_req, res) => {
  const html = readFileSync(join(STATIC_PATH, "index.html"), "utf8").replace(
    "%%SHOPIFY_API_KEY%%",
    process.env.SHOPIFY_API_KEY || ""
  );

  res
    .status(HTTP_STATUS.OK)
    .set("Content-Type", "text/html")
    .send(html);
};

// Braces matter: in Express 5 "/*splat" matches every path EXCEPT the root, so "/" would 404.
// "/{*splat}" makes the wildcard optional and matches "/" too.
//
// ensureInstalledOnShop gates the UI behind OAuth: a shop with no stored session is sent through
// the auth flow instead of being served the app shell. Without it the SPA rendered for anyone, so
// a merchant could interact with the UI before installing. Static assets are unaffected because
// serveStatic above handles them first.
const ensureInstalled = shopify.ensureInstalledOnShop();

// ...with one exemption. The exit-iframe page is a transitional bounce page whose whole job is to
// move the TOP frame to `redirectUri`. It is reached by a server redirect that carries no
// `embedded=1`, so ensureInstalledOnShop reads it as a non-embedded load and redirects to the
// admin app URL — silently dropping redirectUri and bouncing the merchant back INTO the app.
// That turned "Choose a plan" into a loop. Uses originalUrl because app.use() rewrites req.url.
app.use(
  "/{*splat}",
  (req, res, next) => {
    const pathname = String(req.originalUrl || "").split("?")[0];
    if (pathname === shopify.config.exitIframePath) {
      return next();
    }

    return ensureInstalled(req, res, next);
  },
  serveFrontend
);

app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);

const GET_ACTIVE_SUBSCRIPTIONS = `
query GetActiveSubscriptions {
  currentAppInstallation {
    activeSubscriptions {
      id
      name
      status
      test
    }
  }
}
`;
