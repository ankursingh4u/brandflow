import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { shopifyApp } from "@shopify/shopify-app-express";
import { MemorySessionStorage } from "@shopify/shopify-app-session-storage-memory";
import { MongoDBSessionStorage } from "@shopify/shopify-app-session-storage-mongodb";
import dotenv from "dotenv";

// Pinned to match [webhooks] api_version in shopify.app.brandflow.toml. Previously this used
// LATEST_API_VERSION with restResources for 2023-04, which logged a version-mismatch warning
// on every boot. 2023-04 no longer ships in @shopify/shopify-api v15 (oldest is 2024-10).
const API_VERSION = "2026-07";

// restResources is deliberately NOT configured. Every Admin API call in this app goes through
// shopify.api.clients.Graphql; nothing used the REST resources, but having them registered made
// the app look like a REST consumer. New public apps must be built exclusively on the GraphQL
// Admin API (the REST Admin API has been legacy since 1 Oct 2024), so the dead config is gone.

dotenv.config();

const sessionStorageMode =
  process.env.SESSION_STORAGE ||
  (process.env.NODE_ENV === "production" ? "mongodb" : "sqlite");

const sqliteSessionPath = resolve(
  process.cwd(),
  process.env.SQLITE_SESSION_DB_PATH || ".shopify/session-storage.sqlite"
);

// sqlite is a dev-only fallback and is the one dependency that needs a native build. It is an
// optionalDependency and is imported lazily so that a missing/unbuildable sqlite3 binding can
// never break the production image, which always runs SESSION_STORAGE=mongodb.
async function createSessionStorage() {
  if (sessionStorageMode === "mongodb") {
    return new MongoDBSessionStorage(
      process.env.MONGODB_URI,
      process.env.MONGODB_DB_NAME
    );
  }

  if (sessionStorageMode === "memory") {
    return new MemorySessionStorage();
  }

  mkdirSync(dirname(sqliteSessionPath), { recursive: true });

  try {
    const { SQLiteSessionStorage } = await import(
      "@shopify/shopify-app-session-storage-sqlite"
    );
    return new SQLiteSessionStorage(sqliteSessionPath);
  } catch (error) {
    console.warn(
      `sqlite session storage unavailable (${error.message}); falling back to memory storage`
    );
    return new MemorySessionStorage();
  }
}

const sessionStorage = await createSessionStorage();

console.log(
  sessionStorageMode === "sqlite"
    ? `Using sqlite session storage at ${sqliteSessionPath}`
    : `Using ${sessionStorageMode} session storage`
);

const shopify = shopifyApp({
  api: {
    apiVersion: API_VERSION,
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    hostName: process.env.HOST.replace(/https?:\/\//, ""),
    scopes: process.env.SCOPES.split(","),
  },
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },
  webhooks: {
    path: "/api/webhooks",
  },
  // Required since Shopify stopped accepting non-expiring offline tokens on the Admin API.
  // Without this every Admin GraphQL call returns 403 "Non-expiring access tokens are no longer
  // accepted for the Admin API". Enabling it makes the OAuth callback request an expiring token
  // and lets the library refresh it automatically before expiry.
  future: {
    expiringOfflineAccessTokens: true,
  },
  sessionStorage,
});

export default shopify;
