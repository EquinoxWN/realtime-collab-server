// Run the server: COLLAB_SECRET (32+ characters) is required; PORT, HOST and ALLOWED_ORIGINS are optional.
import { startServer } from "./server.js";

const secret = process.env.COLLAB_SECRET ?? "";
if (secret.length < 32) {
  console.error("set COLLAB_SECRET to a random string of at least 32 characters");
  process.exit(2);
}
const server = await startServer({
  secret,
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "127.0.0.1",
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
});
console.log(`collaboration server listening on ${server.url}`);
const stop = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
