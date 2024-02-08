import fetchPixivPage from './util/fetchPixivPage';

(async () => {
  const data = await fetchPixivPage('', 1);
  console.log(data.articles);
})();
