import fetchPixivPage from './util/fetchPixivPage';

(async () => {
  console.log(await fetchPixivPage('アニメ', 1));
})();
