import type { z, creusotSpec } from "../src/schemas";

/** An explicit reference never falls back to prose matching. Shared by detail and Reproduce. */
export function resolveContract(sarif: any, runId: string, claim: any) {
  const contracts = sarif.runs[0].properties.proofs.contracts;
  if (claim.evidence_ref != null) {
    const ref = claim.evidence_ref;
    if (ref.run_id !== runId) return null;
    const matches = contracts.filter((c: any) => c.harness === ref.harness);
    if (
      matches.length !== 1 ||
      !matches[0].api_paths.includes(claim.display_path) ||
      !(matches[0].formal?.theorem === ref.harness || matches[0].spec)
    )
      return null;
    return matches[0];
  }
  return (
    contracts.find(
      (c: any) =>
        c.api_paths.includes(claim.display_path) &&
        c.precondition === claim.precondition,
    ) ?? null
  );
}
export const checkAnchor = (harness: string) =>
  "check-" +
  Array.from(new TextEncoder().encode(harness), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** Project a validated Creusot contract onto its immutable recorded source. */
export function specSourceLinks(
  contract: {
    spec: z.infer<typeof creusotSpec>;
    file: string;
    first_line: number;
    last_line: number;
  },
  repository: string,
  commit: string,
) {
  return {
    ...contract.spec,
    source_url: `${repository}/blob/${commit}/${contract.file.split("/").map(encodeURIComponent).join("/")}#L${contract.first_line}-L${contract.last_line}`,
  };
}

/** Resolve only source locations recorded for this exact revision. */
export function formalSourceLinks(
  formal: any,
  repository: string,
  commit: string,
) {
  const sourceURL = (source: any) =>
    `${repository}/blob/${commit}/${source.file.split("/").map(encodeURIComponent).join("/")}#L${source.first_line}-L${source.last_line}`;
  return {
    ...formal,
    source_url: sourceURL(formal.source),
    definitions: formal.definitions.map((d: any) => ({
      ...d,
      source_url: d.source ? sourceURL(d.source) : null,
    })),
  };
}
export function validLeanSegments(text: string, parts: any): boolean {
  return (
    Array.isArray(parts) &&
    parts.length <= 10000 &&
    parts.every(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        typeof p.text === "string" &&
        (p.ref === undefined ||
          (typeof p.ref === "string" &&
            p.ref.length > 0 &&
            p.ref.length <= 1000)),
    ) &&
    parts.map((p) => p.text).join("") === text &&
    new TextEncoder().encode(text).length <= 1000000
  );
}
