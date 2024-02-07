import fetchPixivPage from './util/fetchPixivPage';

(async () => {
  const data = await fetchPixivPage('アニメ', 1);
  console.log(data.meta);
})();
