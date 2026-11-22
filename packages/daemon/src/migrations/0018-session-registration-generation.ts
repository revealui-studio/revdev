import type { Migration } from '../storage/migrate.js';

export const MIGRATION_0018: Migration = {
  version: 18,
  name: 'session-registration-generation',
  sql: `ALTER TABLE agent_sessions ADD COLUMN registration_generation TEXT;`,
};
