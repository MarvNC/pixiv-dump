import fetchPixivPage from './fetch/fetchPixivPage';
import { DB_FILENAME } from './constants';
import { DB_FOLDER } from './constants';
import fs from 'fs';
import * as path from 'path';
import sqlite3 from 'sqlite3';

(async () => {
  await setupDatabase();
  const data = await fetchPixivPage('', 1);
  console.log(data.articles);
})();

/**
 * Sets up the database
 */
async function setupDatabase() {
  // Create the database folder if it doesn't exist
  if (!fs.existsSync(DB_FOLDER)) {
    fs.mkdirSync(DB_FOLDER);
  }
  const dbPath = path.join(DB_FOLDER, DB_FILENAME);
  const db = new sqlite3.Database(dbPath);
  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS articles (
        tag_name TEXT PRIMARY KEY,
        summary TEXT,
        updated_at TEXT,
        main_illst_url TEXT,
        view_count INTEGER,
        illust_count INTEGER,
        check_count INTEGER,
        parent TEXT
      )`,
    );
  });
  db.close();
}
