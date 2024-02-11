type RawArticle = {
  summary: string;
  updated_at: string;
  tag_name: string;
  main_illst_url: string;
  view_count: number;
  illust_count: number;
  /**
   * チェックリスト数
   */
  check_count: number;
  related_tags: string[];
  parent: string;
};

/**
 * Represents a Pixiv page.
 */
type PixivPageResponse = {
  meta: {
    /**
     * Total number of articles in the category.
     */
    all_count: number;
    /**
     * Number of articles in the current page.
     */
    count: number;
    /**
     * Current page number.
     */
    page: number;
  };
  articles: RawArticle[];
};

type dateSort = 'newest' | 'oldest';
