const https = require("https");
const URL = process.env.URL || "https://shooter-mfal.onrender.com";
const MARKER = process.env.MARKER || "group: mesh.group";
const t0 = Date.now();

function poll() {
  https
    .get(URL + "/main.js", (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => {
        if (d.includes(MARKER)) {
          console.log(`[DEPLOY] marker live in ${Date.now() - t0}ms`);
          process.exit(0);
        } else {
          retry();
        }
      });
    })
    .on("error", () => retry());
}

function retry() {
  if (Date.now() - t0 > 300000) {
    console.log("TIMEOUT waiting deploy");
    process.exit(1);
  }
  setTimeout(poll, 10000);
}

poll();