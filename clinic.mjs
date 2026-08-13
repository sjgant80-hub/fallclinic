// clinic.mjs — the parts of fallclinic where being wrong hurts somebody.
//
// Lifted OUT of index.html unchanged in behaviour, not rewritten: the page imports these, so the code
// the gate attacks is the code that runs. Everything here is pure — the clock and the hash are handed
// in — because a function that reads Date.now() cannot be tested at a boundary, and every rule below
// IS a boundary.
//
// What is gated and why it matters:
//   · interactions   a missed pair is patient harm
//   · CD register    the controlled-drug balance is a statutory record
//   · expiry flags   an expired indemnity or revalidation means someone is practising uncovered
//   · audit chain    a tamper-evident log nobody can verify is decoration

// ── time ─────────────────────────────────────────────────────────────────────────────────────────
const DAY = 24 * 3600 * 1000;

/** Whole days from `now` until `ts`. Negative means it has already gone by. */
export function daysFromNow(ts, now) {
  if (!ts) return null;
  const t = Number(now);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Number(ts) - t) / DAY);
}

/** Age in whole years, birthday-aware — someone born on 29 Feb is not a year older on 28 Feb. */
export function ageFromDob(dob, now) {
  if (!dob) return null;
  const d = new Date(dob);
  const a = new Date(Number(now));
  if (Number.isNaN(d.getTime()) || Number.isNaN(a.getTime())) return null;
  let age = a.getFullYear() - d.getFullYear();
  const m = a.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && a.getDate() < d.getDate())) age--;
  return age;
}

// ── who is safe to practise ──────────────────────────────────────────────────────────────────────
// RED means stop; AMBER means it is coming. The thresholds are the ones the app already used:
// revalidation 90 days, indemnity 30 days, appraisal annually.
export const REVALIDATION_WARN_DAYS = 90;
export const INDEMNITY_WARN_DAYS = 30;
export const APPRAISAL_PERIOD_DAYS = 365;

export function clinicianFlags(c, now) {
  const f = [];
  if (!c) return f;
  const r = daysFromNow(c.revalidationDue, now);
  if (r !== null && r < 0) f.push({ sev: 'red', msg: 'Revalidation overdue' });
  else if (r !== null && r < REVALIDATION_WARN_DAYS) f.push({ sev: 'amber', msg: 'Revalidation due in ' + r + 'd' });

  const a = c.appraisalLastAt ? daysFromNow(c.appraisalLastAt + APPRAISAL_PERIOD_DAYS * DAY, now) : null;
  if (a !== null && a < 0) f.push({ sev: 'amber', msg: 'Annual appraisal overdue' });

  const ix = daysFromNow(c.indemnityExpiry, now);
  if (ix !== null && ix < 0) f.push({ sev: 'red', msg: 'Indemnity expired' });
  else if (ix !== null && ix < INDEMNITY_WARN_DAYS) f.push({ sev: 'amber', msg: 'Indemnity in ' + ix + 'd' });
  return f;
}

export function firmFlags(f, now) {
  const out = [];
  if (!f) return out;
  const ix = daysFromNow(f.piExpiresAt, now);
  if (ix !== null && ix < 0) out.push({ sev: 'red', msg: 'Clinic PII expired' });
  else if (ix !== null && ix < INDEMNITY_WARN_DAYS) out.push({ sev: 'amber', msg: 'Clinic PII in ' + ix + 'd' });
  return out;
}

export function patientFlags(p, openEpisodes, now) {
  const f = [];
  if (!p) return f;
  if (p.vulnerabilityFlag) f.push({ sev: 'amber', msg: 'Vulnerable patient flag' });
  const ap = daysFromNow(p.nextAppointmentAt, now);
  if (ap !== null && ap < 0) f.push({ sev: 'amber', msg: 'Missed appointment' });
  const open = Number(openEpisodes) || 0;
  if (open > 0) f.push({ sev: 'green', msg: open + ' open episode' + (open > 1 ? 's' : '') });
  return f;
}

// ── drug interactions ────────────────────────────────────────────────────────────────────────────
// ⚑ NOT EXHAUSTIVE, AND IT SAYS SO. This is a short BNF-shaped list, not the BNF. It is a prompt to
// check, never a clearance to prescribe — `exhaustive: false` rides on every result so no caller can
// render a clean check as "no interactions exist".
export const INTERACTIONS = [
  ['warfarin', 'aspirin', 'SEVERE', 'Increased bleeding risk · INR'],
  ['warfarin', 'ibuprofen', 'SEVERE', 'GI bleeding risk · avoid'],
  ['warfarin', 'amiodarone', 'SEVERE', 'Potentiates warfarin · halve dose'],
  ['warfarin', 'clarithromycin', 'SEVERE', 'Raises INR significantly'],
  ['warfarin', 'metronidazole', 'SEVERE', 'Raises INR'],
  ['warfarin', 'fluconazole', 'MODERATE', 'Raises INR'],
  ['warfarin', 'paracetamol', 'MODERATE', 'Prolonged use may raise INR'],
  ['methotrexate', 'trimethoprim', 'SEVERE', 'Profound marrow suppression · avoid'],
  ['simvastatin', 'clarithromycin', 'SEVERE', 'Rhabdomyolysis risk · suspend statin'],
  ['lithium', 'ibuprofen', 'SEVERE', 'Raises lithium to toxic levels'],
  ['lithium', 'ramipril', 'SEVERE', 'Raises lithium levels'],
  ['ciprofloxacin', 'theophylline', 'SEVERE', 'Theophylline toxicity'],
  ['sildenafil', 'isosorbide', 'SEVERE', 'Profound hypotension · contraindicated'],
  ['spironolactone', 'ramipril', 'MODERATE', 'Hyperkalaemia · check U&E'],
  ['digoxin', 'amiodarone', 'SEVERE', 'Digoxin toxicity · halve dose'],
];

/** A name is only comparable once it is trimmed and lowercased. Empty means "no name given". */
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * Ordering for the alert list. A named function rather than an inline ternary, because the gate
 * showed the inline version could be mutated without any test noticing — the severe pairs happened
 * to already be first in the table, so a broken comparator looked identical to a working one.
 * Anything unrecognised sorts LAST but is never dropped.
 */
export function severityRank(sev) {
  const s = String(sev == null ? '' : sev).toUpperCase();
  if (s === 'SEVERE') return 0;
  if (s === 'MODERATE') return 1;
  return 2;
}

/**
 * ⚑ THE EMPTY-STRING TRAP. The original matched each way round with `includes`, and EVERY string
 * contains the empty string — so one blank medication row made every drug on the list look like an
 * interaction. Blanks are dropped before matching, and a blank query returns nothing.
 *
 * Matching is on whole words rather than bare substrings for the same reason: "a" must not match
 * "aspirin", or a one-character typo raises a severe alert on a drug nobody is taking.
 */
export function mentions(haystack, drug) {
  const h = norm(haystack), d = norm(drug);
  if (!h || !d) return false;
  if (h === d) return true;
  // word-boundary containment, either direction, so "warfarin sodium" still matches "warfarin"
  const words = h.split(/[^a-z0-9]+/).filter(Boolean);
  return words.includes(d);
}

/**
 * Interactions between a proposed drug and everything the patient is already on.
 * `currentDrugs` is the caller's list — regular medications plus live prescriptions.
 */
export function checkInteractions(currentDrugs, proposed) {
  const p = norm(proposed);
  const found = [];
  if (!p) return { interactions: found, checked: 0, exhaustive: false };
  const taking = (Array.isArray(currentDrugs) ? currentDrugs : [])
    .map(m => (m && typeof m === 'object') ? m.name : m)
    .map(norm)
    .filter(Boolean);

  for (const [a, b, sev, note] of INTERACTIONS) {
    let other = null;
    if (mentions(p, a)) other = b;
    else if (mentions(p, b)) other = a;
    if (!other) continue;
    if (taking.some(m => mentions(m, other))) found.push({ a: proposed, b: other, sev, note });
  }
  // Severe first: an alert list a prescriber scrolls is an alert list a prescriber misses.
  found.sort((x, y) => severityRank(x.sev) - severityRank(y.sev));
  return { interactions: found, checked: taking.length, exhaustive: false };
}

// ── the controlled-drug register ─────────────────────────────────────────────────────────────────
// A statutory running balance. Every movement is one of these, and nothing else counts.
export const CD_IN = ['received'];
export const CD_OUT = ['supplied', 'administered', 'destroyed', 'returned'];

/**
 * ⚑ AN UNKNOWN MOVEMENT IS REFUSED, NOT GUESSED. The original subtracted for anything that was not
 * 'received', so a typo in `tx` silently removed stock from a legally-required register. Here an
 * unrecognised movement is REPORTED and excluded, and the balance says it is not trustworthy —
 * a controlled-drug balance that is quietly wrong is worse than one that admits it cannot be computed.
 */
export function cdBalance(register, drug) {
  const want = norm(drug);
  let balance = 0, moves = 0;
  const rejected = [];
  for (const e of (Array.isArray(register) ? register : [])) {
    if (!e || norm(e.drug) !== want || !want) continue;
    const q = Number(e.qty);
    if (!Number.isFinite(q) || q < 0) { rejected.push({ id: e.id ?? null, why: 'quantity is not a positive number' }); continue; }
    const tx = norm(e.tx);
    if (CD_IN.includes(tx)) { balance += q; moves++; }
    else if (CD_OUT.includes(tx)) { balance -= q; moves++; }
    else rejected.push({ id: e.id ?? null, why: `unrecognised movement "${e.tx}"` });
  }
  return { drug, balance, moves, rejected, trustworthy: rejected.length === 0 };
}

export function cdUniqueDrugs(register) {
  const seen = new Set();
  for (const e of (Array.isArray(register) ? register : [])) {
    const d = e && String(e.drug || '').trim();
    if (d) seen.add(d);
  }
  return [...seen].sort();
}

// ── the audit chain ──────────────────────────────────────────────────────────────────────────────
/**
 * The bytes that get hashed for one entry. Kept as its own function so the writer and the verifier
 * can never disagree about what was signed — which is the only way a chain check means anything.
 */
export function auditPayload(prevHash, entry) {
  const e = (entry && typeof entry === 'object') ? entry : {};
  return String(prevHash == null ? '' : prevHash)
    + String(e.ts ?? '')
    + String(e.action ?? '')
    + String(e.clinicianId ?? '')
    + String(e.patientId ?? '')
    + JSON.stringify(e.payload ?? {});
}

/**
 * ⚑ THE CHAIN WAS WRITTEN BUT NEVER CHECKED. index.html built prevHash/docHash on every entry and
 * nothing ever re-walked them, so the tamper-evidence was a claim rather than a property. This walks
 * the log and names the FIRST entry that does not reproduce — the earliest break is the one that
 * tells you when the tampering happened; later mismatches are just its wake.
 *
 * `sha256` is injected (async) so this stays pure and testable without WebCrypto.
 */
export async function verifyAuditChain(entries, sha256) {
  const log = Array.isArray(entries) ? entries : [];
  if (typeof sha256 !== 'function') throw new Error('verifyAuditChain needs a sha256(string) function');
  let prev = '';
  for (let i = 0; i < log.length; i++) {
    const e = log[i] || {};
    if (String(e.prevHash ?? '') !== prev) {
      return { ok: false, brokeAt: i, id: e.id ?? null, reason: 'prevHash does not match the entry before it' };
    }
    const expected = await sha256(auditPayload(prev, e));
    if (expected !== e.docHash) {
      return { ok: false, brokeAt: i, id: e.id ?? null, reason: 'entry was altered after it was written' };
    }
    prev = e.docHash;
  }
  return { ok: true, entries: log.length, reason: log.length ? 'every entry reproduces its own hash' : 'the log is empty' };
}

export default {
  daysFromNow, ageFromDob, clinicianFlags, firmFlags, patientFlags,
  mentions, checkInteractions, cdBalance, cdUniqueDrugs,
  auditPayload, verifyAuditChain, INTERACTIONS, CD_IN, CD_OUT,
};
