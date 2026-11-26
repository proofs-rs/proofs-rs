# Proofs.rs blog

The Markdown articles, site configuration and Hugo theme are maintained in
[proofs-rs/blog](https://github.com/proofs-rs/blog). Do not edit generated files
under this repository's `public/blog/` directly. `blog-source.txt` records the
exact source revision deployed by this checkout.

To publish an update, follow the blog repository's setup instructions, check
out its desired clean commit, then run in this repository:

```sh
node scripts/sync-blog.mjs ../blog
npm test
npm run build
```

Commit `public/blog/` and `blog-source.txt` on a `staging/*` branch and open a
pull request. The normal staging and production Workers serve the generated
files from `/blog/` without a separate domain or deployment credential. Merging
in the blog repository does not on its own publish the update.
