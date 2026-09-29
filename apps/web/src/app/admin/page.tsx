'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useStore } from '@/context/store';
import { api, money, type Order, type Product } from '@/lib/api';

type Page<T> = { items: T[]; nextCursor: string | null };
function appendUnique<T extends { id: string }>(current: T[], incoming: T[]) {
  const ids = new Set(current.map((value) => value.id));
  return [...current, ...incoming.filter((value) => !ids.has(value.id))];
}
function message(reason: unknown) { return reason instanceof Error ? reason.message : 'Could not load admin data.'; }

export default function AdminPage() {
  const { session, user, run, pending, error, loadProducts, loadOrders, selectedOrder, fetchOrder } = useStore();
  const [products, setProducts] = useState<Product[]>([]);
  const [productsCursor, setProductsCursor] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersCursor, setOrdersCursor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const loadAdminProducts = useCallback(async (cursor?: string) => {
    const page = await api<Page<Product>>(`/admin/products${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    setProducts((current) => cursor ? appendUnique(current, page.items) : page.items);
    setProductsCursor(page.nextCursor);
  }, []);
  const loadAdminOrders = useCallback(async (cursor?: string) => {
    const page = await api<Page<Order>>(`/admin/orders${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    setOrders((current) => cursor ? appendUnique(current, page.items) : page.items);
    setOrdersCursor(page.nextCursor);
  }, []);
  useEffect(() => {
    if (session !== 'signed-in' || user?.role !== 'admin') return;
    let live = true;
    async function start() {
      const result = await Promise.allSettled([api<Page<Product>>('/admin/products'), api<Page<Order>>('/admin/orders')]);
      if (!live) return;
      if (result[0].status === 'fulfilled') { setProducts(result[0].value.items); setProductsCursor(result[0].value.nextCursor); }
      if (result[1].status === 'fulfilled') { setOrders(result[1].value.items); setOrdersCursor(result[1].value.nextCursor); }
      const failures = result.filter((entry) => entry.status === 'rejected');
      if (failures.length) setLoadError(failures.map((entry) => message(entry.reason)).join(' '));
      setLoading(false);
    }
    void start();
    return () => { live = false; };
  }, [session, user?.role]);

  async function refreshProduct(id: string) {
    const updated = await api<Product>(`/admin/products/${id}`);
    setEditing(updated);
    setProducts((current) => current.map((product) => product.id === id ? updated : product));
    await loadProducts();
  }
  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await run('admin-create', async () => {
      await api('/admin/products', { method: 'POST', body: JSON.stringify({ name: data.get('name'), description: data.get('description'), variants: [{ name: data.get('variantName'), sku: data.get('sku'), priceMinor: Number(data.get('priceMinor')), initialStock: Number(data.get('initialStock')) }] }) });
      form.reset();
      await Promise.all([loadAdminProducts(), loadProducts()]);
    }, 'Product created.');
  }
  async function updateProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const data = new FormData(event.currentTarget);
    await run(`admin-product:${editing.id}`, async () => {
      await api(`/admin/products/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ name: data.get('name'), description: data.get('description'), active: data.get('active') === 'on' }) });
      await refreshProduct(editing.id);
    }, 'Product updated.');
  }
  async function archiveProduct(product: Product) {
    if (!window.confirm(`Archive ${product.name}? It will disappear from the menu.`)) return;
    await run(`admin-archive:${product.id}`, async () => {
      await api(`/admin/products/${product.id}`, { method: 'DELETE' });
      if (editing?.id === product.id) setEditing(null);
      await Promise.all([loadAdminProducts(), loadProducts()]);
    }, 'Product archived.');
  }
  async function addVariant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const id = editing.id;
    await run(`admin-variant-add:${id}`, async () => {
      await api(`/admin/products/${id}/variants`, { method: 'POST', body: JSON.stringify({ name: data.get('name'), sku: data.get('sku'), priceMinor: Number(data.get('priceMinor')), initialStock: Number(data.get('initialStock')) }) });
      form.reset(); await refreshProduct(id);
    }, 'Variant added.');
  }
  async function updateVariant(event: FormEvent<HTMLFormElement>, variantId: string) {
    event.preventDefault(); if (!editing) return;
    const data = new FormData(event.currentTarget);
    const id = editing.id;
    await run(`admin-variant:${variantId}`, async () => {
      await api(`/admin/variants/${variantId}`, { method: 'PATCH', body: JSON.stringify({ name: data.get('name'), sku: data.get('sku'), priceMinor: Number(data.get('priceMinor')), active: data.get('active') === 'on' }) });
      await refreshProduct(id);
    }, 'Variant updated.');
  }
  async function archiveVariant(variantId: string, variantName: string) {
    if (!editing || !window.confirm(`Archive ${variantName}? It will disappear from the menu.`)) return;
    const id = editing.id;
    await run(`admin-variant-archive:${variantId}`, async () => {
      await api(`/admin/variants/${variantId}`, { method: 'DELETE' });
      await refreshProduct(id);
    }, 'Variant archived.');
  }
  async function adjustStock(event: FormEvent<HTMLFormElement>, variantId: string) {
    event.preventDefault(); if (!editing) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const id = editing.id;
    await run(`admin-stock:${variantId}`, async () => {
      await api(`/admin/variants/${variantId}/stock-adjustments`, { method: 'POST', body: JSON.stringify({ delta: Number(data.get('delta')), reason: data.get('reason') }) });
      form.reset(); await refreshProduct(id);
    }, 'Stock adjusted.');
  }
  async function actOnOrder(order: Order, command: 'mark-paid' | 'cancel') {
    if (command === 'cancel' && !window.confirm(`Cancel order ${order.id.slice(0, 8)} and restore stock?`)) return;
    await run(`admin-order:${order.id}`, async () => {
      await api(`/admin/orders/${order.id}/${command}`, { method: 'POST' });
      await loadAdminOrders();
      await loadOrders();
      if (selectedOrder?.id === order.id) await fetchOrder(order.id);
    }, command === 'mark-paid' ? 'Payment recorded.' : 'Order cancelled and stock restored.');
  }

  return <div className="interior-page admin-page"><div className="page-heading"><Link href="/" className="back-link">← Back to menu</Link><h1>Manage the counter.</h1><p>Catalog, stock, and order actions are checked by the API.</p></div>
    {session === 'checking' && <div className="paper-panel state-copy" role="status">Checking admin access…</div>}
    {session === 'guest' && <div className="paper-panel empty-state"><h2>Admin sign in required.</h2><Link className="button button-red" href="/account?return=%2Fadmin">Sign in</Link></div>}
    {session === 'signed-in' && user?.role !== 'admin' && <div className="paper-panel empty-state" role="alert"><h2>Admin access required.</h2><p>This account cannot manage the counter.</p><Link className="button button-outline" href="/">Return to menu</Link></div>}
    {session === 'signed-in' && user?.role === 'admin' && <div className="admin-layout"><div className="admin-column"><section className="paper-panel admin-section" aria-labelledby="create-heading"><div className="section-heading"><h2 id="create-heading">Add a product</h2><span className="ticket-small-label">CATALOG</span></div><form onSubmit={(event) => void createProduct(event)} className="admin-form"><label>Product name<input name="name" required /></label><label>Description<textarea name="description" rows={2} /></label><div className="form-pair"><label>First variant name<input name="variantName" required /></label><label>SKU<input name="sku" required /></label></div><div className="form-pair"><label>Price in paisa<input name="priceMinor" type="number" min="1" step="1" required /></label><label>Initial stock<input name="initialStock" type="number" min="0" step="1" required /></label></div>{error('admin-create') && <p className="inline-error" role="alert">{error('admin-create')}</p>}<button className="button button-red" disabled={pending('admin-create')}>{pending('admin-create') ? 'Creating…' : 'Create product'}</button></form></section>
      <section className="paper-panel admin-section" aria-labelledby="products-heading"><div className="section-heading"><h2 id="products-heading">Manage products</h2><span className="ticket-small-label">{products.length} LOADED</span></div>{loading && <p role="status">Loading products…</p>}{loadError && <p className="inline-error" role="alert">{loadError}</p>}{!loading && products.length === 0 && <p className="state-copy">No products to manage.</p>}{products.map((product) => <article className="admin-product-row" key={product.id} aria-label={`Product ${product.name}`}><div><h3>{product.name}</h3><p>{product.archivedAt ? 'Archived' : product.active ? 'Active' : 'Inactive'} · {product.variants.length} variants</p></div><div className="row-actions"><button type="button" className="button button-outline" disabled={Boolean(product.archivedAt)} onClick={() => setEditing(product)}>Edit</button><button type="button" className="button button-outline danger-outline" disabled={Boolean(product.archivedAt) || pending(`admin-archive:${product.id}`)} onClick={() => void archiveProduct(product)}>{pending(`admin-archive:${product.id}`) ? 'Archiving…' : 'Archive'}</button></div>{error(`admin-archive:${product.id}`) && <p className="inline-error" role="alert">{error(`admin-archive:${product.id}`)}</p>}</article>)}{productsCursor && <button type="button" className="button button-outline load-more" disabled={pending('admin-products-more')} onClick={() => void run('admin-products-more', () => loadAdminProducts(productsCursor))}>{pending('admin-products-more') ? 'Loading…' : 'Load more products'}</button>}{error('admin-products-more') && <p className="inline-error" role="alert">{error('admin-products-more')}</p>}</section>
      {editing && <section className="paper-panel admin-section editor-section" aria-label={`Edit ${editing.name}`}><div className="section-heading"><h2>Edit {editing.name}</h2><button type="button" className="text-link" onClick={() => setEditing(null)}>Close editor</button></div><form key={`${editing.id}:${editing.name}:${editing.description}:${editing.active}`} onSubmit={(event) => void updateProduct(event)} className="admin-form"><label>Product name<input name="name" defaultValue={editing.name} required /></label><label>Description<textarea name="description" defaultValue={editing.description} rows={2} /></label><label className="checkbox-label"><input type="checkbox" name="active" defaultChecked={editing.active} />Available on menu</label>{error(`admin-product:${editing.id}`) && <p className="inline-error" role="alert">{error(`admin-product:${editing.id}`)}</p>}<button className="button button-red" disabled={pending(`admin-product:${editing.id}`)}>{pending(`admin-product:${editing.id}`) ? 'Saving…' : 'Save product'}</button></form><h3 className="editor-subheading">Variants</h3>{editing.variants.map((variant) => <section className="variant-editor" aria-label={`Variant ${variant.sku ?? variant.name}`} key={variant.id}><div className="section-heading"><h4>{variant.name}</h4><span className="ticket-small-label">STOCK {variant.stock ?? 0}</span></div><form key={`${variant.id}:${variant.name}:${variant.priceMinor}:${variant.active}`} onSubmit={(event) => void updateVariant(event, variant.id)} className="admin-form"><div className="form-pair"><label>Variant name<input name="name" defaultValue={variant.name} required /></label><label>SKU<input name="sku" defaultValue={variant.sku ?? ''} required /></label></div><label>Price in paisa<input name="priceMinor" type="number" min="1" step="1" defaultValue={variant.priceMinor} required /></label><label className="checkbox-label"><input type="checkbox" name="active" defaultChecked={variant.active} />Available on menu</label>{error(`admin-variant:${variant.id}`) && <p className="inline-error" role="alert">{error(`admin-variant:${variant.id}`)}</p>}<div className="row-actions"><button className="button button-ink" disabled={pending(`admin-variant:${variant.id}`)}>{pending(`admin-variant:${variant.id}`) ? 'Saving…' : 'Save variant'}</button><button type="button" className="button button-outline danger-outline" disabled={!variant.active || pending(`admin-variant-archive:${variant.id}`)} onClick={() => void archiveVariant(variant.id, variant.name)}>Archive variant</button></div>{error(`admin-variant-archive:${variant.id}`) && <p className="inline-error" role="alert">{error(`admin-variant-archive:${variant.id}`)}</p>}</form><form onSubmit={(event) => void adjustStock(event, variant.id)} className="admin-form stock-form"><h5>Adjust stock</h5><div className="form-pair"><label>Stock change<input name="delta" type="number" step="1" placeholder="+ or −" required /></label><label>Reason for adjustment<input name="reason" required /></label></div>{error(`admin-stock:${variant.id}`) && <p className="inline-error" role="alert">{error(`admin-stock:${variant.id}`)}</p>}<button className="button button-outline" disabled={pending(`admin-stock:${variant.id}`)}>{pending(`admin-stock:${variant.id}`) ? 'Adjusting…' : 'Adjust stock'}</button></form></section>)}<form onSubmit={(event) => void addVariant(event)} className="admin-form add-variant"><h3>Add a variant</h3><div className="form-pair"><label>Variant name<input name="name" required /></label><label>SKU<input name="sku" required /></label></div><div className="form-pair"><label>Price in paisa<input name="priceMinor" type="number" min="1" step="1" required /></label><label>Initial stock<input name="initialStock" type="number" min="0" step="1" required /></label></div>{error(`admin-variant-add:${editing.id}`) && <p className="inline-error" role="alert">{error(`admin-variant-add:${editing.id}`)}</p>}<button className="button button-red" disabled={pending(`admin-variant-add:${editing.id}`)}>{pending(`admin-variant-add:${editing.id}`) ? 'Adding…' : 'Add variant'}</button></form></section>}</div>
      <section className="paper-panel admin-section admin-orders" aria-labelledby="admin-orders-heading"><div className="section-heading"><h2 id="admin-orders-heading">Admin orders</h2><span className="ticket-small-label">{orders.length} LOADED</span></div>{loading && <p role="status">Loading orders…</p>}{!loading && orders.length === 0 && <p className="state-copy">No orders to manage.</p>}{orders.map((order) => <article className="admin-order-row" key={order.id} aria-label={`Order ${order.id.slice(0, 8)}`}><h3>Order {order.id.slice(0, 8)}</h3><p>{money(order.totalMinor)} · {order.paymentType === 'demo' ? 'Demo payment (no charge)' : order.paymentType === 'cod' ? 'Cash on delivery' : 'Bank transfer'}</p><p>Order: {order.status} · Payment: {order.paymentStatus} · Fulfillment: {order.fulfillmentStatus}</p>{order.transferReference && <p>Reference: {order.transferReference}</p>}<div className="row-actions">{order.paymentType !== 'demo' && order.paymentStatus === 'pending' && order.status !== 'cancelled' && order.fulfillmentStatus === 'ready' && <button type="button" className="button button-red" disabled={pending(`admin-order:${order.id}`)} onClick={() => void actOnOrder(order, 'mark-paid')}>Record payment</button>}{order.status !== 'cancelled' && order.paymentStatus !== 'paid' && <button type="button" className="button button-outline danger-outline" disabled={pending(`admin-order:${order.id}`)} onClick={() => void actOnOrder(order, 'cancel')}>Cancel / restock</button>}</div>{error(`admin-order:${order.id}`) && <p className="inline-error" role="alert">{error(`admin-order:${order.id}`)}</p>}</article>)}{ordersCursor && <button type="button" className="button button-outline load-more" disabled={pending('admin-orders-more')} onClick={() => void run('admin-orders-more', () => loadAdminOrders(ordersCursor))}>{pending('admin-orders-more') ? 'Loading…' : 'Load more orders'}</button>}{error('admin-orders-more') && <p className="inline-error" role="alert">{error('admin-orders-more')}</p>}</section></div>}
  </div>;
}
