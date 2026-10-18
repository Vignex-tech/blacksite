import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
} from "colyseus";
import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Import your Room files
 */
import { MyRoom } from "./rooms/MyRoom.js";

/**
 * Built client (client/dist). Same relative path from src/ (tsx) and build/ (tsc).
 */
const clientDist = fileURLToPath(new URL("../../client/dist", import.meta.url));

const server = defineServer({

  /**
   * Define your room handlers:
   */
  rooms: {
    my_room: defineRoom(MyRoom),
  },

  /**
   * Experimental: Define API routes. Built-in integration with the "playground" and SDK.
   *
   * Usage from SDK:
   *   client.http.get("/api/hello").then((response) => {})
   *
   */
  routes: createRouter({
    api_hello: createEndpoint("/api/hello", { method: "GET" }, async (ctx) => {
      return { message: "Hello World" };
    }),
  }),

  /**
   * Bind your custom express routes here:
   * Read more: https://expressjs.com/en/starter/basic-routing.html
   */
  express: (app) => {

    app.get("/hi", (req, res) => {
      res.send("It's time to kick ass and chew bubblegum!");
    });

    /**
     * Use @colyseus/monitor
     * If you expose it in production, make sure to protect it with a password:
     * https://docs.colyseus.io/tools/monitoring#password-protection
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
    }

    /**
     * Use @colyseus/playground
     * (It is not recommended to expose this route in a production environment)
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/playground", playground());
    }

    /**
     * Serve the built client, so the game and the server share one port.
     * Run `npm run build` in client/ first.
     */
    if (existsSync(clientDist)) {
      app.use(express.static(clientDist));
    } else {
      console.warn(`client build not found at ${clientDist}; run "npm run build" in client/`);
    }
  }
});

export default server;

