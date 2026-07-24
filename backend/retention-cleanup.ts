import "dotenv/config";
import { createProductDataStoreFromEnv } from "./services/product-data.js";

const store = await createProductDataStoreFromEnv();
if (!store) {
  throw new Error(
    "Retention cleanup requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
  );
}

const result = await store.cleanupExpired();
console.log(
  `Retention cleanup completed: ${result.mediaObjects} media objects, ${result.investigations} investigations, ${result.nonces} nonces.`,
);
