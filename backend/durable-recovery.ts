import "dotenv/config";
import {
  createInvestigationQueue,
  createRedisConnection,
} from "./queue/investigation-queue.js";
import { recoverDurableWork } from "./services/durable-recovery.js";
import { createProductDataStoreFromEnv } from "./services/product-data.js";

const productData = await createProductDataStoreFromEnv();
if (!productData) {
  throw new Error(
    "Durable recovery requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
  );
}

const connection = createRedisConnection();
const queue = createInvestigationQueue(connection);

try {
  const result = await recoverDurableWork({ productData, queue });
  console.log(
    `Durable recovery completed: ${result.investigationEnqueues} investigation enqueue(s), ${result.deliveryEnqueues} delivery enqueue(s), ${result.alreadyScheduled} already scheduled.`,
  );
  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      console.error(
        `Durable recovery failed for ${failure.kind} ${failure.id}: ${failure.error}`,
      );
    }
    process.exitCode = 1;
  }
} finally {
  await queue.close();
  await connection.quit();
}
