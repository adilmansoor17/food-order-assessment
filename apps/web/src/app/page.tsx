'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Docket } from '@/components/Shell';
import { useStore } from '@/context/store';
import { money, type Product } from '@/lib/api';

const featured: Record<string, { image: string; category: string; order: number }> = {
  'chicken tikka roll': { image: '/menu/chicken-tikka-roll.jpg', category: 'Rolls', order: 0 },
  'chapli kebab bun': { image: '/menu/chapli-kebab-bun.jpg', category: 'Burgers', order: 1 },
  'chicken biryani bowl': { image: '/menu/chicken-biryani-bowl.jpg', category: 'Bowls', order: 2 },
  'beef seekh roll': { image: '/menu/beef-seekh-roll.jpg', category: 'Rolls', order: 999 },
  'daal chawal bowl': { image: '/menu/daal-chawal-bowl.jpg', category: 'Bowls', order: 999 },
  'masala fries': { image: '/menu/masala-fries.jpg', category: 'Other', order: 999 },
  'mint lemonade': { image: '/menu/mint-lemonade.jpg', category: 'Drinks', order: 999 },
  'gulab jamun': { image: '/menu/gulab-jamun.jpg', category: 'Other', order: 999 },
};
const filters = ['All', 'Rolls', 'Burgers', 'Bowls', 'Drinks', 'Other'];
function categoryOf(name: string) {
  const value = name.toLowerCase();
  if (featured[value]) return featured[value].category;
  if (/roll|wrap/.test(value)) return 'Rolls';
  if (/burger|bun|kebab/.test(value)) return 'Burgers';
  if (/bowl|biryani|rice/.test(value)) return 'Bowls';
  if (/drink|lassi|tea|soda|juice/.test(value)) return 'Drinks';
  return 'Other';
}
function ProductTicket({ product, number }: { product: Product; number: number }) {
  const router = useRouter();
  const { cart, session, changeQuantity, pending, error } = useStore();
  const art = featured[product.name.toLowerCase()];
  const variants = art ? [...product.variants].sort((a, b) => a.priceMinor - b.priceMinor || a.name.localeCompare(b.name)) : product.variants;
  const [selectedId, setSelectedId] = useState(variants.find((variant) => variant.available !== false)?.id ?? variants[0]?.id ?? '');
  const [imageFailed, setImageFailed] = useState(false);
  const selected = variants.find((variant) => variant.id === selectedId) ?? variants[0];
  const stockCount = selected ? cart.items.find((item) => item.variantId === selected.id)?.quantity ?? 0 : 0;
  const working = selected ? pending(`cart:${selected.id}`) : false;
  async function add() {
    if (session !== 'signed-in') { router.push('/account?return=%2F'); return; }
    if (selected && stockCount < 99) await changeQuantity(selected.id, stockCount + 1);
  }
  return <article className="menu-ticket">
    <div className={`ticket-visual ${art && !imageFailed ? 'has-photo' : 'no-photo'}`}>
      {art && !imageFailed ? <Image src={art.image} alt={product.name} fill sizes="(max-width: 700px) 100vw, (max-width: 1100px) 45vw, 26vw" loading={number === 1 ? 'eager' : 'lazy'} fetchPriority={number === 1 ? 'high' : undefined} unoptimized onError={() => setImageFailed(true)} /> : <div className="ticket-visual-fallback"><span>COUNTER TICKET</span><strong>{product.name}</strong><small>MENU ITEM {String(number).padStart(3, '0')}</small></div>}
    </div>
    <div className="ticket-content">
      <div className="ticket-register"><span>#{String(number).padStart(3, '0')}</span><span>{categoryOf(product.name).toUpperCase()}</span></div>
      <h2>{product.name}</h2>
      <p className="ticket-description">{product.description || 'Choose an available variant below.'}</p>
      <fieldset className="variant-list" disabled={working}>
        <legend className="sr-only">Choose a variant for {product.name}</legend>
        {variants.map((variant) => <label key={variant.id} className={`variant-option ${variant.available === false ? 'unavailable' : ''}`}>
          <input type="radio" name={`variant-${product.id}`} value={variant.id} checked={selected?.id === variant.id} onChange={() => setSelectedId(variant.id)} disabled={variant.available === false} />
          <span>{variant.name}{variant.available === false && <small>Unavailable</small>}</span>
          <strong>{money(variant.priceMinor)}</strong>
        </label>)}
      </fieldset>
      {selected && error(`cart:${selected.id}`) && <p className="inline-error" role="alert">{error(`cart:${selected.id}`)}</p>}
      <button type="button" className="button button-red ticket-add" onClick={() => void add()} disabled={!selected || selected.available === false || stockCount >= 99 || working || session === 'checking'}>{working ? 'Adding…' : selected?.available === false ? 'Unavailable' : stockCount >= 99 ? 'Maximum in cart' : 'Add to cart'}</button>
    </div>
    <div className="ticket-foot"><span>NAMAK KITCHEN</span><span>ASSESSMENT DEMO</span></div>
  </article>;
}

export default function MenuPage() {
  const { products, productsCursor, productsLoading, productsError, loadProducts, session, cart } = useStore();
  const [filter, setFilter] = useState('All');
  const [query, setQuery] = useState('');
  const sorted = useMemo(() => products.map((product, index) => ({ product, index })).sort((a, b) => {
    const aRank = featured[a.product.name.toLowerCase()]?.order ?? 999;
    const bRank = featured[b.product.name.toLowerCase()]?.order ?? 999;
    return aRank - bRank || a.index - b.index;
  }).map(({ product }) => product), [products]);
  const shown = sorted.filter((product) => (filter === 'All' || categoryOf(product.name) === filter) && `${product.name} ${product.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const visibleFilters = filters.filter((value) => value === 'All' || products.some((product) => categoryOf(product.name) === value));
  return <div className="menu-page">
    <div className="menu-intro"><h1>Make it yours.</h1><p>Choose a dish and a size.</p></div>
    <div className="menu-layout">
      <section className="menu-main" aria-label="Menu">
        <div className="menu-controls"><div className="category-tabs" role="group" aria-label="Filter menu by category">{visibleFilters.map((value) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{value}</button>)}</div><label className="search-field"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg><span className="sr-only">Search menu</span><input type="search" placeholder="Search for a dish…" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
        {productsError && <div className="feedback-panel" role="alert"><strong>Menu could not load.</strong><p>{productsError}</p><button className="button button-ink" type="button" onClick={() => void loadProducts()}>Try again</button></div>}
        {productsLoading && products.length === 0 && <div className="ticket-grid" role="status" aria-label="Loading menu">{[1, 2, 3].map((number) => <div className="menu-ticket ticket-skeleton" key={number}><div/><span/><span/><span/></div>)}</div>}
        {!productsLoading && !productsError && products.length === 0 && <div className="feedback-panel"><strong>No dishes are available yet.</strong><p>Check back after the menu is updated.</p></div>}
        {products.length > 0 && shown.length === 0 && <div className="feedback-panel"><strong>No matching dishes.</strong><p>Try a different search or category.</p><button className="text-link" type="button" onClick={() => { setFilter('All'); setQuery(''); }}>Show all dishes</button></div>}
        {shown.length > 0 && <div className="ticket-grid">{shown.map((product) => <ProductTicket key={product.id} product={product} number={sorted.indexOf(product) + 1} />)}</div>}
        {productsCursor && <button type="button" className="button button-outline load-more" disabled={productsLoading} onClick={() => void loadProducts(productsCursor)}>{productsLoading ? 'Loading more…' : 'Load more dishes'}</button>}
      </section>
      <Docket />
    </div>
    <Link className="mobile-cart-link" href={session === 'guest' ? '/account' : '/cart'}>{session === 'checking' ? 'Checking your cart…' : session === 'guest' ? 'Sign in to order' : `Review your cart (${cart.items.reduce((sum, item) => sum + item.quantity, 0)})`} <span aria-hidden="true">→</span></Link>
  </div>;
}
