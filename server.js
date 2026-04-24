import express from "express";
import { createServer } from "http";
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { bareMux } from "@mercuryworkshop/bare-mux";
import { BareServer } from "bare-server-node";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bare = new BareServer("/bare/");
const app = express();
const PORT = process.env.PORT || 3000;

// Serve Ultraviolet static files
app.use("/uv/", express.static(uvPath));
app.use("/epoxy/", express.static(epoxyPath));

// Serve your frontend from /public
app.use(express.static(path.join(__dirname, "public")));

// Fallback to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = createServer();

server.on("request", (req, res) => {
  if (bare.shouldRoute(req)) bare.routeRequest(req, res);
  else app(req, res);
});

server.on("upgrade", (req, socket, head) => {
  if (bare.shouldRoute(req)) bare.routeUpgrade(req, socket, head);
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`SwiftProxy running on port ${PORT}`);
});
