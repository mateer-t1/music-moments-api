import { app } from "@azure/functions";
import { getCosmosContainer, getUserContainer } from "../shared/cosmos.js";

import { requireEnv } from "../shared/config.js";

function response(status, body) {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

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

      const username = body?.username;
      if (!username) {
        return response(400, { error: "Username is required" });
      }

      const id = String(username).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
      if (!id) return response(400, { error: "Invalid username" });

      const container = await getUserContainer();
      
      let user;
      try {
        const { resource } = await container.item(id, id).read();
        user = resource;
      } catch (err) {
        if (err.code !== 404) throw err;
      }

      if (user) {
        user.lastLoginAt = new Date().toISOString();
        await container.item(id, id).replace(user);
        return response(200, user);
      }

      const newUser = { 
          id, 
          username: id, 
          createdAt: new Date().toISOString(),
          lastLoginAt: new Date().toISOString()
      };
      const { resource: created } = await container.items.create(newUser);
      return response(201, created);

    } catch (err) {
      context.error(err);
      if (err.message && (err.message.includes("ECONNREFUSED") || err.code === "ENOTFOUND")) {
        const isTypo = err.message.includes("mm-cosmos-fm");
        return response(500, {
          error: isTypo
              ? "Typo detected in local.settings.json: Change 'mm-cosmos-fm' to 'mm-cosmos-frn'."
              : "Connection failed. Check COSMOS_CONNECTION_STRING."
        });
      }
      return response(500, { error: err.message });
    }
  }
});
