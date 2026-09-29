'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useStore } from '@/context/store';
import { money } from '@/lib/api';

export default function CartPage() {
  const router = useRouter();
  const { session, cart, config, configLoading, changeQuantity, checkout, pending, error, loadCart, run } = useStore();
  const [paymentType, setPaymentType] = useState<'cod' | 'bank_transfer' | 'demo' | null>(null);
  const selectedPaymentType = paymentType ?? (config?.demoPaymentsEnabled ? 'demo' : 'cod');
  const count = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  const blocked = cart.items.some((item) => item.available === false);
  const total = cart.estimatedTotalMinor ?? cart.totalMinor ?? 0;
  async function place(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const order = await checkout(selectedPaymentType);
    if (order) router.push(`/orders?order=${encodeURIComponent(order.id)}`);
  }
  return <div className="interior-page">
    <div className="page-heading"><Link href="/" className="back-link">← Back to menu</Link><h1>Review your cart.</h1><p>Check your choices before placing the order.</p></div>
    <div className="cart-layout"><section className="paper-panel cart-lines" aria-labelledby="cart-title"><div className="section-heading"><h2 id="cart-title">Your items</h2><span className="status-stamp">{String(count).padStart(2, '0')} ITEMS</span></div>
      {session === 'checking' && <p className="state-copy" role="status">Checking your cart…</p>}
      {session === 'guest' && <div className="empty-state"><h3>Sign in to start an order.</h3><p>Your cart is tied to your account.</p><Link href="/account?return=%2Fcart" className="button button-red">Sign in</Link></div>}
      {session === 'signed-in' && error('cart') && <div role="alert" className="load-error"><h3>Cart could not load.</h3><p>{error('cart-retry') || error('cart')}</p><button type="button" className="button button-outline" disabled={pending('cart-retry')} onClick={() => void run('cart-retry', loadCart)}>{pending('cart-retry') ? 'Trying again…' : 'Retry loading cart'}</button></div>}
      {session === 'signed-in' && cart.items.length === 0 && !error('cart') && <div className="empty-state"><h3>Your cart is empty.</h3><p>Choose a dish and size from the menu.</p><Link href="/" className="button button-red">Browse menu</Link></div>}
      {session === 'signed-in' && cart.items.length > 0 && <div className="cart-item-list">{cart.items.map((item, index) => <article key={item.variantId} className="cart-line"><div className="cart-line-index">{String(index + 1).padStart(2, '0')}</div><div className="cart-line-name"><h3>{item.productName ?? item.name ?? 'Product'}</h3><p>{item.variantName ?? 'Variant'} · {money(item.unitPriceMinor)} each</p>{item.available === false && <p className="inline-error" role="alert">Unavailable now. Remove this item before checkout.</p>}{error(`cart:${item.variantId}`) && <p className="inline-error" role="alert">{error(`cart:${item.variantId}`)}</p>}</div><div className="cart-line-controls"><div className="quantity-control"><button type="button" aria-label={`Decrease ${item.productName ?? item.name ?? 'item'} quantity`} disabled={pending(`cart:${item.variantId}`) || pending('checkout')} onClick={() => void changeQuantity(item.variantId, item.quantity - 1)}>−</button><span aria-label={`Quantity ${item.quantity}`}>{pending(`cart:${item.variantId}`) ? '…' : item.quantity}</span><button type="button" aria-label={`Increase ${item.productName ?? item.name ?? 'item'} quantity`} disabled={pending(`cart:${item.variantId}`) || pending('checkout') || item.quantity >= 99 || item.available === false} onClick={() => void changeQuantity(item.variantId, item.quantity + 1)}>+</button></div><button type="button" className="text-link remove-link" disabled={pending(`cart:${item.variantId}`) || pending('checkout')} onClick={() => void changeQuantity(item.variantId, 0)}>Remove</button></div><strong className="cart-line-total">{money(item.lineTotalMinor)}</strong></article>)}</div>}
    </section><form onSubmit={(event) => void place(event)} className="paper-panel checkout-panel"><div className="section-heading"><h2>Place your order</h2><span className="ticket-small-label">STEP 02 / 03</span></div><div className="total-row"><span>Estimated total</span><strong>{money(total)}</strong></div><p className="support-copy">The API confirms price and stock when you place the order. {selectedPaymentType === 'demo' ? 'A simulated payment is recorded after fulfillment; no money is charged.' : 'Payment remains pending until recorded.'}</p>{configLoading ? <p className="support-copy" role="status">Checking payment options…</p> : <fieldset className="payment-options"><legend>Payment method</legend>{config?.demoPaymentsEnabled && <label><input type="radio" name="paymentType" checked={selectedPaymentType === 'demo'} onChange={() => setPaymentType('demo')} />Demo payment — no money charged</label>}<label><input type="radio" name="paymentType" checked={selectedPaymentType === 'cod'} onChange={() => setPaymentType('cod')} />Cash on delivery</label>{config?.bankTransfer && <label><input type="radio" name="paymentType" checked={selectedPaymentType === 'bank_transfer'} onChange={() => setPaymentType('bank_transfer')} />Bank transfer</label>}</fieldset>}{selectedPaymentType === 'bank_transfer' && <p className="support-copy">Transfer instructions appear after your order is placed.</p>}{error('checkout') && <p className="inline-error" role="alert">{error('checkout')}</p>}<button type="submit" className="button button-red checkout-button" disabled={session !== 'signed-in' || cart.items.length === 0 || blocked || configLoading || pending('checkout')}>{pending('checkout') ? 'Placing order…' : 'Place order'}</button><p className="checkout-stage">Choose <span>→</span> Review <span>→</span> Place</p></form></div>
  </div>;
}
