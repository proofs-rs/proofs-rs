export type RunIndex = {
  id: string;
  sha256: string;
  size: number;
  r2_key: string;
};
export function migrateRecord(
  bytes: Buffer,
  row: RunIndex,
): null | { bytes: Buffer; sha256: string; size: number; r2_key: string };
export function planMigration(
  rows: RunIndex[],
  inputDirectory: string,
  outputDirectory: string,
  transform?: typeof migrateRecord,
): Promise<
  Array<{
    id: string;
    old_key: string;
    old_sha256: string;
    old_size: number;
    key: string;
    sha256: string;
    size: number;
  }>
>;
