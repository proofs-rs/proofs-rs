export function verifyRegisteredRecords(
  index: any[],
  client: (
    method: string,
    action: string,
    body?: any,
    key?: string,
  ) => Promise<any>,
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
): Promise<number>;
