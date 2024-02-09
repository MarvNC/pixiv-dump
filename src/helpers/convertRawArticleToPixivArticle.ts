import { PixivArticle } from '@prisma/client';

/**
 * Converts a raw article object to a PixivArticle object.
 */
export function convertRawArticleToPixivArticle(rawArticle: RawArticle): PixivArticle {
  return {
    tag_name: rawArticle.tag_name,
    summary: rawArticle.summary,
    updated_at: rawArticle.updated_at,
    main_illst_url: rawArticle.main_illst_url,
    view_count: rawArticle.view_count,
    illust_count: rawArticle.illust_count,
    check_count: rawArticle.check_count,
    related_tags: JSON.stringify(rawArticle.related_tags),
    parent: rawArticle.parent,
    lastScraped: Date.now().toString(),
    reading: null,
    header: null,
    lastScrapedReading: null,
  };
}
