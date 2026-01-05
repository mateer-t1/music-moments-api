import { app } from "@azure/functions";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { requireEnv, config } from "../shared/config.js";
import { getCosmosContainer, getUserContainer } from "../shared/cosmos.js";
import { getBlobServiceClient, getUploadSasUrl, getReadSasUrl } from "../shared/blob.js";

/* ================= helpers ================= */

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
    .replace(/[^\w.\-]/g, "");
}

function normalizeUsername(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return s.replace(/[^a-z0-9_-]/g, "").slice(0, 24);
}

/* ================= USERS ================= */

app.http("usersLogin", {
  methods: ["POST"],
  route: "users/login",
  authLevel: "anonymous",
  handler: async (req, context) => {
    context.log(`Processing usersLogin for url "${req.url}"`);
    try {
      requireEnv();

      let body;
      try {
        body = await req.json();
      } catch {
        return response(400, { error: "Invalid JSON" });
      }

      const username = normalizeUsername(body?.username);
      if (!username) return response(400, { error: "Username is required" });

      const container = await getUserContainer();
      const id = username;
      const now = new Date().toISOString();

      let user;
      try {
        const { resource } = await container.item(id, id).read();
        user = resource;
      } catch (err) {
        if (err.code !== 404 && err.statusCode !== 404) throw err;
      }

      if (user) {
        user.lastLoginAt = now;
        const { resource: updated } = await container.item(id, id).replace(user);
        return response(200, updated);
      }

      const newUser = {
        id,
        username: id,
        createdAt: now,
        lastLoginAt: now
      };

      const { resource: created } = await container.items.create(newUser);
      return response(201, created);
    } catch (err) {
      context.error(err);
      return response(500, { error: err.message || String(err) });
    }
  }
});

/* ================= CLIPS ================= */

app.http("clipsPlayUrls", {
  methods: ["GET"],
  route: "clips/{id}/playUrls",
  authLevel: "anonymous",
  handler: async (req, context) => {
    try {
      requireEnv();

      const id = req.params.id;
      const userId = req.query.get("userId");

      const container = await getCosmosContainer();
      const { resource } = await container.item(id, userId).read();
      if (!resource) return response(404, { error: "Not found" });

      return response(200, {
        id: resource.id,
        userId: resource.userId,
        videoUrl: getReadSasUrl(resource.videoBlobName, 60),
        thumbnailUrl: resource.thumbnailBlobName
          ? getReadSasUrl(resource.thumbnailBlobName, 60)
          : null
      });
    } catch (err) {
      context.error(err);
      return response(500, { error: err.message });
    }
  }
});

app.http("clipsCreate", {
  methods: ["POST"],
  route: "clips",
  authLevel: "anonymous",
  handler: async (req, context) => {
    try {
      requireEnv();

      const data = await req.json();
      const title = data?.title?.trim();
      const genre = data?.genre || "unknown";
      const userId = data?.userId;

      const videoFileName = sanitizeFileName(data?.videoFileName);
      const thumbnailFileName = sanitizeFileName(data?.thumbnailFileName);

      if (!title || !videoFileName || !userId) {
        return response(400, { error: "Missing required fields" });
      }

      const id = uuidv4();
      const base = `${userId}/${id}`;

      const videoBlobName = `${base}-video-${videoFileName}`;
      const thumbnailBlobName = thumbnailFileName
        ? `${base}-thumb-${thumbnailFileName}`
        : null;

      const bsc = getBlobServiceClient();
      await bsc.getContainerClient(config.blob.container).createIfNotExists();

      const doc = {
        id,
        userId,
        title,
        genre,
        videoBlobName,
        thumbnailBlobName,
        status: "pending-upload",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const container = await getCosmosContainer();
      await container.items.create(doc);

      return response(201, {
        clip: doc,
        videoUploadUrl: getUploadSasUrl(videoBlobName),
        thumbnailUploadUrl: thumbnailBlobName
          ? getUploadSasUrl(thumbnailBlobName)
          : null
      });
    } catch (err) {
      context.error(err);
      return response(500, { error: err.message });
    }
  }
});

app.http("clipsList", {
  methods: ["GET"],
  route: "clips",
  authLevel: "anonymous",
  handler: async (req, context) => {
    try {
      requireEnv();

      const showAll = req.query.get("all") === "true";
      const userId = req.query.get("userId");

      const container = await getCosmosContainer();
      const query = showAll
        ? { query: "SELECT * FROM c" }
        : {
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

app.http("clipsUpdate", {
  methods: ["PUT"],
  route: "clips/{id}",
  authLevel: "anonymous",
  handler: async (req, context) => {
    try {
      requireEnv();

      const id = req.params.id;
      const userId = req.query.get("userId");
      const data = await req.json();

      const container = await getCosmosContainer();
      const { resource } = await container.item(id, userId).read();
      if (!resource) return response(404, { error: "Not found" });

      Object.assign(resource, data, { updatedAt: new Date().toISOString() });
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
    try {
      requireEnv();

      const id = req.params.id;
      const userId = req.query.get("userId");

      const container = await getCosmosContainer();
      const { resource } = await container.item(id, userId).read();
      if (!resource) return response(404, { error: "Not found" });

      const containerClient = getBlobServiceClient().getContainerClient(config.blob.container);
      await Promise.all(
        [resource.videoBlobName, resource.thumbnailBlobName]
          .filter(Boolean)
          .map(b => containerClient.getBlobClient(b).deleteIfExists())
      );

      await container.item(id, userId).delete();
      return response(200, { deleted: true });
    } catch (err) {
      context.error(err);
      return response(500, { error: err.message });
    }
  }
});

app.http("clipsView", {
  methods: ["POST"],
  route: "clips/{id}/view",
  authLevel: "anonymous",
  handler: async (req, context) => {
    try {
      requireEnv();
      const id = req.params.id;
      const userId = req.query.get("userId"); // Owner ID

      if (!userId) return response(400, { error: "Owner userId is required" });

      const container = await getCosmosContainer();
      const { resource } = await container.item(id, userId).read();
      if (!resource) return response(404, { error: "Clip not found" });

      resource.views = (resource.views || 0) + 1;
      await container.item(id, userId).replace(resource);

      return response(200, { views: resource.views });
    } catch (err) {
      context.error(err);
      return response(500, { error: err.message });
    }
  }
});

app.http("clipsLike", {
  methods: ["POST"],
  route: "clips/{id}/like",
  authLevel: "anonymous",
  handler: async (req, context) => {
    try {
      requireEnv();
      const id = req.params.id;
      const userId = req.query.get("userId"); // Owner ID
      const body = await req.json();
      const likerId = body.userId; // Current user ID

      if (!userId || !likerId) return response(400, { error: "Missing required fields" });

      const container = await getCosmosContainer();
      const { resource } = await container.item(id, userId).read();
      if (!resource) return response(404, { error: "Clip not found" });

      if (!Array.isArray(resource.likes)) resource.likes = [];
      
      const idx = resource.likes.indexOf(likerId);
      const liked = idx === -1;
      
      if (liked) resource.likes.push(likerId);
      else resource.likes.splice(idx, 1);

      await container.item(id, userId).replace(resource);

      return response(200, { likes: resource.likes.length, liked });
    } catch (err) {
      context.error(err);
      return response(500, { error: err.message });
    }
  }
});

/* ================= FRONTEND ================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.http("serveFrontend", {
  methods: ["GET"],
  route: "app",
  authLevel: "anonymous",
  handler: async () => {
    const htmlPath = path.join(__dirname, "index.html");
    const content = await readFile(htmlPath, "utf-8");
    return {
      status: 200,
      headers: { "Content-Type": "text/html" },
      body: content
    };
  }
});
