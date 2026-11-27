# lean-miri landing page

The canonical landing page is https://proofs.rs/lean-miri/. Its source is
`site/index.html` in [proofs-rs/lean-miri](https://github.com/proofs-rs/lean-miri).
The API reference stays on [GitHub Pages](https://proofs-rs.github.io/lean-miri/Miri.html).

To publish an LP update, check out the desired lean-miri commit and run:

```sh
node scripts/sync-lean-miri.mjs ../lean-miri
node scripts/sync-lean-miri.mjs ../lean-miri --check
npm test
npm run build
```

Commit the generated `public/lean-miri/index.html` and `lean-miri-source.txt`
in a staging pull request. The normal Workers deployment publishes the landing
page without building the Lean API docs. Keep GitHub Pages module URLs and
`api-index.html` unchanged.
