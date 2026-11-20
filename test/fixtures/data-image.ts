import Database from 'better-sqlite3';
import { createDataSchema, type DataDatabase } from '../../src/core/data/database.js';

/** A closed, seeded household image. Each test opens its own connection on a copy. */
export function dataImage(seed: (db: DataDatabase) => void): Buffer {
  const client = new Database(':memory:');
  try {
    seed(createDataSchema(client));
    return client.serialize();
  } finally {
    client.close();
  }
}
