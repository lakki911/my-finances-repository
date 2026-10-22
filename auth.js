// Email/password accounts through Firebase Authentication's REST API.
// The session (including a long-lived refresh token) is kept on this device
// so people stay signed in, like any app.

import { FIREBASE, ADMIN_EMAILS } from './config.js';

const KEY = 'auth.session';
const ERRORS = {
  EMAIL_EXISTS: 'An account with this email already exists. Sign in instead.',
  EMAIL_NOT_FOUND: 'Wrong email or password.',
  INVALID_PASSWORD: 'Wrong email or password.',
  INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
  INVALID_EMAIL: 'That email address doesn\'t look right.',
  MISSING_PASSWORD: 'Enter your password.',
  USER_DISABLED: 'This account has been turned off by the admin.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes and try again.',
  OPERATION_NOT_ALLOWED: 'Email sign-in is not switched on in Firebase yet.',
};

export class SignedOut extends Error {
  constructor() { super('Please sign in again.'); }
}

function read() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
function write(s) { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch {} }

let session = read();

export const isConfigured = () => !!(FIREBASE.apiKey && FIREBASE.projectId);
export const current = () => session;
export const isAdmin = () => !!session && ADMIN_EMAILS.map(e => e.toLowerCase()).includes(session.email.toLowerCase());

function claims(idToken) {
  try { return JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
}

async function call(path, body) {
  let res;
  try {
    res = await fetch(`https://identitytoolkit.googleapis.com/v1/${path}?key=${FIREBASE.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error('No internet connection. Connect and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(data.error?.message || '').split(' ')[0];
    if (code.startsWith('WEAK_PASSWORD')) throw new Error('Use a password with at least 6 characters.');
    throw new Error(ERRORS[code] || 'Something went wrong. Try again.');
  }
  return data;
}

function start(r, name) {
  const c = claims(r.idToken);
  session = {
    uid: r.localId, email: r.email, name: name || r.displayName || r.email.split('@')[0],
    idToken: r.idToken, refreshToken: r.refreshToken,
    expires: Date.now() + Number(r.expiresIn || 3600) * 1000, verified: !!c.email_verified,
  };
  write(session);
  return session;
}

export async function register(name, email, password) {
  const r = await call('accounts:signUp', { email, password, returnSecureToken: true });
  await call('accounts:update', { idToken: r.idToken, displayName: name, returnSecureToken: false });
  await call('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: r.idToken }).catch(() => {});
  return start(r, name);
}

export async function login(email, password) {
  return start(await call('accounts:signInWithPassword', { email, password, returnSecureToken: true }));
}

export const resetPassword = email => call('accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email });

// Checks the current password by signing in again (Firebase also requires a
// recent sign-in for this), then sets the new one. The session gets new tokens.
export async function changePassword(currentPassword, newPassword) {
  if (!session) throw new SignedOut();
  let fresh;
  try {
    fresh = await call('accounts:signInWithPassword', { email: session.email, password: currentPassword, returnSecureToken: true });
  } catch (err) {
    throw err.message === ERRORS.INVALID_PASSWORD ? new Error('Your current password is wrong.') : err;
  }
  const r = await call('accounts:update', { idToken: fresh.idToken, password: newPassword, returnSecureToken: true });
  start({ ...r, email: r.email || session.email }, session.name);
}

export async function resendVerification() {
  await call('accounts:sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: await token() });
}

// A valid ID token, refreshed when it is about to expire.
export async function token({ force = false } = {}) {
  if (!session) throw new SignedOut();
  if (!force && session.expires > Date.now() + 60_000) return session.idToken;
  let res;
  try {
    res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}`,
    });
  } catch {
    throw new Error('No internet connection.');
  }
  if (!res.ok) { logout(); throw new SignedOut(); }
  const r = await res.json();
  session = { ...session, idToken: r.id_token, refreshToken: r.refresh_token, expires: Date.now() + Number(r.expires_in) * 1000, verified: !!claims(r.id_token).email_verified };
  write(session);
  return session.idToken;
}

export function logout() {
  session = null;
  write(null);
}
