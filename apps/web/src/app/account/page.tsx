'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { useStore } from '@/context/store';

type Mode = 'login' | 'register' | 'otp';
type Challenge = { id: string; channel: 'email' | 'phone' };

function AccountContent() {
  const router = useRouter();
  const search = useSearchParams();
  const returnParam = search.get('return');
  const returnPath = returnParam && ['/', '/cart', '/orders', '/admin'].includes(returnParam) ? returnParam : '/';
  const { session, user, pending, error, clearError, login, register, requestOtp, verifyOtp, logout } = useStore();
  const [mode, setMode] = useState<Mode>('login');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (challenge) {
      if (await verifyOtp(challenge.id, String(data.get('code')))) router.push(returnPath);
    } else if (mode === 'register') {
      if (await register(String(data.get('name')), String(data.get('email')), String(data.get('phone')), String(data.get('password')))) router.push(returnPath);
    } else if (mode === 'otp') {
      const channel = String(data.get('channel')) as 'email' | 'phone';
      const challengeId = await requestOtp(String(data.get('identifier')), channel);
      if (challengeId) setChallenge({ id: challengeId, channel });
    } else if (await login(String(data.get('identifier')), String(data.get('password')))) router.push(returnPath);
  }
  async function signOut() { if (await logout()) router.push('/'); }
  return <div className="interior-page account-page"><div className="page-heading"><Link href="/" className="back-link">← Back to menu</Link><h1>Your account.</h1><p>Sign in to keep a cart and follow your orders.</p></div>
    {session === 'checking' && <div className="paper-panel account-panel state-copy" role="status">Checking your session…</div>}
    {session === 'signed-in' && user && <section className="paper-panel account-panel"><div className="section-heading"><h2>Signed in</h2><span className="status-stamp">ACTIVE</span></div><dl className="account-details"><div><dt>Name</dt><dd>{user.name}</dd></div><div><dt>Email</dt><dd>{user.email}</dd></div><div><dt>Phone</dt><dd>{user.phone}</dd></div></dl><div className="account-actions"><Link className="button button-red" href="/orders">View orders</Link><button type="button" className="button button-outline" disabled={pending('logout')} onClick={() => void signOut()}>{pending('logout') ? 'Signing out…' : 'Sign out'}</button></div>{error('logout') && <p className="inline-error" role="alert">{error('logout')}</p>}</section>}
    {session === 'guest' && <section className="paper-panel account-panel"><div className="auth-tabs" role="group" aria-label="Sign in method">{(['login', 'register', 'otp'] as const).map((item) => <button key={item} type="button" aria-pressed={mode === item && !challenge} className={mode === item && !challenge ? 'selected' : ''} onClick={() => { setMode(item); setChallenge(null); clearError('auth'); }}>{item === 'login' ? 'Password login' : item === 'register' ? 'Create account' : 'Login with OTP'}</button>)}</div><form key={challenge?.id ?? mode} onSubmit={(event) => void submit(event)} className="auth-form"><h2>{challenge ? `Verify ${challenge.channel === 'phone' ? 'SMS' : 'email'} code` : mode === 'register' ? 'Create an account' : mode === 'otp' ? 'Login with a code' : 'Sign in'}</h2>{challenge ? <><p>Enter the six digit code within five minutes.</p><label htmlFor="otp-code">Verification code</label><input id="otp-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /><button type="button" className="text-link" onClick={() => { setChallenge(null); clearError('auth'); }}>Request a new code</button></> : mode === 'register' ? <><label htmlFor="register-name">Full name</label><input id="register-name" name="name" autoComplete="name" required /><label htmlFor="register-email">Email</label><input id="register-email" name="email" type="email" autoComplete="email" required /><label htmlFor="register-phone">Phone</label><input id="register-phone" name="phone" type="tel" autoComplete="tel" placeholder="+923001234567" required /><label htmlFor="register-password">Password</label><input id="register-password" name="password" type="password" autoComplete="new-password" minLength={12} required /><small>Use at least 12 characters.</small></> : <><label htmlFor="auth-identifier">Email or phone</label><input id="auth-identifier" name="identifier" autoComplete={mode === 'login' ? 'username' : 'off'} placeholder="Email or +92 phone" required />{mode === 'login' ? <><label htmlFor="auth-password">Password</label><input id="auth-password" name="password" type="password" autoComplete="current-password" required /></> : <><label htmlFor="auth-channel">Send code by</label><select id="auth-channel" name="channel"><option value="email">Email</option><option value="phone">SMS</option></select></>}</>}{error('auth') && <p className="inline-error" role="alert">{error('auth')}</p>}<button type="submit" className="button button-red" disabled={pending('auth')}>{pending('auth') ? 'Please wait…' : challenge ? 'Verify code' : mode === 'register' ? 'Create account' : mode === 'otp' ? 'Send code' : 'Sign in'}</button></form></section>}
  </div>;
}

export default function AccountPage() { return <Suspense fallback={<div className="interior-page state-copy" role="status">Loading account…</div>}><AccountContent /></Suspense>; }
