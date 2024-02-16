import { JSDOM } from 'jsdom';
import { fetchURL } from '../fetch/fetchURL';
import { prisma } from '..';
import { PIXIV_BASE_URL } from '../constants';
import { AxiosError } from 'axios';
const pixivArticleURL = (tag_name: string) =>
  `${PIXIV_BASE_URL}a/${encodeURIComponent(tag_name)}`;

export async function scrapeSingleArticleInfo(tag_name: string) {
  // Fetch the page
  const url = pixivArticleURL(tag_name);
  let response;
  try {
    response = await fetchURL(url);
  } catch (error: unknown) {
    const e = error as AxiosError;
    if (e.response?.status === 404) {
      console.log(`Article ${tag_name} was deleted from Pixiv`);
      // TODO: Delete the article from the database
      return;
    }
    throw error;
  }
  const dom = new JSDOM(response.data);
  const document = dom.window.document;
  const reading = getReading(document);
  const header = getHeaders(document);
  const mainText = getMainText(document);

  // Update the article
  await prisma.pixivArticle.update({
    where: { tag_name },
    data: {
      lastScrapedArticle: Date.now().toString(),
      reading,
      header: JSON.stringify(header),
      mainText,
    },
  });
}

function getHeaders(document: Document) {
  const breadcrumbs = document.getElementById('breadcrumbs');
  const header = breadcrumbs
    ? [...breadcrumbs.children].map((child) => child.textContent)
    : [];
  return header;
}

function getReading(document: Document) {
  return document.querySelector('p.subscript')?.textContent || '';
}

function getMainText(document: Document) {
  const articleBody = document.getElementById('article-body');
  if (!articleBody) {
    return '';
  }

  // Clean out article index/misc
  articleBody.querySelector('.article-index')?.remove();

  const gaiyou = [...articleBody.querySelectorAll('h2')].find((h2) => {
    return h2.textContent?.includes('概要');
  });
  let mainText = '';
  if (gaiyou) {
    mainText = getTextUntilH2(gaiyou.nextElementSibling);
  } else {
    // No gaiyou, just get the first paragraph
    mainText = getTextUntilH2(articleBody.firstElementChild);
  }
  return mainText.trim();
}

function getTextUntilH2(start: Element | null) {
  if (!start) {
    return '';
  }
  let text = '';
  let next: Element | null = start;
  while (next && next.tagName !== 'H2') {
    const cleanText = next.textContent?.trim();
    if (cleanText && next.tagName === 'P') {
      text += cleanText + '\n';
    }
    next = next.nextElementSibling;
  }
  return text;
}
