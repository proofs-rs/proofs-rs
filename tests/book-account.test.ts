import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

for (const showStarKarma of [false, true])
  for (const signedIn of [false, true]) {
    test(`Book account navigation and logout (signed in: ${signedIn}, reactions: ${showStarKarma})`, async () => {
      const dom = new JSDOM(
        '<div id="account-nav"><a href="/#/account">Account</a></div><p>Readers can inspect past contributions.<span data-star-karma-score></span></p><h2 id="reproduce">Reproduce</h2>',
        {
          url: "https://example.test/book/concepts.html",
          runScripts: "outside-only",
        },
      );
      const w = dom.window;
      let active = signedIn;
      let logoutCalls = 0;
      w.fetch = (async (path: string, options: RequestInit = {}) => {
        if (path === "/auth/logout") {
          assert.equal(options.method, "POST");
          assert.equal(
            (options.headers as Record<string, string>)["X-CSRF-Token"],
            "test-csrf",
          );
          active = false;
          logoutCalls++;
          return new Response("{}");
        }
        if (path === "/api/v1/config")
          return new Response(
            JSON.stringify({ show_star_karma: showStarKarma }),
          );
        assert.equal(path, "/api/v1/me");
        return new Response(
          JSON.stringify({
            user: active
              ? { username: '<img src=x onerror="alert(1)">', role: "admin" }
              : null,
            karma: 12,
            csrf: "test-csrf",
          }),
        );
      }) as any;
      try {
        for (const file of [
          "../public/account-navigation.js",
          "../book/theme/account.js",
        ]) {
          w.eval(readFileSync(new URL(file, import.meta.url), "utf8"));
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(!!w.document.querySelector("#star--karma"), showStarKarma);
        assert.equal(
          w.document.querySelector("[data-star-karma-score]")!.textContent,
          showStarKarma
            ? " User scores provide an additional signal derived from contributions to the community, helping readers decide whose judgments deserve greater weight."
            : "",
        );
        if (signedIn) {
          assert.equal(w.document.querySelector("img"), null);
          const menu = w.document.querySelector("details")!;
          assert.ok(menu);
          assert.equal(menu.open, false);
          const summary = menu.querySelector("summary")!;
          assert.equal(summary.textContent, '<img src=x onerror="alert(1)">');
          summary.click();
          assert.equal(menu.open, true);
          assert.equal(menu.querySelectorAll(".profile-menu > *").length, 4);
          summary.click();
          assert.equal(menu.open, false);
          summary.click();
          assert.deepEqual(
            Array.from(w.document.querySelectorAll("a"), (a) => [
              a.getAttribute("href"),
              a.textContent,
            ]),
            [
              [
                "/#/account",
                showStarKarma ? "My activity (12 karma)" : "My activity",
              ],
              ["/#/settings", "Settings"],
              ["/#/admin/catalogs", "Catalogs"],
            ],
          );
          assert.equal(
            w.document.querySelector("#logout")?.textContent,
            "Sign out",
          );
          (w.document.querySelector("#logout") as HTMLButtonElement).click();
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(logoutCalls, 1);
        }
        assert.equal(
          w.document.querySelector('a[href="/auth/github"]')?.textContent,
          "Sign in with GitHub",
        );
      } finally {
        w.close();
      }
    });
  }

for (const role of ["user", "admin"]) {
  test(`App account menu opens from username with role-specific items (${role})`, () => {
    const dom = new JSDOM('<div id="account-nav"></div>', {
      url: "https://example.test/",
      runScripts: "outside-only",
    });
    const w = dom.window;
    try {
      w.eval(
        readFileSync(
          new URL("../public/account-navigation.js", import.meta.url),
          "utf8",
        ),
      );
      (w as any).proofsAccountNavigation(
        w.document.querySelector("#account-nav"),
        { user: { username: "nyuichi", role }, karma: 0 },
        "",
        async () => {},
        assert.fail,
        true,
      );
      const menu = w.document.querySelector("details")!;
      assert.ok(menu);
      assert.equal(menu.open, false);
      const summary = menu.querySelector("summary")!;
      assert.equal(summary.textContent, "nyuichi");
      summary.click();
      assert.equal(menu.open, true);
      assert.deepEqual(
        Array.from(
          menu.querySelectorAll(".profile-menu > *"),
          (item) => item.textContent,
        ),
        [
          "My activity (0 karma)",
          "Settings",
          ...(role === "admin" ? ["Catalogs"] : []),
          "Sign out",
        ],
      );
      assert.equal(menu.querySelector("a")?.getAttribute("href"), "#/account");
      assert.equal(
        menu.querySelectorAll("a")[1].getAttribute("href"),
        "#/settings",
      );
      summary.click();
      assert.equal(menu.open, false);
    } finally {
      w.close();
    }
  });
}
