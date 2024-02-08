import { DB_FILENAME } from '../constants';
import { DB_FOLDER } from '../constants';
import fs from 'fs';
import * as path from 'path';
import sqlite3 from 'sqlite3';

const dbPath = path.join(DB_FOLDER, DB_FILENAME);

/**
 * Sets up the database
 */
export async function setupDatabase() {
  // Create the database folder if it doesn't exist
  if (!fs.existsSync(DB_FOLDER)) {
    fs.mkdirSync(DB_FOLDER);
  }
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
        related_tags TEXT,
        parent TEXT,
        scraped_at_epoch INTEGER
      )`,
    );
  });
  db.close();
}

/**
 * Adds an article to the database.
 */
export async function addArticle(article: Article, scrapedAt: number) {
  const db = new sqlite3.Database(dbPath);
  db.serialize(() => {
    const stmt = db.prepare(
      `INSERT INTO articles (
        tag_name,
        summary,
        updated_at,
        main_illst_url,
        view_count,
        illust_count,
        check_count,
        related_tags,
        parent,
        scraped_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      article.tag_name,
      article.summary,
      article.updated_at,
      article.main_illst_url,
      article.view_count,
      article.illust_count,
      article.check_count,
      article.related_tags.join(','),
      article.parent,
      scrapedAt,
    );
    stmt.finalize();
  });
  db.close();
}
