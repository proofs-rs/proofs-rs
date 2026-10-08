export function maintenanceRequest(
  method: string,
  action: string,
  url: URL,
  options: RequestInit,
  fetcher?: typeof fetch,
  wait?: (ms: number) => Promise<void>,
): Promise<Response>;
export function verifyRegisteredRecords(
  index: any[],
  client: (
    method: string,
    action: string,
    body?: any,
    key?: string,
  ) => Promise<any>,
  transform?: typeof import("./migrate-run-dependencies.mjs").migrateRecord,
): Promise<void>;
export function safeFailureCode(error: unknown): string;
export function assertStagingTarget(config: any, origin: string): void;
export function maintenanceConfig(config: any, token: string): any;
export function atomicStatements(sql: string): string[];
export function migrateArchive(
  index: any[],
  client: (
    method: string,
    action: string,
    body?: any,
    key?: string,
  ) => Promise<any>,
  archive: string,
  output: string,
  backupPrefix: string,
  progress?: (phase: string) => void,
  transform?: typeof import("./migrate-run-dependencies.mjs").migrateRecord,
): Promise<number>;
