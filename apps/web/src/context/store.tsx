'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, getAuthEpoch, onSessionCleared, refresh, setAccessToken, type ApiError, type Cart, type CheckoutConfig, type Order, type Product, type User } from '@/lib/api';

type Page<T> = { items: T[]; nextCursor: string | null };
type Session = 'checking' | 'guest' | 'signed-in';
type Notice = { id: number; text: string } | null;
type AuthResult = { user: User; accessToken: string };
type CheckoutMethod = Order['paymentType'];

const emptyCart: Cart = { version: 0, items: [], estimatedTotalMinor: 0, currency: 'PKR' };
const conflict = (error: unknown) => [409, 412].includes(Number((error as ApiError)?.status));
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed. Please try again.';
function appendUnique<T extends { id: string }>(current: T[], incoming: T[]) {
  const ids = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !ids.has(item.id))];
}

export type Store = {
  session: Session;
  user: User | null;
  products: Product[];
  productsCursor: string | null;
  productsLoading: boolean;
  productsError: string;
  config: CheckoutConfig | null;
  configLoading: boolean;
  cart: Cart;
  orders: Order[];
  ordersCursor: string | null;
  selectedOrder: Order | null;
  setSelectedOrder: (order: Order | null) => void;
  notice: Notice;
  dismissNotice: () => void;
  pending: (key: string) => boolean;
  error: (key: string) => string;
  clearError: (key: string) => void;
  notify: (text: string) => void;
  run: <T>(key: string, task: () => Promise<T>, success?: string) => Promise<T | undefined>;
  loadProducts: (cursor?: string) => Promise<void>;
  loadCart: () => Promise<void>;
  loadOrders: (cursor?: string) => Promise<void>;
  fetchOrder: (id: string) => Promise<Order | undefined>;
  changeQuantity: (variantId: string, quantity: number) => Promise<void>;
  checkout: (method: CheckoutMethod) => Promise<Order | undefined>;
  saveReference: (id: string, reference: string) => Promise<void>;
  login: (identifier: string, password: string) => Promise<boolean>;
  register: (name: string, email: string, phone: string, password: string) => Promise<boolean>;
  requestOtp: (identifier: string, channel: 'email' | 'phone') => Promise<string | undefined>;
  verifyOtp: (challengeId: string, code: string) => Promise<boolean>;
  logout: () => Promise<boolean>;
};

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>('checking');
  const [user, setUser] = useState<User | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsCursor, setProductsCursor] = useState<string | null>(null);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState('');
  const [config, setConfig] = useState<CheckoutConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [cart, setCart] = useState<Cart>(emptyCart);
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersCursor, setOrdersCursor] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [pendingKeys, setPendingKeys] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const noticeTimer = useRef<number | null>(null);
  const noticeNumber = useRef(0);
  const cartRef = useRef(cart);
  cartRef.current = cart;

  const notify = useCallback((value: string) => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice({ id: ++noticeNumber.current, text: value });
    noticeTimer.current = window.setTimeout(() => { setNotice(null); noticeTimer.current = null; }, 5000);
  }, []);
  const dismissNotice = useCallback(() => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNotice(null);
  }, []);
  useEffect(() => () => { if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current); }, []);
  const pending = (key: string) => Boolean(pendingKeys[key]);
  const error = (key: string) => errors[key] ?? '';
  const clearError = (key: string) => setErrors((current) => ({ ...current, [key]: '' }));

  const run = useCallback(async <T,>(key: string, task: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setPendingKeys((current) => ({ ...current, [key]: true }));
    setErrors((current) => ({ ...current, [key]: '' }));
    try {
      const result = await task();
      if (success) notify(success);
      return result;
    } catch (reason) {
      setErrors((current) => ({ ...current, [key]: errorText(reason) }));
      return undefined;
    } finally {
      setPendingKeys((current) => ({ ...current, [key]: false }));
    }
  }, [notify]);

  const loadProducts = useCallback(async (cursor?: string) => {
    setProductsLoading(true);
    setProductsError('');
    try {
      const page = await api<Page<Product>>(`/products${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      setProducts((current) => cursor ? appendUnique(current, page.items) : page.items);
      setProductsCursor(page.nextCursor);
    } catch (reason) { setProductsError(errorText(reason)); }
    finally { setProductsLoading(false); }
  }, []);
  const loadCart = useCallback(async () => {
    const updated = await api<Cart>('/cart');
    setCart(updated);
    setErrors((current) => ({ ...current, cart: '', 'cart-retry': '' }));
  }, []);
  const loadOrders = useCallback(async (cursor?: string) => {
    const page = await api<Page<Order>>(`/orders${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    setOrders((current) => cursor ? appendUnique(current, page.items) : page.items);
    setOrdersCursor(page.nextCursor);
    setErrors((current) => ({ ...current, orders: '', 'orders-retry': '' }));
  }, []);

  useEffect(() => onSessionCleared(() => {
    setUser(null);
    setSession('guest');
    setCart(emptyCart);
    setOrders([]);
    setOrdersCursor(null);
    setSelectedOrder(null);
    setErrors({});
    sessionStorage.removeItem('checkout-attempt');
  }), []);

  useEffect(() => {
    let live = true;
    async function boot() {
      const [catalog, checkoutConfig, renewed] = await Promise.allSettled([
        api<Page<Product>>('/products'), api<CheckoutConfig>('/config/checkout'), refresh(),
      ]);
      if (!live) return;
      if (catalog.status === 'fulfilled') {
        setProducts(catalog.value.items);
        setProductsCursor(catalog.value.nextCursor);
      } else setProductsError(errorText(catalog.reason));
      setProductsLoading(false);
      if (checkoutConfig.status === 'fulfilled') setConfig(checkoutConfig.value);
      setConfigLoading(false);
      if (renewed.status === 'fulfilled' && renewed.value) {
        const epoch = getAuthEpoch();
        try {
          const account = await api<User>('/me');
          if (!live || epoch !== getAuthEpoch()) return;
          setUser(account);
          const [cartResult, orderResult] = await Promise.allSettled([api<Cart>('/cart'), api<Page<Order>>('/orders')]);
          if (!live || epoch !== getAuthEpoch()) return;
          if (cartResult.status === 'fulfilled') {
            setCart(cartResult.value);
            setErrors((current) => ({ ...current, cart: '' }));
          }
          else setErrors((current) => ({ ...current, cart: errorText(cartResult.reason) }));
          if (orderResult.status === 'fulfilled') {
            setOrders(orderResult.value.items);
            setOrdersCursor(orderResult.value.nextCursor);
            setErrors((current) => ({ ...current, orders: '' }));
          } else setErrors((current) => ({ ...current, orders: errorText(orderResult.reason) }));
          setSession('signed-in');
        } catch {
          if (live) { setAccessToken(null); setSession('guest'); }
        }
      } else setSession('guest');
    }
    void boot();
    return () => { live = false; };
  }, []);

  const fetchOrder = useCallback(async (id: string) => run(`order:${id}`, async () => {
    const latest = await api<Order>(`/orders/${id}`);
    setSelectedOrder(latest);
    setOrders((current) => current.map((order) => order.id === latest.id ? latest : order));
    return latest;
  }), [run]);

  const changeQuantity = useCallback(async (variantId: string, quantity: number) => {
    const key = `cart:${variantId}`;
    await run(key, async () => {
      try {
        const current = cartRef.current;
        const updated = await api<Cart>(`/cart/items/${variantId}`, {
          method: quantity <= 0 ? 'DELETE' : 'PUT',
          headers: { 'If-Match': String(current.version) },
          ...(quantity > 0 ? { body: JSON.stringify({ quantity }) } : {}),
        });
        setCart(updated);
      } catch (reason) {
        if (conflict(reason)) {
          try { await loadCart(); } catch { /* keep the original conflict actionable */ }
          throw new Error('Your cart or stock changed. Review the updated cart, then try again.');
        }
        throw reason;
      }
    }, quantity <= 0 ? 'Item removed from your cart.' : 'Cart updated.');
  }, [loadCart, run]);

  const checkout = useCallback(async (method: CheckoutMethod) => run('checkout', async () => {
    const current = cartRef.current;
    const total = current.estimatedTotalMinor ?? current.totalMinor ?? current.items.reduce((sum, item) => sum + Number(item.lineTotalMinor), 0);
    const fingerprint = `${current.version}:${method}:${total}`;
    const saved = sessionStorage.getItem('checkout-attempt');
    let attempt: { fingerprint: string; key: string } | null = null;
    try { attempt = saved ? JSON.parse(saved) as { fingerprint: string; key: string } : null; } catch { /* create a fresh attempt */ }
    if (attempt?.fingerprint !== fingerprint) attempt = { fingerprint, key: crypto.randomUUID() };
    sessionStorage.setItem('checkout-attempt', JSON.stringify(attempt));
    try {
      const placed = await api<Order>('/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.key, 'If-Match': String(current.version) },
        body: JSON.stringify({ paymentType: method, expectedTotalMinor: total }),
      });
      sessionStorage.removeItem('checkout-attempt');
      setSelectedOrder(placed);
      setOrders((existing) => [placed, ...existing.filter((order) => order.id !== placed.id)]);
      void loadCart().catch(() => undefined);
      return placed;
    } catch (reason) {
      if (conflict(reason)) {
        sessionStorage.removeItem('checkout-attempt');
        try { await loadCart(); } catch { /* original conflict is still relevant */ }
        throw new Error('Price, stock, or cart contents changed. Review the updated cart before placing your order.');
      }
      throw reason;
    }
  }, method === 'demo' ? 'Order placed. Demo payment will complete after fulfillment. No money charged.' : 'Order placed. Payment is pending.'), [loadCart, run]);

  const saveReference = useCallback(async (id: string, reference: string) => {
    await run(`reference:${id}`, async () => {
      const updated = await api<Order>(`/orders/${id}/transfer-reference`, { method: 'PUT', body: JSON.stringify({ reference }) });
      setSelectedOrder(updated);
      setOrders((current) => current.map((order) => order.id === id ? updated : order));
    }, 'Transfer reference saved for review.');
  }, [run]);

  const finishAuth = useCallback(async (result: AuthResult) => {
    setAccessToken(result.accessToken);
    const epoch = getAuthEpoch();
    setUser(result.user);
    const [cartResult, ordersResult] = await Promise.allSettled([api<Cart>('/cart'), api<Page<Order>>('/orders')]);
    if (epoch !== getAuthEpoch()) throw new Error('Your session changed. Please sign in again.');
    if (cartResult.status === 'fulfilled') {
      setCart(cartResult.value);
      setErrors((current) => ({ ...current, cart: '' }));
    }
    else setErrors((current) => ({ ...current, cart: errorText(cartResult.reason) }));
    if (ordersResult.status === 'fulfilled') {
      setOrders(ordersResult.value.items);
      setOrdersCursor(ordersResult.value.nextCursor);
      setErrors((current) => ({ ...current, orders: '' }));
    } else setErrors((current) => ({ ...current, orders: errorText(ordersResult.reason) }));
    setSession('signed-in');
  }, []);
  const login = useCallback(async (identifier: string, password: string) => Boolean(await run('auth', async () => {
    await finishAuth(await api<AuthResult>('/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) }));
    return true;
  }, 'You are signed in.')), [finishAuth, run]);
  const register = useCallback(async (name: string, email: string, phone: string, password: string) => Boolean(await run('auth', async () => {
    await finishAuth(await api<AuthResult>('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, phone, password }) }));
    return true;
  }, 'Your account is ready.')), [finishAuth, run]);
  const requestOtp = useCallback(async (identifier: string, channel: 'email' | 'phone') => run('auth', async () => {
    const result = await api<{ challengeId: string }>('/auth/otp/request', { method: 'POST', body: JSON.stringify({ identifier, channel }) });
    return result.challengeId;
  }, 'If the account is active, a code is on its way.'), [run]);
  const verifyOtp = useCallback(async (challengeId: string, code: string) => Boolean(await run('auth', async () => {
    await finishAuth(await api<AuthResult>('/auth/otp/verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) }));
    return true;
  }, 'You are signed in.')), [finishAuth, run]);
  const logout = useCallback(async () => Boolean(await run('logout', async () => {
    await api('/auth/logout', { method: 'POST' });
    setAccessToken(null);
    setUser(null);
    setSession('guest');
    setCart(emptyCart);
    setOrders([]);
    setOrdersCursor(null);
    setSelectedOrder(null);
    setErrors({});
    sessionStorage.removeItem('checkout-attempt');
    return true;
  }, 'You are signed out.')), [run]);

  const value: Store = { session, user, products, productsCursor, productsLoading, productsError, config, configLoading, cart, orders, ordersCursor, selectedOrder, setSelectedOrder, notice, dismissNotice, pending, error, clearError, notify, run, loadProducts, loadCart, loadOrders, fetchOrder, changeQuantity, checkout, saveReference, login, register, requestOtp, verifyOtp, logout };
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const store = useContext(StoreContext);
  if (!store) throw new Error('StoreProvider is missing');
  return store;
}
