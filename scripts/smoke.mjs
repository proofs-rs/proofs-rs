const origin = process.argv[2];
const environment = process.argv[3] || "staging";
if (!origin?.startsWith("https://")) throw Error("Expected HTTPS URL");
for (const path of [
  "/",
  "/api/docs",
  "/book/review-a-dependency.html",
  "/openapi.json",
  "/api/v1/health",
  "/api/v1/home",
  "/api/v1/reports",
  "/api/v1/crates",
  "/api/v1/tools",
  "/api/v1/me",
  "/api/v1/config",
]) {
  let r;
  for (let attempt = 0; attempt < 6; attempt++) {
    r = await fetch(origin + path);
    if (r.ok || ![404, 502, 503, 504].includes(r.status)) break;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (!r.ok) throw Error(path + " returned " + r.status);
  if (
    environment === "staging" &&
    !r.headers.get("x-robots-tag")?.includes("noindex")
  )
    throw Error("Missing staging noindex header");
  if (path === "/book/review-a-dependency.html") {
    const html = await r.text();
    if (
      !html.includes("Review a dependency") ||
      !html.includes('href="publish-a-report.html"')
    )
      throw Error("Dependency tutorial heading or publishing link missing");
  }
  if (path === "/openapi.json" && (await r.json()).openapi !== "3.1.0")
    throw Error("Invalid OpenAPI document");
  if (path === "/api/v1/config") {
    const config = await r.json();
    if (config.environment !== environment)
      throw Error("Wrong deployment environment");
    if (
      environment === "production" &&
      origin === "https://proofs.rs" &&
      !config.oauth_configured
    )
      throw Error("Production OAuth is unavailable");
    console.log(
      "Integration configuration: OAuth=" +
        config.oauth_configured +
        ", email=" +
        config.email_configured,
    );
  }
  console.log("OK " + path);
}
