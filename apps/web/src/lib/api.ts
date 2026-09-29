export type User = { id: string; name: string; email: string; phone: string; role: 'customer' | 'admin' };
export type Variant = { id: string; name: string; sku?: string; priceMinor: number; stock?: number; available?: boolean; active?: boolean };
export type Product = { id: string; name: string; description: string; active?: boolean; archivedAt?: string | null; variants: Variant[] };
export type CartItem = { productId: string; variantId: string; name?: string; productName?: string; variantName?: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number; available?: boolean };
export type Cart = { version: number; items: CartItem[]; estimatedTotalMinor?: number; totalMinor?: number; currency: string };
export type Order = { id: string; status: 'pending' | 'paid' | 'cancelled'; fulfillmentStatus: 'queued' | 'ready' | 'failed' | 'cancelled'; fulfillmentUpdatedAt: string; paymentType: 'cod' | 'bank_transfer' | 'demo'; paymentStatus: 'pending' | 'paid'; totalMinor: number; currency: string; transferReference?: string | null; createdAt: string; items: (CartItem & { id?: string })[] };
export type CheckoutConfig = { currency: 'PKR'; bankTransfer: { bankName: string; accountName: string; iban: string } | null; demoPaymentsEnabled: boolean };
export type ApiError = Error & { status: number; code: string };

const base = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '/v1').replace(/\/$/, '');
let accessToken: string | null = null;
let authEpoch = 0;
let tokenRevision = 0;
let refreshInFlight: Promise<boolean> | null = null;
let sessionChannel: BroadcastChannel | null = null;
const sessionClearedListeners = new Set<() => void>();

function tokenSubject(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown };
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch { return null; }
}

function clearSession(broadcast: boolean) {
  accessToken = null;
  authEpoch += 1;
  tokenRevision += 1;
  sessionClearedListeners.forEach((listener) => listener());
  if (broadcast) channel()?.postMessage({ type: 'session-cleared' });
}

function channel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!sessionChannel) {
    sessionChannel = new BroadcastChannel('food-ordering-session');
    sessionChannel.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'session-cleared') {
        clearSession(false);
      } else if (event.data?.type === 'session-refreshed' && typeof event.data.accessToken === 'string' && accessToken) {
        const currentSubject = tokenSubject(accessToken);
        const incomingSubject = tokenSubject(event.data.accessToken);
        if (!currentSubject || currentSubject !== incomingSubject) {
          clearSession(false);
        } else {
          accessToken = event.data.accessToken;
          tokenRevision += 1;
        }
      }
    };
  }
  return sessionChannel;
}

export function onSessionCleared(listener: () => void): () => void {
  sessionClearedListeners.add(listener);
  channel();
  return () => { sessionClearedListeners.delete(listener); };
}

export function setAccessToken(token: string | null) {
  if (token === null) { clearSession(accessToken !== null); return; }
  accessToken = token;
  authEpoch += 1;
  tokenRevision += 1;
  channel()?.postMessage({ type: 'session-cleared' });
}

export function getAuthEpoch(): number { return authEpoch; }

function assertCurrentSession(path: string, epoch: number) {
  if (epoch === authEpoch || !/^\/(me|cart|orders|admin)(\/|\?|$)/.test(path)) return;
  const error = new Error('Your session changed. Please retry.') as ApiError;
  error.status = 401;
  error.code = 'SESSION_CHANGED';
  throw error;
}

export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const epoch = authEpoch;
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const send = () => fetch(`${base}${path}`, { ...init, headers, credentials: 'include', cache: 'no-store' });
  const response = /^\/auth\/(register|login|otp\/verify|logout)$/.test(path) && typeof navigator !== 'undefined' && navigator.locks
    ? await navigator.locks.request('food-ordering-refresh', send)
    : await send();
  assertCurrentSession(path, epoch);
  if (response.status === 401 && retry && path !== '/auth/refresh' && accessToken) {
    const refreshed = await refresh().catch(() => false);
    if (refreshed) return api<T>(path, init, false);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { code?: string; message?: string };
    assertCurrentSession(path, epoch);
    const error = new Error(body.message ?? `Request failed (${response.status})`) as ApiError;
    error.status = response.status;
    error.code = body.code ?? 'REQUEST_FAILED';
    throw error;
  }
  if (response.status === 204) { assertCurrentSession(path, epoch); return undefined as T; }
  const body = await response.json() as T;
  assertCurrentSession(path, epoch);
  return body;
}

export async function refresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const epoch = authEpoch;
  const revision = tokenRevision;
  const current = (async () => {
    const rotate = async () => {
      if (epoch !== authEpoch) return false;
      if (revision !== tokenRevision && accessToken) return true;
      const response = await fetch(`${base}/auth/refresh`, { method: 'POST', credentials: 'include', cache: 'no-store' });
      if (epoch !== authEpoch) return false;
      if (!response.ok) { clearSession(accessToken !== null); return false; }
      const body = await response.json() as { accessToken: string };
      if (epoch !== authEpoch) return false;
      if (accessToken && tokenSubject(accessToken) !== tokenSubject(body.accessToken)) {
        clearSession(false);
        return false;
      }
      accessToken = body.accessToken;
      tokenRevision += 1;
      channel()?.postMessage({ type: 'session-refreshed', accessToken: body.accessToken });
      return true;
    };
    channel();
    return typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('food-ordering-refresh', rotate)
      : rotate();
  })();
  refreshInFlight = current;
  try { return await current; }
  finally { if (refreshInFlight === current) refreshInFlight = null; }
}

export function money(minor: number | string): string {
  const paisa = Number(minor);
  if (!Number.isFinite(paisa)) return 'Rs —';
  const amount = Math.abs(Math.trunc(paisa));
  const rupees = String(Math.floor(amount / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = amount % 100;
  return `${paisa < 0 ? '-' : ''}Rs ${rupees}${fraction ? `.${String(fraction).padStart(2, '0')}` : ''}`;
}
