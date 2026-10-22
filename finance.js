// Pure money maths: returns (XIRR), loan schedules, and an Indian income-tax estimate.

const DAY = 86400000;
const toTime = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

// Annualised return of dated cash flows [{ date: 'YYYY-MM-DD', amount }], money paid in
// as negative and value received (or held today) as positive. Returns NaN if undefined.
export function xirr(flows) {
  if (flows.length < 2 || !flows.some(f => f.amount < 0) || !flows.some(f => f.amount > 0)) return NaN;
  const t0 = Math.min(...flows.map(f => toTime(f.date)));
  const yrs = flows.map(f => (toTime(f.date) - t0) / (365 * DAY));
  if (Math.max(...yrs) < 1 / 365) return NaN;
  const npv = r => flows.reduce((s, f, i) => s + f.amount / Math.pow(1 + r, yrs[i]), 0);
  // Bisection: robust where Newton's method can diverge.
  let lo = -0.9999, hi = 10;
  if (npv(lo) * npv(hi) > 0) return NaN;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
    if (hi - lo < 1e-7) break;
  }
  return (lo + hi) / 2;
}

export function emi(principal, annualRate, months) {
  const r = annualRate / 1200;
  if (!r) return principal / months;
  const k = Math.pow(1 + r, months);
  return (principal * r * k) / (k - 1);
}

// Month-by-month schedule of a loan with optional prepayments [{ date, amount }].
// The EMI stays the same; prepayments shorten the loan.
export function schedule(loan) {
  const r = (loan.rate || 0) / 1200;
  const pay = loan.emi || emi(loan.principal, loan.rate, loan.months);
  const extra = [...(loan.prepay || [])];
  const rows = [];
  let bal = loan.principal;
  let [y, m] = loan.start.split('-').map(Number);
  for (let i = 0; i < 600 && bal > 0.5; i++) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    const interest = bal * r;
    const principal = Math.min(bal, pay - interest);
    if (principal <= 0) break; // EMI doesn't cover interest
    bal -= principal;
    const pre = Math.min(bal, extra.filter(p => p.date.slice(0, 7) === month).reduce((s, p) => s + p.amount, 0));
    bal -= pre;
    rows.push({ month, interest, principal: principal + pre, emi: Math.min(pay, interest + principal), prepaid: pre, balance: Math.max(0, bal) });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return rows;
}

// ---- Indian income tax (individual, below 60) — an estimate, not advice ----

function slabTax(income, slabs) {
  let tax = 0, prev = 0;
  for (const [upto, rate] of slabs) {
    if (income > prev) tax += (Math.min(income, upto) - prev) * rate;
    prev = upto;
  }
  return tax;
}

const NEW_SLABS = [[400000, 0], [800000, 0.05], [1200000, 0.10], [1600000, 0.15], [2000000, 0.20], [2400000, 0.25], [Infinity, 0.30]];
const OLD_SLABS = [[250000, 0], [500000, 0.05], [1000000, 0.20], [Infinity, 0.30]];

function surcharge(taxable, tax, maxRate) {
  const rate = taxable > 50000000 ? maxRate : taxable > 20000000 ? 0.25 : taxable > 10000000 ? 0.15 : taxable > 5000000 ? 0.10 : 0;
  return tax * Math.min(rate, maxRate);
}

// income: { salary, other }; d: deductions for the old regime.
// Uses the slabs from Budget 2025 (FY 2025–26 onwards).
export function incomeTax(income, d) {
  const gross = (income.salary || 0) + (income.other || 0);

  const newTaxable = Math.max(0, gross - (income.salary ? 75000 : 0));
  let newTax = slabTax(newTaxable, NEW_SLABS);
  if (newTaxable <= 1200000) newTax = 0; // section 87A rebate
  else newTax = Math.min(newTax, newTaxable - 1200000); // marginal relief just above ₹12 lakh
  newTax += surcharge(newTaxable, newTax, 0.25);

  const deductions = {
    standard: income.salary ? 50000 : 0,
    c80: Math.min(150000, d.c80 || 0),
    d80: Math.min(d.d80max || 75000, d.d80 || 0),
    nps: Math.min(50000, d.nps || 0),
    homeInterest: Math.min(200000, d.homeInterest || 0),
    hra: d.hra || 0,
    other: d.other || 0,
  };
  const oldTaxable = Math.max(0, gross - Object.values(deductions).reduce((s, v) => s + v, 0));
  let oldTax = slabTax(oldTaxable, OLD_SLABS);
  if (oldTaxable <= 500000) oldTax = 0;
  oldTax += surcharge(oldTaxable, oldTax, 0.37);

  return {
    gross,
    newRegime: { taxable: newTaxable, tax: newTax * 1.04 },
    oldRegime: { taxable: oldTaxable, tax: oldTax * 1.04, deductions },
  };
}
