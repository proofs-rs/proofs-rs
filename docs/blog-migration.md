# Blog migration

Source: the [proofs.rs Hashnode RSS feed](https://proofs-rs.hashnode.dev/rss.xml), fetched on November 26, 2026. It listed three public posts by Yuichi Nishiwaki, each with the full HTML body. The feed's GUIDs are retained; links in the new feed point to proofs.rs. The three original article pages confirmed the canonical slugs. None showed an inline image or custom cover; Hashnode generated its social share images. The new site uses its own social cards.

| Original date (UTC) | Hashnode slug                                                                 | New path                                                                            |
| ------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 2026-10-10          | announcing-proofs-rs-a-public-registry-for-rust-formal-verification-results   | /blog/announcing-proofs-rs-a-public-registry-for-rust-formal-verification-results   |
| 2026-11-03          | lean-miri-formally-proving-rust-programs-free-of-undefined-behavior-with-lean | /blog/lean-miri-formally-proving-rust-programs-free-of-undefined-behavior-with-lean |
| 2026-11-24          | how-google-s-zerocopy-project-uses-lean-miri-to-verify-unsafe-rust            | /blog/how-google-s-zerocopy-project-uses-lean-miri-to-verify-unsafe-rust            |

The new site also redirects `/blog/how-anneal-uses-lean-miri` to the current Anneal slug. This cannot redirect requests to the old Hashnode hostname.

## Publication checklist

1. Review the new WP article and set its date to the actual publication date if that differs from the draft.
2. Deploy and confirm `/blog`, each article, the old wording alias, `/blog/rss.xml`, and the sitemap. Compare the pages with the Hashnode originals. Private drafts, subscriber data, and comments aren't copied by the public feed.
3. Keep the old posts accessible. Only after the new links work, consider setting each old post's original-article/canonical URL to its new page in Hashnode. Do not delete the old blog or assume the old host returns 301s.
4. Use `/blog/rss.xml` for new subscriptions. Existing subscribers will not be moved automatically.
