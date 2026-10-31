import semver from "semver";

/** Public releases use stable SemVer first, then the newest prerelease. */
export function defaultRelease<T extends { version: string }>(
  releases: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const release of releases) {
    if (
      !best ||
      (!!semver.prerelease(best.version) &&
        !semver.prerelease(release.version)) ||
      (!!semver.prerelease(best.version) ===
        !!semver.prerelease(release.version) &&
        semver.gt(release.version, best.version))
    )
      best = release;
  }
  return best;
}
export const compareReleases = (
  a: { version: string },
  b: { version: string },
) => semver.rcompare(a.version, b.version);

/** Strict Cargo SemVer, including build metadata which node-semver.valid omits. */
export function exactCargoVersion(version: string): boolean {
  const parsed = semver.parse(version);
  return (
    !!parsed &&
    `${parsed.version}${parsed.build.length ? "+" + parsed.build.join(".") : ""}` ===
      version
  );
}
