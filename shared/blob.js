import {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  StorageSharedKeyCredential
} from "@azure/storage-blob";

function parseConnStr(connStr) {
  if (!connStr) throw new Error("AzureWebJobsStorage is missing");

  const parts = {};
  connStr.split(";").forEach(p => {
    const [k, ...rest] = p.split("=");
    const v = rest.join("=");
    if (k && v) parts[k.trim()] = v.trim();
  });

  const accountName = parts.AccountName;
  const accountKey = parts.AccountKey;

  if (!accountName || !accountKey) {
    throw new Error("Invalid AzureWebJobsStorage connection string (missing AccountName/AccountKey)");
  }

  return { accountName, accountKey };
}

export function getBlobServiceClient() {
  return BlobServiceClient.fromConnectionString(process.env.AzureWebJobsStorage);
}

function buildSasUrl(blobName, permissions, minutes = 15) {
  const { accountName, accountKey } = parseConnStr(process.env.AzureWebJobsStorage);

  const containerName = process.env.BLOB_CONTAINER_NAME;
  if (!containerName) throw new Error("BLOB_CONTAINER_NAME is missing");

  const credential = new StorageSharedKeyCredential(accountName, accountKey);


  const startsOn = new Date(Date.now() - 60 * 1000);
  const expiresOn = new Date(Date.now() + minutes * 60 * 1000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse(permissions),
      startsOn,
      expiresOn
    },
    credential
  ).toString();

  return `https://${accountName}.blob.core.windows.net/${containerName}/${encodeURIComponent(blobName)}?${sas}`;
}

export function getUploadSasUrl(blobName, minutes = 15) {
  return buildSasUrl(blobName, "cw", minutes);
}

export function getReadSasUrl(blobName, minutes = 15) {
  return buildSasUrl(blobName, "r", minutes);
}
