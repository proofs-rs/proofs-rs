(() => {
  const container = document.querySelector("#account-nav");
  if (!container) return;
  const showError = () => {
    let message = container.querySelector('[role="alert"]');
    if (!message) {
      message = document.createElement("p");
      message.setAttribute("role", "alert");
      container.append(message);
    }
    message.textContent = "Unable to sign out. Please try again.";
  };
  let showStarKarma = false;
  const configReady = fetch("/api/v1/config", { credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) throw new Error("Unable to load configuration");
      const config = await response.json();
      showStarKarma = config.show_star_karma === true;
      if (showStarKarma) {
        document
          .querySelectorAll("[data-star-karma-score]")
          .forEach((element) => {
            element.textContent =
              " User scores provide an additional signal derived from contributions to the community, helping readers decide whose judgments deserve greater weight.";
          });
      }
      if (showStarKarma && location.pathname.endsWith("/concepts.html")) {
        const anchor = document.getElementById("reproduce")?.closest("h2");
        if (anchor) {
          const section = document.createElement("section");
          section.innerHTML =
            '<h2 id="star--karma">Star / Karma</h2><p>Stars express interest in or appreciation of Reports and Claims. In the current implementation, Karma counts Stars received from other users on Reports that are public and have not been withdrawn. Comment ratings are not included in the calculation. Both are intended as signals that help readers evaluate contributions.</p>';
          anchor.before(section);
        }
      }
    })
    .catch(() => {});
  async function refresh() {
    try {
      const response = await fetch("/api/v1/me", {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Unable to check sign-in");
      const me = await response.json();
      await configReady;
      window.proofsAccountNavigation(
        container,
        me,
        "/",
        async () => {
          const response = await fetch("/auth/logout", {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": me.csrf || "",
            },
            body: "{}",
          });
          if (!response.ok) throw new Error("Unable to sign out");
          await refresh();
        },
        showError,
        showStarKarma,
      );
    } catch {
      container.innerHTML = '<a href="/#/account">Account</a>';
    }
  }
  void refresh();
})();
