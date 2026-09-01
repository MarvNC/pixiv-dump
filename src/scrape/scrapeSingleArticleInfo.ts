import { CloudflareError, fetchURL, HttpError } from '../fetch/fetchURL';
import { PIXIV_API_BASE_URL } from '../constants';

export class ArticleNotFoundError extends Error {
  constructor(tag_name: string) {
    super(`Article not found: ${tag_name}`);
    this.name = 'ArticleNotFoundError';
  }
}

type RelatedArticle = {
  tagName?: string;
};

type ArticleNode = {
  tag?: string;
  text?: string;
  children?: ArticleNode[];
};

type ArticleApi = {
  categories?: string[];
  yomigana?: string;
  abstract?: string;
  nodes?: string;
  mainIllust?: { imageUrl?: string };
  relatedArticles?: {
    parent_article?: RelatedArticle;
    child_articles?: RelatedArticle[];
    sibling_articles?: RelatedArticle[];
  };
  updatedAtTimestamp?: number;
};

type ArticleInfoApi = {
  articleViewCount?: number;
  pixivWorkCount?: number;
  checklistCount?: number;
};

type BreadcrumbItem = {
  tagName: string;
  url: string;
};

export type ScrapedArticle = {
  reading: string;
  header: string[];
  mainText: string;
  summary: string;
  parent: string | null;
  related_tags: string[];
  main_illst_url: string;
  view_count: number;
  illust_count: number;
  check_count: number;
  updated_at: string;
};

function apiUrl(path: string, tag_name: string) {
  return `${PIXIV_API_BASE_URL}${path}/${encodeURIComponent(tag_name)}?lang=ja`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetchURL(url);
  return response.data as T;
}

function relatedTagNames(article: ArticleApi, tag_name: string): string[] {
  const related = article.relatedArticles;
  const names: string[] = [];
  const seen = new Set<string>([tag_name]);
  const add = (name?: string) => {
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    names.push(name);
  };
  add(related?.parent_article?.tagName);
  for (const child of related?.child_articles ?? []) {
    add(child.tagName);
  }
  for (const sibling of related?.sibling_articles ?? []) {
    add(sibling.tagName);
  }
  return names;
}

function getHeaders(
  breadcrumbs: BreadcrumbItem[] | null,
  categories: string[] | undefined,
  tag_name: string,
): string[] {
  let headers: string[] = [];
  if (breadcrumbs && breadcrumbs.length > 0) {
    headers = breadcrumbs.map((bc) => bc.tagName);
  } else if (categories && categories.length > 0) {
    headers = [...categories];
  }
  if (!headers.includes(tag_name)) {
    headers.push(tag_name);
  }
  if (!headers.length) {
    throw new Error(`No headers found for tag: ${tag_name}`);
  }
  return headers;
}

function nodeText(node: ArticleNode): string {
  if (node.children) {
    return node.children.map(nodeText).join('');
  }
  return node.text || '';
}

function getFirstSectionText(nodes: string | undefined): string {
  if (!nodes) {
    return '';
  }
  const parsed = JSON.parse(nodes) as ArticleNode[];
  const firstHeading = parsed.findIndex((node) => node.tag === 'header');
  const afterHeading = parsed.slice(firstHeading + 1);
  const nextHeading = afterHeading.findIndex((node) => node.tag === 'header');
  const section =
    nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  return section
    .filter((node) => node.tag === 'p')
    .map(nodeText)
    .filter((text) => text !== '')
    .join('\n');
}

function getMainText(article: ArticleApi): string {
  const abstract = article.abstract || '';
  const text = getFirstSectionText(article.nodes);
  if (abstract && text) {
    return `${abstract}\n\n${text}`;
  }
  return abstract || text || '';
}

function formatUpdatedAt(unixSeconds?: number): string {
  if (!unixSeconds) {
    return '';
  }
  const jst = new Date(unixSeconds * 1000 + 9 * 60 * 60 * 1000);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(
    jst.getUTCDate(),
  )} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(
    jst.getUTCSeconds(),
  )}`;
}

export async function scrapeSingleArticleInfo(
  tag_name: string,
): Promise<ScrapedArticle> {
  let article: ArticleApi;
  let breadcrumbs: BreadcrumbItem[] | null;
  let info: ArticleInfoApi | null;
  const ignoreOptional = (error: unknown) => {
    if (error instanceof CloudflareError) {
      throw error;
    }
    return null;
  };

  try {
    article = await fetchJson<ArticleApi>(apiUrl('/get_article', tag_name));
    breadcrumbs = await fetchJson<BreadcrumbItem[]>(
      apiUrl('/get_breadcrumbs', tag_name),
    ).catch(ignoreOptional);
    info = await fetchJson<ArticleInfoApi>(
      apiUrl('/get_article_info', tag_name),
    ).catch(ignoreOptional);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new ArticleNotFoundError(tag_name);
    }
    throw error;
  }

  return {
    reading: article.yomigana || '',
    header: getHeaders(breadcrumbs, article.categories, tag_name),
    mainText: getMainText(article),
    summary: article.abstract || '',
    parent: article.relatedArticles?.parent_article?.tagName || null,
    related_tags: relatedTagNames(article, tag_name),
    main_illst_url: article.mainIllust?.imageUrl || '',
    view_count: info?.articleViewCount || 0,
    illust_count: info?.pixivWorkCount || 0,
    check_count: info?.checklistCount || 0,
    updated_at: formatUpdatedAt(article.updatedAtTimestamp),
  };
}
