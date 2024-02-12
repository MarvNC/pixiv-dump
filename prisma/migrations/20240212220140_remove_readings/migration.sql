/*
  Warnings:

  - You are about to drop the column `header` on the `PixivArticle` table. All the data in the column will be lost.
  - You are about to drop the column `lastScrapedReading` on the `PixivArticle` table. All the data in the column will be lost.
  - You are about to drop the column `reading` on the `PixivArticle` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PixivArticle" (
    "tag_name" TEXT NOT NULL PRIMARY KEY,
    "summary" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "main_illst_url" TEXT NOT NULL,
    "view_count" INTEGER NOT NULL,
    "illust_count" INTEGER NOT NULL,
    "check_count" INTEGER NOT NULL,
    "related_tags" TEXT NOT NULL,
    "parent" TEXT,
    "lastScraped" TEXT NOT NULL
);
INSERT INTO "new_PixivArticle" ("check_count", "illust_count", "lastScraped", "main_illst_url", "parent", "related_tags", "summary", "tag_name", "updated_at", "view_count") SELECT "check_count", "illust_count", "lastScraped", "main_illst_url", "parent", "related_tags", "summary", "tag_name", "updated_at", "view_count" FROM "PixivArticle";
DROP TABLE "PixivArticle";
ALTER TABLE "new_PixivArticle" RENAME TO "PixivArticle";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
