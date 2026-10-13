import { app } from "./app.js";

export default {
  async fetch(request, env, ctx) {
    // Attach env so client.js can read secrets / KV
    app.env = env;
    return app.fetch(request, env, ctx);
  },
};
