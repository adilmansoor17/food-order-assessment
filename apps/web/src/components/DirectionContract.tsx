'use client';

import { useEffect } from 'react';

export function DirectionContract({ text }: { text: string }) {
  useEffect(() => {
    const first = document.body.firstChild;
    if (first?.nodeType === Node.COMMENT_NODE && first.textContent?.includes('ffe81597')) {
      first.textContent = text;
      return;
    }
    document.body.insertBefore(document.createComment(text), first);
  }, [text]);
  return null;
}
