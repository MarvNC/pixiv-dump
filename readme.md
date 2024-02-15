# Pixiv Encyclopedia Dump

This repository contains dumps of the
[Pixiv Encyclopedia](https://dic.pixiv.net/) (ピクシブ百科事典), a collection of
articles on various topics, including anime, manga, and games. The articles are
written by users and are available in Japanese.

## Download

:construction: The dumps are TBA.

<!-- The dumps are available in the
[releases](https://github.com/MarvNC/pixiv-dump/releases) section. -->

## Format

The dumps are available as sqlite3 databases. The detailed schema can be found
in the [schema.prisma](./prisma/schema.prisma) file.

```prisma
model PixivArticle {
  tag_name           String  @id
  summary            String
  updated_at         String
  main_illst_url     String
  view_count         Int
  illust_count       Int
  check_count        Int
  related_tags       String
  parent             String?
  lastScraped        String
  reading            String?
  header             String?
  mainText           String?
  lastScrapedReading String? // Unused
  lastScrapedArticle String?
}
```
