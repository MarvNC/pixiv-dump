import { fetchURL, HttpError } from '../fetch/fetchURL';
import { PIXIV_API_BASE_URL } from '../constants';

export class ArticleNotFoundError extends Error {
  constructor(tag_name: string) {
    super(`Article not found: ${tag_name}`);
    this.name = 'ArticleNotFoundError';
  }
}

export class ArticleSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArticleSchemaError';
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
  view_count?: number;
  illust_count?: number;
  check_count?: number;
  updated_at: string;
};

function apiUrl(path: string, tag_name: string) {
  return `${PIXIV_API_BASE_URL}${path}/${encodeURIComponent(tag_name)}?lang=ja`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetchURL(url);
  return response.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireShape(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ArticleSchemaError(message);
  }
}

function optionalString(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

function validRelatedArticle(value: unknown): boolean {
  return isRecord(value) && optionalString(value.tagName);
}

function parseArticleResponse(value: unknown): ArticleApi {
  requireShape(isRecord(value), 'Article response must be an object');
  const knownFields = [
    'categories',
    'yomigana',
    'abstract',
    'nodes',
    'mainIllust',
    'relatedArticles',
    'updatedAtTimestamp',
  ];
  requireShape(
    knownFields.some((field) => Object.hasOwn(value, field)),
    'Article response has no recognized fields',
  );
  for (const field of ['yomigana', 'abstract', 'nodes']) {
    requireShape(
      optionalString(value[field]),
      `Article ${field} must be a string`,
    );
  }
  requireShape(
    value.categories == null ||
      (Array.isArray(value.categories) &&
        value.categories.every((category) => typeof category === 'string')),
    'Article categories must be a string array',
  );
  requireShape(
    value.mainIllust == null ||
      (isRecord(value.mainIllust) && optionalString(value.mainIllust.imageUrl)),
    'Article illustration must contain a string URL',
  );
  if (value.relatedArticles != null) {
    const related = value.relatedArticles;
    requireShape(isRecord(related), 'Article relationships must be an object');
    requireShape(
      related.parent_article == null ||
        validRelatedArticle(related.parent_article),
      'Article parent must contain a string tag',
    );
    for (const field of ['child_articles', 'sibling_articles']) {
      const articles = related[field];
      requireShape(
        articles == null ||
          (Array.isArray(articles) && articles.every(validRelatedArticle)),
        `Article ${field} must contain related articles`,
      );
    }
  }
  requireShape(
    value.updatedAtTimestamp == null ||
      (typeof value.updatedAtTimestamp === 'number' &&
        Number.isFinite(value.updatedAtTimestamp) &&
        Number.isFinite(new Date(value.updatedAtTimestamp * 1000).getTime())),
    'Article update timestamp must be a valid Unix timestamp',
  );
  return value as ArticleApi;
}

function parseBreadcrumbsResponse(value: unknown): BreadcrumbItem[] {
  requireShape(
    Array.isArray(value) &&
      value.every((item) => isRecord(item) && typeof item.tagName === 'string'),
    'Breadcrumb response must be an array of tag names',
  );
  return value as BreadcrumbItem[];
}

function parseInfoResponse(value: unknown): ArticleInfoApi {
  requireShape(isRecord(value), 'Article info response must be an object');
  const fields = ['articleViewCount', 'pixivWorkCount', 'checklistCount'];
  requireShape(
    fields.some((field) => Object.hasOwn(value, field)),
    'Article info response has no recognized counts',
  );
  for (const field of fields) {
    const count = value[field];
    requireShape(
      count == null ||
        (typeof count === 'number' &&
          Number.isSafeInteger(count) &&
          count >= 0),
      `Article info ${field} must be a nonnegative integer`,
    );
  }
  return value as ArticleInfoApi;
}

function validateNodes(value: unknown): asserts value is ArticleNode[] {
  requireShape(Array.isArray(value), 'Article nodes must be an array');
  for (const node of value) {
    requireShape(
      isRecord(node) && optionalString(node.tag) && optionalString(node.text),
      'Article node must contain string tag and text fields',
    );
    if (node.children != null) {
      validateNodes(node.children);
    }
  }
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
  const parsed: unknown = JSON.parse(nodes);
  validateNodes(parsed);
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
  let mainText: string;
  let breadcrumbs: BreadcrumbItem[] | null;
  let info: ArticleInfoApi | null;
  const ignoreOptional = (error: unknown) => {
    if (error instanceof HttpError && error.status === 404) {
      return null;
    }
    throw error;
  };

  try {
    article = parseArticleResponse(
      await fetchJson(apiUrl('/get_article', tag_name)),
    );
    mainText = getMainText(article);
    breadcrumbs = await fetchJson(apiUrl('/get_breadcrumbs', tag_name))
      .then(parseBreadcrumbsResponse)
      .catch(ignoreOptional);
    info = await fetchJson(apiUrl('/get_article_info', tag_name))
      .then(parseInfoResponse)
      .catch(ignoreOptional);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new ArticleNotFoundError(tag_name);
    }
    throw error;
  }

  return {
    reading: article.yomigana || '',
    header: getHeaders(breadcrumbs, article.categories, tag_name),
    mainText,
    summary: article.abstract || '',
    parent: article.relatedArticles?.parent_article?.tagName || null,
    related_tags: relatedTagNames(article, tag_name),
    main_illst_url: article.mainIllust?.imageUrl || '',
    view_count: info?.articleViewCount ?? undefined,
    illust_count: info?.pixivWorkCount ?? undefined,
    check_count: info?.checklistCount ?? undefined,
    updated_at: formatUpdatedAt(article.updatedAtTimestamp),
  };
}
