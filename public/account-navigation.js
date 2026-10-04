// Shared by the application bundle and mdBook's standard additional-js loader.
(() => {
  const escapeHTML = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  window.proofsAccountNavigation = (
    container,
    me,
    siteRoot,
    logout,
    onError,
    showStarKarma = false,
  ) => {
    const link = (path, label) => `<a href="${siteRoot}#/${path}">${label}</a>`;
    container.innerHTML = me.user
      ? `<details><summary>${escapeHTML(me.user.username)}</summary><div class="profile-menu">${
          link(
            "account",
            `My activity${showStarKarma ? ` (${escapeHTML(me.karma)} karma)` : ""}`,
          ) +
          link("settings", "Settings") +
          (me.user.role === "admin" ? link("admin/catalogs", "Catalogs") : "")
        }<button id="logout">Sign out</button></div></details>`
      : '<div class="signin"><a href="/auth/github">Sign in with GitHub</a></div>';
    container
      .querySelector("#logout")
      ?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await logout();
        } catch (error) {
          button.disabled = false;
          onError(error);
        }
      });
  };
})();
