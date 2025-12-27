import { app } from "@azure/functions";
import { v4 as uuidv4 } from "uuid";
import { requireEnv, config } from "../shared/config.js";
import { getCosmosContainer } from "../shared/cosmos.js";
import { getBlobServiceClient, getUploadSasUrl } from "../shared/blob.js";

function response(status, body) {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

function sanitizeFileName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w.\-]/g, ""); // keep it safe for URLs/paths
}

app.http("clipsCreate", {
  methods: ["POST"],
  route: "clips",
  authLevel: "anonymous",
  handler: async (req, context) => {
    context.log(`Processing clipsCreate for url "${req.url}"`);
    try {
      requireEnv();

      let data;
      try {
        data = await req.json();
      } catch {
        return response(400, { error: "Invalid or missing JSON body" });
      }

      const title = data?.title?.trim();
      const genre = data?.genre || "unknown";
      const userId = data?.userId || "demo-user";

      // New: two filenames (thumbnail + video)
      const thumbnailFileName = sanitizeFileName(
        data?.thumbnailFileName || data?.thumbnail || data?.thumbFileName
      );
      const videoFileName = sanitizeFileName(
        data?.videoFileName || data?.video || data?.fileName
      );

      if (!title || !videoFileName) {
        return response(400, {
          error: "title and videoFileName are required (thumbnailFileName optional)"
        });
      }

      const id = uuidv4();

      // Build deterministic blob names (Reels-style)
      const base = `${userId}/${id}`;
      const videoBlobName = `${base}-video-${videoFileName}`;
      // If no thumbnail filename provided, still create a placeholder name
      const thumbName = thumbnailFileName || "thumbnail.png";
      const thumbnailBlobName = `${base}-thumb-${thumbName}`;

      // Ensure blob container exists
      const bsc = getBlobServiceClient();
      await bsc.getContainerClient(config.blob.container).createIfNotExists();

      const doc = {
        id,
        userId,
        title,
        genre,

        // New fields
        thumbnailBlobName,
        videoBlobName,

        status: "pending-upload",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const container = await getCosmosContainer();
      await container.items.create(doc);

      // New: return TWO SAS upload URLs
      const thumbnailUploadUrl = getUploadSasUrl(thumbnailBlobName);
      const videoUploadUrl = getUploadSasUrl(videoBlobName);

      return response(201, {
        clip: doc,
        thumbnailUploadUrl,
        videoUploadUrl
      });
    } catch (err) {
      context.error(err);
      if (err.message && err.message.includes("ECONNREFUSED")) {
        return response(500, {
          error:
            "Connection refused. Ensure required services are running (local emulators) or verify cloud connectivity."
        });
      }
      return response(500, { error: err.message });
    }
  }
});

app.http("clipsList", {
  methods: ["GET"],
  route: "clips",
  authLevel: "anonymous",
  handler: async (req, context) => {
    context.log(`Processing clipsList for url "${req.url}"`);
    try {
      requireEnv();

      const userId = req.query.get("userId") || "demo-user";
      const container = await getCosmosContainer();

      const query = {
        query: "SELECT * FROM c WHERE c.userId = @userId",
        parameters: [{ name: "@userId", value: userId }]
      };

      const { resources } = await container.items.query(query).fetchAll();
      return response(200, resources);
    } catch (err) {
      context.error(err);
      return response(500, { error: err.message });
    }
  }
});

app.http("clipsGet", {
  methods: ["GET"],
  route: "clips/{id}",
  authLevel: "anonymous",
  handler: async (req, context) => {
    context.log(`Processing clipsGet for url "${req.url}"`);
    try {
      requireEnv();

      const id = req.params.id;
      const userId = req.query.get("userId") || "demo-user";

      const container = await getCosmosContainer();
      const { resource } = await container.item(id, userId).read();

      if (!resource) return response(404, { error: "Not found" });
      return response(200, resource);
    } catch (err) {
      context.error(err);
      return response(500, { error: err.message });
    }
  }
});

app.http("clipsUpdate", {
  methods: ["PUT"],
  route: "clips/{id}",
  authLevel: "anonymous",
  handler: async (req, context) => {
    context.log(`Processing clipsUpdate for url "${req.url}"`);
    try {
      requireEnv();

      const id = req.params.id;
      const userId = req.query.get("userId") || "demo-user";

      let data;
      try {
        data = await req.json();
      } catch {
        return response(400, { error: "Invalid or missing JSON body" });
      }

      const container = await getCosmosContainer();
      const { resource } = await container.item(id, userId).read();

      if (!resource) return response(404, { error: "Not found" });

      resource.title = data.title ?? resource.title;
      resource.genre = data.genre ?? resource.genre;
      resource.status = data.status ?? resource.status;

      // Optional: allow updating blob names if you ever need it
      resource.thumbnailBlobName = data.thumbnailBlobName ?? resource.thumbnailBlobName;
      resource.videoBlobName = data.videoBlobName ?? resource.videoBlobName;

      resource.updatedAt = new Date().toISOString();

      const { resource: updated } = await container.item(id, userId).replace(resource);
      return response(200, updated);
    } catch (err) {
      context.error(err);
      return response(500, { error: err.message });
    }
  }
});

app.http("clipsDelete", {
  methods: ["DELETE"],
  route: "clips/{id}",
  authLevel: "anonymous",
  handler: async (req, context) => {
    context.log(`Processing clipsDelete for url "${req.url}"`);
    try {
      requireEnv();

      const id = req.params.id;
      const userId = req.query.get("userId") || "demo-user";

      const container = await getCosmosContainer();
      const { resource } = await container.item(id, userId).read();

      if (!resource) return response(404, { error: "Not found" });

      const containerClient = getBlobServiceClient().getContainerClient(config.blob.container);

      // Backward-compatible delete: handle old "blobName" and new names
      const blobNamesToDelete = [
        resource.blobName,
        resource.thumbnailBlobName,
        resource.videoBlobName
      ].filter(Boolean);

      await Promise.all(
        blobNamesToDelete.map(name =>
          containerClient.getBlobClient(name).deleteIfExists()
        )
      );

      await container.item(id, userId).delete();

      return response(200, { deleted: true, deletedBlobs: blobNamesToDelete });
    } catch (err) {
      context.error(err);
      return response(500, { error: err.message });
    }
  }
});
