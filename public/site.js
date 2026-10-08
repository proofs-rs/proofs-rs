// Previously shared hash URLs need a browser redirect: fragments never reach the server.
(() => {
  if (location.pathname === "/" && location.hash.startsWith("#/")) {
    const url = new URL(location.hash.slice(1), location.origin);
    if (url.origin === location.origin)
      location.replace(url.pathname + url.search + url.hash);
  }
})();
