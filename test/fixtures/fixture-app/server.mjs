// Minimal dependency-free login app used by the deterministic reproduction tests.
// BUGGY=1 seeds the bug: POST /api/login returns HTTP 500 instead of HTTP 401.

import http from "node:http";

const port = Number(process.env.PORT ?? 3000);
const buggy = process.env.BUGGY === "1";

const page = `<!doctype html>
<html>
  <head><title>Fixture Login</title></head>
  <body>
    <h1>Fixture Login</h1>
    <form id="login-form">
      <input name="email" type="email" placeholder="email" />
      <input name="password" type="password" placeholder="password" />
      <button type="submit">Log in</button>
    </form>
    <p id="message"></p>
    <script>
      document.getElementById("login-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch("/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: document.querySelector("[name='email']").value,
            password: document.querySelector("[name='password']").value,
          }),
        });
        document.getElementById("message").textContent = response.ok
          ? "Logged in"
          : "Login failed (" + response.status + ")";
      });
    </script>
  </body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
    return;
  }

  if (req.method === "POST" && req.url === "/api/login") {
    req.resume();
    req.on("end", () => {
      if (buggy) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      } else {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid credentials" }));
      }
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`Fixture app listening on http://localhost:${port}`);
});
