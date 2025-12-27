import { CosmosClient } from "@azure/cosmos";
import { config } from "./config.js";

let containerCache;

export async function getCosmosContainer() {
  if (containerCache) return containerCache;

  const client = new CosmosClient(
    config.cosmos.connectionString
  );

  const { database } = await client.databases.createIfNotExists({
    id: config.cosmos.database
  });

  const { container } = await database.containers.createIfNotExists({
    id: config.cosmos.container,
    partitionKey: { paths: ["/userId"] }
  });

  containerCache = container;
  return container;
}
