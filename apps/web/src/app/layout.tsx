import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/anton/400.css';
import { Shell } from '@/components/Shell';
import { DirectionContract } from '@/components/DirectionContract';
import { StoreProvider } from '@/context/store';
import './globals.css';

export const metadata: Metadata = {
  title: 'Namak Kitchen · Assessment Demo',
  description: 'A synthetic menu for a food ordering assessment.',
};

const direction = `THESIS: A counter ticket makes choosing a variant and reviewing a live cart feel like one continuous order; no generic card dashboard.
OWN-WORLD: Warm paper #f4eee4, charcoal ink #24221e, action red #b43d31, and blue status stamps; photographic dish tickets, fine rules, condensed Anton display, tabular prices.
STORY: Choose an available dish and size, see the API-priced cart, review and place an order, then follow its recorded state.
FIRST VIEWPORT: An 88px masthead leads to a large Make it yours heading; three photo tickets fill the left two-thirds and the persistent order docket holds the right third, with Review cart as its primary action.
FORM: Counter Ticket No. 01, selected first of the approved compositions; seed ffe81597.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body suppressHydrationWarning>
    <template id="direction-contract" dangerouslySetInnerHTML={{ __html: `<!-- ${direction} -->` }} />
    <DirectionContract text={direction} />
    <StoreProvider><Shell>{children}</Shell></StoreProvider>
  </body></html>;
}
