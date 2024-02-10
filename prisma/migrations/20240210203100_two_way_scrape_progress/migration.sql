/*
  Warnings:

  - You are about to drop the column `newestDate` on the `scrapeProgress` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_scrapeProgress" (
    "category" TEXT NOT NULL PRIMARY KEY,
    "newestScraped" TEXT NOT NULL DEFAULT '2000-01-01 00:00:00',
    "oldestScraped" TEXT NOT NULL DEFAULT '9999-12-31 23:59:59'
);
INSERT INTO "new_scrapeProgress" ("category") SELECT "category" FROM "scrapeProgress";
DROP TABLE "scrapeProgress";
ALTER TABLE "new_scrapeProgress" RENAME TO "scrapeProgress";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
