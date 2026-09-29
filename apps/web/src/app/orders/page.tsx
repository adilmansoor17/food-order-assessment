'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useStore } from '@/context/store';
import { money, type Order } from '@/lib/api';

function displayStatus(value: string) { return value.replaceAll('_', ' '); }
function statusTone(value: string) { return value === 'paid' || value === 'ready' ? 'good' : value === 'failed' || value === 'cancelled' ? 'bad' : 'pending'; }
function paymentMethodLabel(order: Order) { return order.paymentType === 'demo' ? 'Demo payment — no money charged' : order.paymentType === 'cod' ? 'Cash on delivery' : 'Bank transfer'; }

function OrderDetail({ order }: { order: Order }) {
  const { config, fetchOrder, saveReference, pending, error } = useStore();
  const [reference, setReference] = useState(order.transferReference ?? '');
  useEffect(() => {
    if (order.fulfillmentStatus !== 'queued') return;
    let cancelled = false;
    let attempts = 0;
    let timer: number;
    const poll = async () => {
      if (cancelled) return;
      const updated = await fetchOrder(order.id);
      attempts += 1;
      if (!cancelled && updated?.fulfillmentStatus === 'queued' && attempts < 3) timer = window.setTimeout(() => void poll(), 2500 * 2 ** attempts);
    };
    timer = window.setTimeout(() => void poll(), 2500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [order.id, order.fulfillmentStatus, fetchOrder]);
  async function submitReference(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await saveReference(order.id, reference.trim()); }
  return <article className="paper-panel order-detail"><div className="section-heading"><h2>Order {order.id.slice(0, 8)}</h2><button type="button" className="button button-outline" disabled={pending(`order:${order.id}`)} onClick={() => void fetchOrder(order.id)}>{pending(`order:${order.id}`) ? 'Refreshing…' : 'Refresh status'}</button></div>
    {error(`order:${order.id}`) && <p className="inline-error" role="alert">{error(`order:${order.id}`)}</p>}
    <p className="order-date">Placed {new Date(order.createdAt).toLocaleString('en-PK')}</p>
    <dl className="status-grid"><div><dt>Order</dt><dd className={`status-pill ${statusTone(order.status)}`}>{displayStatus(order.status)}</dd></div><div><dt>{order.paymentType === 'demo' ? 'Demo payment' : 'Payment'}</dt><dd className={`status-pill ${statusTone(order.paymentStatus)}`}>{order.paymentType === 'demo' ? `${displayStatus(order.paymentStatus)} (simulated)` : displayStatus(order.paymentStatus)}</dd></div><div><dt>Fulfillment</dt><dd className={`status-pill ${statusTone(order.fulfillmentStatus)}`}>{displayStatus(order.fulfillmentStatus)}</dd></div></dl>
    {order.fulfillmentStatus === 'queued' && <p className="status-note" role="status">Your order is queued. {order.paymentType === 'demo' ? 'A simulated payment will be recorded after fulfillment; no money is charged.' : 'This page checks briefly for an update; you can also refresh it.'}</p>}
    {order.fulfillmentStatus === 'failed' && <p className="inline-error" role="alert">Preparation needs attention. {order.paymentType === 'demo' ? 'No simulated payment was completed.' : 'Contact the merchant before making a payment.'}</p>}
    <div className="receipt-lines"><h3>Items</h3>{order.items.map((item, index) => <div key={item.id ?? `${item.variantId}-${index}`} className="receipt-line"><span>{item.quantity} × {item.productName ?? item.name ?? 'Product'} <small>{item.variantName ?? 'Variant'}</small></span><strong>{money(item.lineTotalMinor)}</strong></div>)}</div>
    <div className="total-row"><span>Total</span><strong>{money(order.totalMinor)}</strong></div><p className="support-copy">Payment method: {paymentMethodLabel(order)}</p>
    {order.paymentType === 'bank_transfer' && order.paymentStatus === 'pending' && order.status !== 'cancelled' && <section className="bank-instructions"><h3>Bank transfer</h3>{config?.bankTransfer ? <dl><div><dt>Bank</dt><dd>{config.bankTransfer.bankName}</dd></div><div><dt>Account</dt><dd>{config.bankTransfer.accountName}</dd></div><div><dt>IBAN</dt><dd>{config.bankTransfer.iban}</dd></div></dl> : <p>Bank details are unavailable. Contact the merchant before transferring.</p>}<p>Use your order ID as the payment note. An admin verifies payment.</p><form onSubmit={(event) => void submitReference(event)} className="reference-form"><label htmlFor="transfer-reference">Transfer reference</label><div><input id="transfer-reference" name="reference" value={reference} onChange={(event) => setReference(event.target.value)} required maxLength={120} /><button className="button button-ink" disabled={pending(`reference:${order.id}`)}>{pending(`reference:${order.id}`) ? 'Saving…' : 'Save reference'}</button></div>{error(`reference:${order.id}`) && <p className="inline-error" role="alert">{error(`reference:${order.id}`)}</p>}</form></section>}
  </article>;
}

function OrdersContent() {
  const router = useRouter();
  const params = useSearchParams();
  const orderId = params.get('order');
  const { session, orders, ordersCursor, selectedOrder, setSelectedOrder, fetchOrder, loadOrders, pending, error, run } = useStore();
  useEffect(() => {
    if (session !== 'signed-in' || !orderId || selectedOrder?.id === orderId) return;
    const inList = orders.find((order) => order.id === orderId);
    if (inList) setSelectedOrder(inList);
    else void fetchOrder(orderId);
  }, [session, orderId, selectedOrder?.id, orders, setSelectedOrder, fetchOrder]);
  const current = orderId
    ? selectedOrder?.id === orderId ? selectedOrder : orders.find((order) => order.id === orderId) ?? null
    : selectedOrder ?? orders[0] ?? null;
  function select(order: Order) { setSelectedOrder(order); router.replace(`/orders?order=${encodeURIComponent(order.id)}`, { scroll: false }); }
  return <div className="interior-page"><div className="page-heading"><Link href="/" className="back-link">← Back to menu</Link><h1>Follow your order.</h1><p>Payment and fulfillment status come from the API.</p></div>
    {session === 'checking' && <div className="paper-panel state-copy" role="status">Checking your orders…</div>}
    {session === 'guest' && <div className="paper-panel empty-state"><h2>Sign in to see your orders.</h2><Link href="/account?return=%2Forders" className="button button-red">Sign in</Link></div>}
    {session === 'signed-in' && <div className="orders-layout"><section className="paper-panel order-list" aria-labelledby="order-list-heading"><div className="section-heading"><h2 id="order-list-heading">Your orders</h2><span className="ticket-small-label">MOST RECENT FIRST</span></div>{error('orders') && <div role="alert" className="load-error"><h3>Orders could not load.</h3><p>{error('orders-retry') || error('orders')}</p><button type="button" className="button button-outline" disabled={pending('orders-retry')} onClick={() => void run('orders-retry', () => loadOrders())}>{pending('orders-retry') ? 'Trying again…' : 'Retry loading orders'}</button></div>}{orders.length === 0 && !error('orders') && <div className="empty-state"><h3>No orders yet.</h3><p>Place your first order from the menu.</p><Link href="/" className="button button-red">Browse menu</Link></div>}{orders.map((order) => <button type="button" key={order.id} className={`order-row ${current?.id === order.id ? 'selected' : ''}`} onClick={() => select(order)}><strong>Order {order.id.slice(0, 8)}</strong><span>{new Date(order.createdAt).toLocaleString('en-PK')}</span><span>{money(order.totalMinor)} · {displayStatus(order.status)}</span></button>)}{ordersCursor && <button type="button" className="button button-outline load-more" disabled={pending('orders-more')} onClick={() => void run('orders-more', () => loadOrders(ordersCursor))}>{pending('orders-more') ? 'Loading…' : 'Load more orders'}</button>}</section>{current ? <OrderDetail key={`${current.id}:${current.transferReference ?? ''}`} order={current} /> : <div className="paper-panel empty-state">{orderId && pending(`order:${orderId}`) ? 'Loading order…' : orderId && error(`order:${orderId}`) ? <p role="alert" className="inline-error">{error(`order:${orderId}`)}</p> : error('orders') && orders.length === 0 ? <div className="order-detail-unavailable" role="alert"><h2>Order details unavailable.</h2><p>Reload your orders to choose one.</p><button type="button" className="button button-outline" disabled={pending('orders-retry')} onClick={() => void run('orders-retry', () => loadOrders())}>{pending('orders-retry') ? 'Trying again…' : 'Retry loading orders'}</button></div> : 'Choose an order to see its details.'}</div>}</div>}
  </div>;
}

export default function OrdersPage() { return <Suspense fallback={<div className="interior-page state-copy" role="status">Loading orders…</div>}><OrdersContent /></Suspense>; }
