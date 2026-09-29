'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useStore } from '@/context/store';
import { money } from '@/lib/api';
import type { ReactNode } from 'react';

const links = [
  { href: '/', label: 'Menu' },
  { href: '/cart', label: 'Cart' },
  { href: '/orders', label: 'Orders' },
  { href: '/account', label: 'Account' },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { cart, session, user, notice, dismissNotice, logout, pending, error } = useStore();
  const count = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  async function signOut() { if (await logout()) router.push('/'); }
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="masthead">
      <div className="masthead-inner">
        <Link href="/" className="wordmark" aria-label="Namak Kitchen, menu">
          <span className="wordmark-main">NAMAK KITCHEN</span>
          <span className="wordmark-line">COUNTER TICKET NO. 01</span>
        </Link>
        <span className="demo-label">ASSESSMENT DEMO</span>
        <nav className="main-nav" aria-label="Main navigation">
          {links.map((link) => <Link key={link.href} href={link.href} aria-current={pathname === link.href ? 'page' : undefined} className={pathname === link.href ? 'active' : ''}>{link.label}{link.href === '/cart' && <span className="nav-count" aria-label={`${count} items`}>{session === 'checking' ? '…' : count}</span>}</Link>)}
          {user?.role === 'admin' && <Link href="/admin" aria-current={pathname === '/admin' ? 'page' : undefined} className={pathname === '/admin' ? 'active' : ''}>Admin</Link>}
        </nav>
        <div className="masthead-account">
          {session === 'checking' ? <span role="status">Checking session…</span> : user ? <button type="button" onClick={() => void signOut()} disabled={pending('logout')}>{pending('logout') ? 'Signing out…' : 'Sign out'}</button> : <Link href="/account">Sign in</Link>}
          {error('logout') && <span role="alert" className="header-error">{error('logout')}</span>}
        </div>
        <div className="brand-emblem" aria-hidden="true">
          <svg viewBox="0 0 48 64" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="24" cy="5.5" r="2.5" />
            <path d="M24 8v4m-7 7c0-4 3-7 7-7s7 3 7 7m-14 0h14m-16 4c0-2 2-4 4-4h10c2 0 4 2 4 4m-18 0h18" />
            <path d="M17 23c1 5-1 8-3 13-2 5-2 11 1 17l-2 4h22l-2-4c3-6 3-12 1-17-2-5-4-8-3-13M19 28c2 3 2 7 0 10m10-10c-2 3-2 7 0 10M16 51h16M12 57h24v3H12zM18 63h12" />
            <path d="M21 17h.01M24 16h.01M27 17h.01" strokeWidth="2" />
          </svg>
          <span>NAMAK<br />KITCHEN<br />DEMO</span>
        </div>
      </div>
    </header>
    <div className="site-frame">
      <main id="main" tabIndex={-1}>{children}</main>
      <footer className="site-footer"><span>NAMAK KITCHEN</span><span>Synthetic menu for the food ordering assessment.</span><span>Prices and availability come from the API.</span></footer>
    </div>
    <div className="notice-region" aria-live="polite" aria-atomic="true">
      {notice && <div className="notice" role="status" key={notice.id}><span>{notice.text}</span><button type="button" onClick={dismissNotice} aria-label="Dismiss message">×</button></div>}
    </div>
  </>;
}

export function Docket({ compact = false }: { compact?: boolean }) {
  const { cart, session, error, pending, run, loadCart } = useStore();
  const count = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  const total = cart.estimatedTotalMinor ?? cart.totalMinor ?? 0;
  const unavailable = session === 'signed-in' && Boolean(error('cart'));
  return <aside className={`docket ${compact ? 'docket-compact' : ''} ${count === 0 || unavailable ? 'docket-empty-state' : ''}`} aria-label="Your order summary">
    <div className="docket-top"><h2>YOUR ORDER</h2><span className="status-stamp" key={session === 'checking' ? 'checking' : unavailable ? 'unavailable' : count}>{session === 'checking' ? 'CHECKING' : unavailable ? 'UNAVAILABLE' : `${String(count).padStart(2, '0')} ITEMS`}</span></div>
    {!unavailable && <div className="docket-column-head"><span>QTY</span><span>ITEM</span><span>PRICE</span></div>}
    <div className="docket-items">
      {session === 'checking' ? <p className="docket-empty" role="status">Checking your cart…</p> : session === 'guest' ? <div className="docket-empty"><strong>Start your ticket.</strong><p>Choose a dish and size, then sign in to add it.</p></div> : unavailable ? <div className="docket-empty" role="alert"><strong>Cart unavailable.</strong><p>{error('cart-retry') || error('cart')}</p><button type="button" className="button button-outline docket-retry" disabled={pending('cart-retry')} onClick={() => void run('cart-retry', loadCart)}>{pending('cart-retry') ? 'Trying again…' : 'Retry cart'}</button></div> : cart.items.length === 0 ? <div className="docket-empty"><strong>Nothing on this ticket yet.</strong><p>Choose a dish and size to begin.</p></div> : cart.items.map((item) => <div className="docket-item" key={item.variantId}><span className="docket-qty">{item.quantity}</span><span className="docket-name"><strong>{item.productName ?? item.name ?? 'Product'}</strong><small>{item.variantName ?? 'Variant'}</small></span><span className="docket-price">{money(item.lineTotalMinor)}</span></div>)}
    </div>
    <div className="docket-total"><span>Estimated total</span><strong>{unavailable ? 'Unavailable' : money(total)}</strong></div>
    <Link className="button button-red docket-action" href={session === 'guest' ? '/account' : '/cart'}>{session === 'guest' ? 'Sign in to order' : unavailable ? 'Open cart' : 'Review cart'} <span aria-hidden="true">→</span></Link>
    <div className="stage-guide" aria-label="Ordering stages"><div className="stage-rule"><i className="current"/><i/><i/></div><div className="stage-labels"><strong>Choose</strong><span>Review</span><span>Place</span></div><p>Next: {unavailable ? 'retry your cart' : 'review your cart'}</p></div>
    <div className="ticket-foot"><span>ORDER IN YOUR OWN TIME</span><span>COUNTER TICKET NO. 01</span></div>
  </aside>;
}
