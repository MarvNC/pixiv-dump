import fetchPixivPage from './fetch/fetchPixivPage';
import { addArticle, setupDatabase } from './sql/sqlHandler';

(async () => {
  await setupDatabase();
  const data = await fetchPixivPage('', 1);
  for (const article of data.articles) {
    addArticle(article, Date.now());
  }
})();
