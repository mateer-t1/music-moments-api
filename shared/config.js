export const config = {
  cosmos: {
    connectionString: process.env.COSMOS_CONNECTION_STRING,
    database: process.env.COSMOS_DB_NAME,
    container: process.env.COSMOS_CONTAINER_NAME
  },
  blob: {
    container: process.env.BLOB_CONTAINER_NAME
  }
};

export function requireEnv() {
  const required = [
    "COSMOS_CONNECTION_STRING",
    "COSMOS_DB_NAME",
    "COSMOS_CONTAINER_NAME",
    "AzureWebJobsStorage",
    "BLOB_CONTAINER_NAME"
  ];

  const missing = required.filter(v => !process.env[v]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}
