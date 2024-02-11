import test from 'ava';
import { isPixivPageResponse } from '../fetch/isPixivPageResponse';

test('has articles', (t) => {
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
});

test('missing articles', (t) => {
  t.false(
    isPixivPageResponse({
      meta: {
        all_count: 1,
        count: 1,
        page: 1,
      },
    }),
  );
});

test('empty articles', (t) => {
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
