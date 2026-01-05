import { CosmosClient } from "@azure/cosmos";
import { config } from "./config.js";

let client;
let containerCache;
let userContainerCache;

function getClient() {
  if (client) return client;

  let connectionString = config.cosmos.connectionString;

  // Auto-correct common typo if present
  if (connectionString && connectionString.indexOf("mm-cosmos-fm") !== -1) {
    console.log("Auto-correcting connection string typo: 'mm-cosmos-fm' -> 'mm-cosmos-frn'");
    connectionString = connectionString.replace("mm-cosmos-fm", "mm-cosmos-frn");
  }

  client = new CosmosClient(connectionString);
  return client;
}

export async function getCosmosContainer() {
  if (containerCache) return containerCache;

  const client = getClient();

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

export async function getUserContainer() {
  if (userContainerCache) return userContainerCache;

  const client = getClient();

  const { database } = await client.databases.createIfNotExists({
    id: config.cosmos.database
  });

  const { container } = await database.containers.createIfNotExists({
    id: "users",
    partitionKey: { paths: ["/id"] }
  });

  userContainerCache = container;
  return container;
}
