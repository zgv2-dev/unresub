import { useSyncExternalStore } from 'react';

/** Live media-query match, e.g. useMedia('(min-width: 960px)'). */
export const useMedia = (query: string) =>
  useSyncExternalStore(
    cb => {
      const mq = matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => matchMedia(query).matches,
  );
