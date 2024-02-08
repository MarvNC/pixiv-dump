-- CreateTable
CREATE TABLE "scrapeProgress" (
    "category" TEXT NOT NULL PRIMARY KEY,
    "newestDate" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "PixivArticle" (
    "tag_name" TEXT NOT NULL PRIMARY KEY,
    "summary" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "main_illst_url" TEXT NOT NULL,
    "view_count" INTEGER NOT NULL,
    "illust_count" INTEGER NOT NULL,
    "check_count" INTEGER NOT NULL,
    "related_tags" TEXT NOT NULL,
    "parent" TEXT NOT NULL,
    "lastScraped" TEXT NOT NULL,
    "reading" TEXT,
    "header" TEXT,
    "lastScrapedReading" TEXT
);
