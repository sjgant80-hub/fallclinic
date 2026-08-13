// clinic.test.mjs — PROOF-OF-PLAY for the parts where being wrong hurts somebody.
import {
  daysFromNow, ageFromDob, clinicianFlags, firmFlags, patientFlags,
  mentions, checkInteractions, cdBalance, cdUniqueDrugs, severityRank,
  auditPayload, verifyAuditChain, CD_OUT, APPRAISAL_PERIOD_DAYS, REVALIDATION_WARN_DAYS, INDEMNITY_WARN_DAYS,
} from './clinic.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ FAIL ') + m); };
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-08-13T12:00:00Z');

// A deterministic stand-in for WebCrypto. Not a real digest — the chain logic is what is under test,
// and a real SHA here would only prove Node's crypto works.
const fakeSha = async (s) => 'h' + [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16);

console.log('\n=== §1 · days and ages ===');
{
  ok(daysFromNow(NOW + 5 * DAY, NOW) === 5, 'five days ahead is 5');
  ok(daysFromNow(NOW - 5 * DAY, NOW) === -5, 'five days gone is -5');
  ok(daysFromNow(null, NOW) === null && daysFromNow(0, NOW) === null, 'no date is null, never 0');
  ok(daysFromNow(NOW, 'nonsense') === null, 'an unusable clock is null rather than NaN days');

  ok(ageFromDob('1990-08-13', NOW) === 36, 'a birthday today counts today');
  ok(ageFromDob('1990-08-14', NOW) === 35, '⚑ and a birthday TOMORROW does not — off by one here misclassifies a child');
  ok(ageFromDob('1990-12-01', NOW) === 35, 'later in the year has not happened yet');
  ok(ageFromDob(null, NOW) === null && ageFromDob('rubbish', NOW) === null, 'no usable date of birth is null');
}

console.log('\n=== §2 · ⚑ WHO IS SAFE TO PRACTISE ===');
{
  const expired = clinicianFlags({ indemnityExpiry: NOW - DAY }, NOW);
  ok(expired.some(f => f.sev === 'red' && /Indemnity expired/.test(f.msg)),
     '⚑ expired indemnity is RED — someone is seeing patients uncovered');
  const soon = clinicianFlags({ indemnityExpiry: NOW + 10 * DAY }, NOW);
  ok(soon.some(f => f.sev === 'amber' && /Indemnity in 10d/.test(f.msg)), 'and 10 days out is amber, with the number');
  ok(clinicianFlags({ indemnityExpiry: NOW + 400 * DAY }, NOW).length === 0, 'well in date raises nothing');

  const rev = clinicianFlags({ revalidationDue: NOW - DAY }, NOW);
  ok(rev.some(f => f.sev === 'red'), 'overdue revalidation is red');
  ok(clinicianFlags({ revalidationDue: NOW + 89 * DAY }, NOW).some(f => f.sev === 'amber'), '89 days is inside the 90-day warning');
  ok(clinicianFlags({ revalidationDue: NOW + 91 * DAY }, NOW).length === 0, '91 days is not');

  ok(clinicianFlags({ appraisalLastAt: NOW - 400 * DAY }, NOW).some(f => /appraisal overdue/i.test(f.msg)),
     'an appraisal over a year old is flagged');
  ok(clinicianFlags({ appraisalLastAt: NOW - 300 * DAY }, NOW).length === 0, 'one from 300 days ago is not');
  ok(clinicianFlags(null, NOW).length === 0, 'no clinician raises nothing');

  ok(firmFlags({ piExpiresAt: NOW - DAY }, NOW).some(f => f.sev === 'red'), 'expired clinic insurance is red');
  ok(firmFlags(null, NOW).length === 0 && firmFlags({}, NOW).length === 0, 'a firm with no policy date raises nothing');
}

console.log('\n=== §2b · ⚑ THE DAY IT EXPIRES, IT IS STILL VALID ===');
{
  // Every one of these is a `< 0` the gate showed nothing pinned. An indemnity that runs out TODAY
  // covers today — treating day 0 as expired would tell a clinician to stop seeing patients a day
  // early, and treating day -1 as fine would tell them to carry on a day too long.
  const today = clinicianFlags({ indemnityExpiry: NOW }, NOW);
  ok(!today.some(f => f.sev === 'red'), '⚑ indemnity expiring TODAY is not yet expired');
  ok(today.some(f => f.sev === 'amber' && /Indemnity in 0d/.test(f.msg)), 'it is amber, with 0 days left');
  ok(clinicianFlags({ indemnityExpiry: NOW - DAY }, NOW).some(f => f.sev === 'red'), 'and yesterday IS red');

  ok(!clinicianFlags({ revalidationDue: NOW }, NOW).some(f => f.sev === 'red'), 'revalidation due today is not overdue');
  ok(clinicianFlags({ revalidationDue: NOW }, NOW).some(f => f.sev === 'amber'), 'but it is amber');

  const appToday = clinicianFlags({ appraisalLastAt: NOW - APPRAISAL_PERIOD_DAYS * DAY }, NOW);
  ok(!appToday.some(f => /appraisal overdue/i.test(f.msg)), 'an appraisal exactly a year old is due, not overdue');

  ok(!firmFlags({ piExpiresAt: NOW }, NOW).some(f => f.sev === 'red'), 'clinic insurance expiring today still covers today');
  ok(firmFlags({ piExpiresAt: NOW - DAY }, NOW).some(f => f.sev === 'red'), 'yesterday does not');
  // The && that made a FUTURE date read as expired when mutated.
  ok(firmFlags({ piExpiresAt: NOW + 400 * DAY }, NOW).length === 0,
     '⚑ a policy well in date raises NOTHING — not "expired"');
  ok(clinicianFlags({ indemnityExpiry: NOW + 400 * DAY }, NOW).length === 0, 'same for a clinician in date');

  ok(!patientFlags({ nextAppointmentAt: NOW }, 0, NOW).some(f => /Missed/.test(f.msg)),
     "an appointment today has not been missed — the day is not over");
  ok(patientFlags({ nextAppointmentAt: NOW - DAY }, 0, NOW).some(f => /Missed/.test(f.msg)), 'yesterday has');

  // The far edge of each warning window. 89 and 91 were tested; exactly 90 was not, and that is the
  // only day where "warn from here" and "warn after here" differ.
  ok(clinicianFlags({ revalidationDue: NOW + REVALIDATION_WARN_DAYS * DAY }, NOW).length === 0,
     '⚑ exactly 90 days out is OUTSIDE the revalidation warning — the window opens the day after');
  ok(clinicianFlags({ revalidationDue: NOW + (REVALIDATION_WARN_DAYS - 1) * DAY }, NOW).some(f => f.sev === 'amber'),
     'and 89 days is inside it');

  ok(clinicianFlags({ indemnityExpiry: NOW + INDEMNITY_WARN_DAYS * DAY }, NOW).length === 0,
     '⚑ exactly 30 days of indemnity left is outside the warning');
  ok(clinicianFlags({ indemnityExpiry: NOW + (INDEMNITY_WARN_DAYS - 1) * DAY }, NOW).some(f => f.sev === 'amber'),
     'and 29 days is inside it');

  ok(firmFlags({ piExpiresAt: NOW + INDEMNITY_WARN_DAYS * DAY }, NOW).length === 0,
     'the clinic policy uses the same 30-day edge');
  ok(firmFlags({ piExpiresAt: NOW + (INDEMNITY_WARN_DAYS - 1) * DAY }, NOW).some(f => f.sev === 'amber'),
     'and warns from 29 days');
}

console.log('\n=== §3 · patient flags ===');
{
  ok(patientFlags({ vulnerabilityFlag: true }, 0, NOW).some(f => /Vulnerable/.test(f.msg)), 'a vulnerability flag shows');
  ok(patientFlags({ nextAppointmentAt: NOW - DAY }, 0, NOW).some(f => /Missed/.test(f.msg)), 'a past appointment is a missed one');
  ok(patientFlags({ nextAppointmentAt: NOW + DAY }, 0, NOW).length === 0, 'a future one is not');
  ok(patientFlags({}, 1, NOW).some(f => f.msg === '1 open episode'), 'one episode is singular');
  ok(patientFlags({}, 3, NOW).some(f => f.msg === '3 open episodes'), 'three are plural');
  ok(patientFlags({}, 0, NOW).length === 0, 'no open episodes says nothing');
}

console.log('\n=== §4 · ⚑ THE EMPTY-STRING TRAP ===');
{
  // The original used includes() both ways, and every string contains ''. One blank medication row
  // therefore matched every drug in the table.
  const blank = checkInteractions(['', '   ', null, undefined], 'warfarin');
  ok(blank.interactions.length === 0, '⚑ blank medication rows raise NOTHING — they used to raise everything');
  ok(checkInteractions(['aspirin'], '').interactions.length === 0, 'and an empty proposed drug checks nothing');
  ok(mentions('aspirin', '') === false && mentions('', 'aspirin') === false, 'the empty string is never a mention');
}

console.log('\n=== §5 · ⚑ A ONE-LETTER TYPO IS NOT A DRUG ===');
{
  ok(mentions('aspirin', 'a') === false, '⚑ "a" does not match "aspirin" — substring matching raised severe alerts on nothing');
  ok(mentions('warfarin sodium', 'warfarin') === true, 'but a qualified name still matches the drug');
  ok(mentions('Warfarin', 'warfarin') === true, 'case does not matter');
  ok(mentions('  warfarin  ', 'warfarin') === true, 'nor does padding');
  ok(mentions('aspirin 75mg', 'aspirin') === true, 'a dose after the name still matches');
}

console.log('\n=== §6 · ⚑ INTERACTIONS THAT MUST FIRE ===');
{
  const r = checkInteractions(['aspirin 75mg', 'ramipril'], 'warfarin');
  ok(r.interactions.some(i => i.b === 'aspirin' && i.sev === 'SEVERE'), '⚑ warfarin on top of aspirin is SEVERE and it fires');
  ok(r.checked === 2, 'and it reports how many drugs it actually compared against');

  ok(checkInteractions(['warfarin'], 'aspirin').interactions.length === 1,
     '⚑ the pair fires in BOTH directions — order of prescribing must not hide it');

  const m = checkInteractions(['trimethoprim'], 'methotrexate');
  ok(m.interactions[0].sev === 'SEVERE' && /marrow/i.test(m.interactions[0].note),
     'methotrexate with trimethoprim carries its reason');

  const mixed = checkInteractions(['paracetamol', 'aspirin'], 'warfarin');
  ok(mixed.interactions[0].sev === 'SEVERE', '⚑ SEVERE sorts first — a prescriber must not have to scroll to it');

  ok(checkInteractions(['amoxicillin'], 'warfarin').interactions.length === 0, 'an unrelated drug raises nothing');
  ok(checkInteractions([{ name: 'aspirin' }], 'warfarin').interactions.length === 1, 'medications given as objects still match');
}

console.log('\n=== §6b · ⚑ SEVERE MUST SORT FIRST, PROVABLY ===');
{
  // The gate caught this as an inline ternary nothing could pin: the severe pairs happened to sit
  // earlier in the table anyway, so a broken comparator produced an identical list.
  ok(severityRank('SEVERE') === 0, 'SEVERE leads');
  ok(severityRank('MODERATE') === 1, 'MODERATE follows');
  ok(severityRank('severe') === 0, 'and case does not change the ordering');
  ok(severityRank('MILD') === 2 && severityRank(null) === 2 && severityRank(undefined) === 2,
     '⚑ anything unrecognised sorts LAST but is never dropped — an alert of unknown grade is still an alert');

  const list = [{ sev: 'MODERATE' }, { sev: 'SEVERE' }, { sev: 'WHAT' }, { sev: 'SEVERE' }];
  const order = [...list].sort((a, b) => severityRank(a.sev) - severityRank(b.sev)).map(x => x.sev);
  ok(order.join(',') === 'SEVERE,SEVERE,MODERATE,WHAT', 'sorting by rank puts both severes at the top');
}

console.log('\n=== §7 · ⚑ IT NEVER CLAIMS TO BE THE BNF ===');
{
  for (const r of [checkInteractions([], 'warfarin'), checkInteractions(['aspirin'], 'warfarin')]) {
    ok(r.exhaustive === false, '⚑ every result says exhaustive:false — a clean check is not a clearance');
  }
}

console.log('\n=== §8 · ⚑ THE CONTROLLED-DRUG REGISTER ===');
{
  const reg = [
    { id: 1, drug: 'morphine', tx: 'received', qty: 100 },
    { id: 2, drug: 'morphine', tx: 'supplied', qty: 30 },
    { id: 3, drug: 'morphine', tx: 'destroyed', qty: 10 },
    { id: 4, drug: 'diazepam', tx: 'received', qty: 50 },
  ];
  const m = cdBalance(reg, 'morphine');
  ok(m.balance === 60, 'received 100, supplied 30, destroyed 10 leaves 60');
  ok(m.moves === 3 && m.trustworthy === true, 'three movements, all understood');
  ok(cdBalance(reg, 'diazepam').balance === 50, 'each drug is counted on its own');
  ok(cdBalance(reg, 'MORPHINE').balance === 60, 'the drug name is matched case-insensitively');

  // The one that matters most.
  const typo = cdBalance([...reg, { id: 9, drug: 'morphine', tx: 'suppleid', qty: 40 }], 'morphine');
  ok(typo.balance === 60, '⚑ a typo in the movement does NOT silently remove stock');
  ok(typo.trustworthy === false, '⚑ and the balance declares itself untrustworthy rather than being quietly wrong');
  ok(/unrecognised movement/.test(typo.rejected[0].why) && typo.rejected[0].id === 9,
     'the rejected entry is named, so somebody can go and fix it');

  // Zero is a real number and a real (if pointless) record. It must be ACCEPTED, not rejected:
  // rejecting it would mark the whole register untrustworthy over a harmless row.
  const zero = cdBalance([{ id: 7, drug: 'morphine', tx: 'received', qty: 0 }], 'morphine');
  ok(zero.balance === 0 && zero.moves === 1 && zero.trustworthy === true,
     '⚑ a zero-quantity movement counts as a movement and leaves the register trustworthy');

  const bad = cdBalance([{ drug: 'morphine', tx: 'received', qty: -5 }], 'morphine');
  ok(bad.balance === 0 && bad.trustworthy === false, 'a negative quantity is refused, not added');
  const nan = cdBalance([{ drug: 'morphine', tx: 'received', qty: 'ten' }], 'morphine');
  ok(nan.balance === 0 && nan.trustworthy === false, 'and so is a quantity that is not a number');

  ok(cdBalance(reg, '').balance === 0, 'asking for no drug returns nothing rather than everything');
  ok(cdBalance(null, 'morphine').trustworthy === true && cdBalance(null, 'morphine').balance === 0,
     'an empty register is a trustworthy zero');
  ok(cdUniqueDrugs(reg).join(',') === 'diazepam,morphine', 'the drug list is unique and sorted');
  ok(cdUniqueDrugs([{ drug: '' }, { drug: null }, {}]).length === 0, 'blank drug names are not drugs');
  ok(CD_OUT.includes('destroyed') && CD_OUT.includes('administered'), 'destruction and administration both remove stock');
}

console.log('\n=== §9 · ⚑ THE AUDIT CHAIN, ACTUALLY VERIFIED ===');
{
  const build = async (n) => {
    const out = []; let prev = '';
    for (let i = 0; i < n; i++) {
      const e = { id: 'au' + i, ts: NOW + i, action: 'patient.updated', clinicianId: 'c1', patientId: 'p1', payload: { i }, prevHash: prev };
      e.docHash = await fakeSha(auditPayload(prev, e));
      prev = e.docHash; out.push(e);
    }
    return out;
  };

  const good = await build(4);
  const v = await verifyAuditChain(good, fakeSha);
  ok(v.ok === true && v.entries === 4, 'an untouched log verifies');
  ok((await verifyAuditChain([], fakeSha)).ok === true, 'an empty log verifies, and says it is empty');

  const edited = await build(4);
  edited[2].payload = { i: 'tampered' };
  const t = await verifyAuditChain(edited, fakeSha);
  ok(t.ok === false, '⚑ editing an entry breaks the chain');
  ok(t.brokeAt === 2 && t.id === 'au2', '⚑ and it names the FIRST break — the earliest one is when it happened');
  ok(/altered after it was written/.test(t.reason), 'with a reason a person can act on');

  const unlinked = await build(3);
  unlinked[1].prevHash = 'not-the-previous-hash';
  const u = await verifyAuditChain(unlinked, fakeSha);
  ok(u.ok === false && u.brokeAt === 1 && /prevHash/.test(u.reason), 'unlinking an entry from its parent is caught too');

  const dropped = await build(4); dropped.splice(2, 1);
  ok((await verifyAuditChain(dropped, fakeSha)).ok === false, '⚑ DELETING an entry is caught — that is the point of a chain');

  ok(auditPayload('', { ts: 1, action: 'a' }) !== auditPayload('', { ts: 1, action: 'b' }),
     'two different actions hash different bytes');
  ok(auditPayload('x', { ts: 1 }) !== auditPayload('y', { ts: 1 }),
     'and the previous hash is part of what is signed, or the links mean nothing');

  let threw = null;
  try { await verifyAuditChain(good, null); } catch (e) { threw = e.message; }
  ok(/needs a sha256/.test(String(threw)), 'no hash function is refused loudly, never treated as a pass');
}

console.log('\n=== §10 · pure under garbage ===');
{
  const junk = [null, undefined, '', 0, [], {}, NaN, [null], [{}], 'x'];
  let threw = null;
  for (const j of junk) {
    try {
      daysFromNow(j, j); ageFromDob(j, j); clinicianFlags(j, j); firmFlags(j, j); patientFlags(j, j, j);
      mentions(j, j); checkInteractions(j, j); cdBalance(j, j); cdUniqueDrugs(j); auditPayload(j, j);
    } catch (e) { threw = `${JSON.stringify(j)} → ${e.message}`; }
  }
  ok(threw === null, 'no input throws' + (threw ? ' — ' + threw : ''));
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
