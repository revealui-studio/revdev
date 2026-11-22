import type { Migration } from '../storage/migrate.js';

export const MIGRATION_0017: Migration = {
  version: 17,
  name: 'session-process-birth',
  sql: `ALTER TABLE agent_sessions ADD COLUMN process_birth TEXT;`,
};
