import { createApp } from "./app.js";
import { config } from "./config.js";

createApp().listen(config.port, () => {
  console.info(`ResortOS booking API listening on :${config.port}`);
});
