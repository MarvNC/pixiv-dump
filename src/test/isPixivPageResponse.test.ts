import test from 'ava';
import { isPixivPageResponse } from '../fetch/isPixivPageResponse';

test('isPixivPageResponse', (t) => {
  t.true(
    isPixivPageResponse({
      meta: {
        all_count: 1,
        count: 1,
        page: 1,
      },
      articles: [{}],
    }),
  );
  t.false(
    isPixivPageResponse({
      meta: {
        all_count: 1,
        count: 1,
        page: 1,
      },
    }),
  );
  t.true(
    isPixivPageResponse({
      meta: {
        all_count: 1,
        count: 1,
        page: 1,
      },
      articles: [],
    }),
  );
});
