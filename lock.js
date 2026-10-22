// App lock: a PIN kept on this device (as a salted hash), plus fingerprint or
// face unlock in the Android app. Forgetting the PIN means signing in again.

const KEY = 'lock';
const AWAY_MS = 60_000; // lock again after a minute in the background

const plugins = {};
const plugin = name => (plugins[name] ||= window.Capacitor?.registerPlugin?.(name));
const native = () => !!window.Capacitor?.isNativePlatform?.();

function read() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
function write(v) { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch {} }

async function hash(pin, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const enabled = () => !!read()?.hash;
export const biometricOn = () => !!read()?.biometric;

export async function setPin(pin, biometric = false) {
  const salt = crypto.getRandomValues(new Uint32Array(2)).join('-');
  write({ salt, hash: await hash(pin, salt), len: String(pin).length, biometric });
}
export const pinLength = () => read()?.len || 0;
export function setBiometric(on) {
  const v = read();
  if (v) write({ ...v, biometric: on });
}
export const clear = () => write(null);

export async function check(pin) {
  const v = read();
  return !!v && (await hash(pin, v.salt)) === v.hash;
}

export async function biometricAvailable() {
  if (!native()) return false;
  try { return !!(await plugin('NativeBiometric').isAvailable())?.isAvailable; } catch { return false; }
}

export async function biometricUnlock() {
  try {
    await plugin('NativeBiometric').verifyIdentity({ reason: 'Unlock My Finances', title: 'Unlock My Finances', negativeButtonText: 'Use PIN' });
    return true;
  } catch {
    return false;
  }
}

// Lock state for this page session.
let locked = enabled();
let hiddenAt = 0;
export const isLocked = () => locked && enabled();
export const unlock = () => { locked = false; };
export function onHidden() { hiddenAt = Date.now(); }
// True if the app should lock now that it is visible again.
export function onVisible() {
  if (enabled() && hiddenAt && Date.now() - hiddenAt > AWAY_MS) locked = true;
  hiddenAt = 0;
  return isLocked();
}
