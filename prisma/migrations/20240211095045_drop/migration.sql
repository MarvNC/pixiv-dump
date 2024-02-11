/*
  Warnings:

  - You are about to drop the column `newestScraped` on the `scrapeProgress` table. All the data in the column will be lost.
  - You are about to drop the column `oldestScraped` on the `scrapeProgress` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_scrapeProgress" (
    "category" TEXT NOT NULL PRIMARY KEY
);
INSERT INTO "new_scrapeProgress" ("category") SELECT "category" FROM "scrapeProgress";
DROP TABLE "scrapeProgress";
ALTER TABLE "new_scrapeProgress" RENAME TO "scrapeProgress";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
