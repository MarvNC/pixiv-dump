import { JSDOM } from 'jsdom';
import { fetchURL } from '../fetch/fetchURL';
import { prisma } from '..';
import { pixivArticleURL } from './scrapeAllReadings';

export async function scrapeSingleArticleInfo(tag_name: string) {
  // Fetch the page
  const url = pixivArticleURL(tag_name);
  const response = await fetchURL(url);
  const dom = new JSDOM(response.data);
  // Get the reading
  const reading = getReading(dom);
  // Get headers
  const header = getHeaders(dom);

  // Update the article
  await prisma.pixivArticle.update({
    where: { tag_name },
    data: {
      lastScrapedReading: Date.now().toString(),
      reading,
      header: JSON.stringify(header),
    },
  });
}

function getHeaders(dom: JSDOM) {
  const breadcrumbs = dom.window.document.getElementById('breadcrumbs');
  const header = breadcrumbs
    ? [...breadcrumbs.children].map((child) => child.textContent)
    : [];
  return header;
}

function getReading(dom: JSDOM) {
  return dom.window.document.querySelector('p.subscript')?.textContent;
}
