// ═══════════════════════════════════════════════════════════════════════════
// session.js — alle configuratie op één plek
//
// Hier staat WAT er verhandeld wordt en HOE groot. De rest van de app leest
// alleen uit dit bestand; je hoeft nergens anders te zoeken als een symbool
// verandert of een broker andere contractspecificaties heeft.
// ═══════════════════════════════════════════════════════════════════════════

export const FIRM             = process.env.FIRM || 'fundednext';
export const TRADING_ENABLED  = (process.env.TRADING_ENABLED ?? 'true') === 'true';
export const ENFORCE_EXPIRY   = (process.env.ENFORCE_EXPIRY ?? 'false') === 'true';

// ── Risico: VAST BEDRAG PER TRADE ─────────────────────────────────────────
// Niet langer een percentage van de equity, maar een vast bedrag in de valuta
// van de rekening. Reden: bij een kleine rekening dwingt de minimale lotgrootte
// van de broker het percentage toch al vast, en dan is een percentage alleen
// maar een omweg die verhult wat je werkelijk riskeert.
export const RISK_EUR = parseFloat(process.env.RISK_EUR || '20');

// ── Remmen: 0 = UIT ───────────────────────────────────────────────────────
// Bewust uitgezet. Elke trade die binnenkomt wordt genomen; er is geen grens
// op het aantal open posities en geen grens op het totale open risico.
//
// Wat dat betekent, zonder omhaal: bij 8 symbolen x 48 slots kunnen er in
// theorie tientallen posities tegelijk openstaan, elk met RISK_EUR aan risico.
// Twintig open posities is EUR 400 aan risico, en niets in deze code houdt dat
// tegen. Wil je later toch een dak, zet dan MAX_OPEN_POSITIONS of
// MAX_RISK_EUR_TOTAL in Railway op een getal groter dan 0.
export const MAX_OPEN       = parseInt(process.env.MAX_OPEN_POSITIONS || '0', 10);
export const MAX_RISK_TOTAL = parseFloat(process.env.MAX_RISK_EUR_TOTAL || '0');

/** Het risicobedrag voor deze order. De payload doet er niet meer toe. */
export function resolveRisk() {
  return { eur: RISK_EUR, bron: 'RISK_EUR' };
}

export const TRACK_INTERVAL   = parseInt(process.env.TRACK_INTERVAL_SEC  || '60', 10) * 1000;
// Maximaal toegestaan verschil tussen de futures-prijs van TradingView en de
// CFD-prijs van de broker. Klopt de mapping niet (MGC1! -> een Nasdaq-symbool),
// dan is dat verschil enorm en wordt de order geweigerd in plaats van geplaatst.
export const MAX_BASIS_PCT    = parseFloat(process.env.MAX_BASIS_PCT || '5');

// ── Symboolvertaling ───────────────────────────────────────────────────────
// TradingView handelt in futures (MGC1!, MNQ1!), de prop firm in CFD's. De
// prijzen liggen dicht bij elkaar maar zijn niet identiek: er zit een basis
// tussen futures en spot. sl_points en tp_points uit de PineScript zijn
// AFSTANDEN, geen niveaus — die vertalen wél één-op-één. De absolute `entry`,
// `sl` en `tp` uit de payload zijn daarom alleen logging; de echte SL/TP
// worden hier herrekend vanaf de werkelijke MT5-fill.
const FIRMS = {
  fundednext: {
    label: 'FundedNext',
    symbols: {
      'MGC1!': 'XAUUSD',
      'MNQ1!': 'NDX100',
    },
  },
  // Voorbeeld voor een tweede firm — vul in zodra je er een toevoegt.
  ftmo: {
    label: 'FTMO',
    symbols: {
      'MGC1!': 'XAUUSD',
      'MNQ1!': 'US100.cash',
    },
  },
  // Vantage draait LIVE. Nasdaq heet hier NAS100 — niet NDX100 (FundedNext) en
  // niet US100.cash (FTMO). Drie brokers, drie namen voor hetzelfde instrument.
  // Vantage — LIVE. Elke ticker hieronder moet in TradingView op je chart staan
  // EN als symbool bestaan bij Vantage, anders wordt het signaal geweigerd met
  // "geen symboolmapping".
  //
  // MET1! (Micro Ether) staat er BEWUST niet bij. Het enige Ethereum-achtige
  // symbool bij Vantage in deze lijst is ETCUSD, en dat is Ethereum CLASSIC —
  // een andere munt, koers 6.55 tegen 1875 voor Ether. Die mapping zou een
  // basis van 28000% geven. Bestaat er een ETHUSD bij Vantage, voeg die dan hier
  // toe; tot die tijd handelt MET1! niet mee.
  vantage: {
    label: 'Vantage',
    symbols: {
      'MGC1!': 'XAUUSD',    // Micro Gold
      'MNQ1!': 'NAS100',    // Micro Nasdaq
      'SIL1!': 'XAGUSD',    // Micro Silver
      'MCL1!': 'CL-OIL',    // Micro WTI  -> future-CFD, kleinste basis
      'MBT1!': 'BTCUSD',    // Micro Bitcoin
      'MET1!': 'ETHUSD',    // Micro Ether — LET OP: ETHUSD, niet ETCUSD.
                            // ETCUSD is Ethereum Classic, koers ~6.55 tegen
                            // ~1875 voor Ether. Die verwisseling geeft een
                            // basis van 28000% en een volstrekt verkeerde
                            // positiegrootte.
      'GER40': 'GER40',     // DAX
      'UK100': 'UK100',     // FTSE 100
    },
  },
};


// ── Contractspecificaties ──────────────────────────────────────────────────
// Overgenomen uit het MT5 symbool-informatiescherm. De poller controleert deze
// bij het opstarten tegen wat MetaApi teruggeeft en waarschuwt bij verschil —
// een verkeerde tickValue betekent een verkeerde positiegrootte, en dat merk je
// anders pas als het misgaat.
// LET OP — tickValue staat hier in EUR, de valuta van de rekening.
// De rekening luidt in EUR, MT5 rekent winst en verlies in EUR uit, dus moet
// calcLots dat ook doen. Stond hier de USD-waarde, dan rekende de app ~14% te
// groot per punt en werd elke positie navenant te klein — en klopte
// orders.risk_amount niet, waar tracker.js de R-multiples mee deelt.
//
// Gemeten aan een echte fill (NAS100, 0.1 lot, SL 333.73 punten = 28.98 EUR):
//   0.8684 EUR per punt per lot  =  1.0073 USD  bij EURUSD 1.16
//
// Deze waarden drijven mee met EUR/USD. Een paar procent per jaar; loopt de
// koers ver weg, dan hier bijstellen.
// ── Wisselkoersen ─────────────────────────────────────────────────────────
// De rekening luidt in EUR. Symbolen die in USD of GBP afrekenen moeten worden
// omgerekend, anders klopt het risicobedrag niet.
//
// Dit zijn de ENIGE twee getallen die je moet bijstellen als de koersen ver
// weglopen. Alle tickValues eronder worden hieruit berekend. Een paar procent
// drift is onschadelijk; tien procent scheelt tien procent in je positiegrootte.
const EURUSD = 1.16;
const GBPEUR = 1.15;

/**
 * Contractspecificatie uit de MT5-symboolgegevens.
 *
 * Alle velden hieronder zijn AFGELEZEN, niet geraden:
 *   contract  = "Contract grootte"
 *   digits    = "Digits"          -> tickSize = 10^-digits
 *   valuta    = "Winst valuta"
 *   volMin/volMax/volStep = "Minimale/Maximale volume", "Volume stap"
 *
 * tickValue wordt eruit berekend: contract x tickSize, omgerekend naar EUR.
 * Dat is beter dan acht losse getallen intypen — bij een koerswijziging pas je
 * EURUSD aan en schuift alles mee.
 *
 * Gecontroleerd: NAS100 toont in MT5 expliciet tickValue 0.01 USD, en een echte
 * fill (0.1 lot, SL 333.73 punten = 28.98 EUR) bevestigt dezelfde uitkomst.
 */
function spec({ contract, digits, valuta, volMin, volMax, volStep }) {
  const tickSize = Math.pow(10, -digits);
  const fx       = valuta === 'USD' ? 1 / EURUSD : valuta === 'GBP' ? GBPEUR : 1;
  return {
    tickSize,
    tickValue: +(contract * tickSize * fx).toFixed(8),
    volMin, volMax, volStep,
    digits,
    contract, valuta,          // alleen ter controle in /health en de bootlog
  };
}

export const SPECS = {
  // ── FundedNext / FTMO (ongewijzigd, USD-rekening) ────────────────────────
  NDX100: { tickSize: 0.01, tickValue: 0.1, volMin: 0.01, volMax: 40, volStep: 0.01, digits: 2 },
  'US100.cash': { tickSize: 0.01, tickValue: 0.1, volMin: 0.01, volMax: 40, volStep: 0.01, digits: 2 },

  // ── Vantage — alles afgelezen uit het MT5 symbool-informatiescherm ───────
  XAUUSD:   spec({ contract:  100, digits: 2, valuta: 'USD', volMin: 0.01, volMax: 100, volStep: 0.01 }),
  XAGUSD:   spec({ contract: 5000, digits: 3, valuta: 'USD', volMin: 0.01, volMax:  20, volStep: 0.01 }),
  NAS100:   spec({ contract:    1, digits: 2, valuta: 'USD', volMin: 0.10, volMax: 500, volStep: 0.10 }),
  'CL-OIL': spec({ contract: 1000, digits: 3, valuta: 'USD', volMin: 0.01, volMax:  20, volStep: 0.01 }),
  BTCUSD:   spec({ contract:    1, digits: 2, valuta: 'USD', volMin: 0.01, volMax: 100, volStep: 0.01 }),
  ETHUSD:   spec({ contract:    1, digits: 2, valuta: 'USD', volMin: 0.01, volMax: 100, volStep: 0.01 }),
  GER40:    spec({ contract:    1, digits: 2, valuta: 'EUR', volMin: 0.10, volMax: 500, volStep: 0.10 }),
  UK100:    spec({ contract:    1, digits: 2, valuta: 'GBP', volMin: 0.10, volMax: 500, volStep: 0.10 }),
};



/** Alleen de symbolen die deze firm daadwerkelijk gebruikt. De opstartcontrole
 *  liep eerst over ALLE specs heen, inclusief die van een andere firm — vandaar
 *  de "US100.cash niet gevonden" ruis bij FundedNext. */
export function actieveSymbolen() {
  return [...new Set(Object.values(firmConfig().symbols))];
}

export function firmConfig() {
  const f = FIRMS[FIRM];
  if (!f) throw new Error(`Onbekende FIRM "${FIRM}". Bekend: ${Object.keys(FIRMS).join(', ')}`);
  return f;
}

/** TradingView-ticker -> MT5-symbool. Onbekend = null (signaal wordt geweigerd). */
export function mapSymbol(tvSymbol) {
  const f = firmConfig();
  return f.symbols[tvSymbol] || f.symbols[String(tvSymbol).toUpperCase()] || null;
}

/**
 * Positiegrootte uit risico en stopafstand.
 *
 *   waarde van 1.0 prijsbeweging per lot = tickValue / tickSize
 *   XAUUSD : 1.00 / 0.01 = 100 USD per 1.00 dollar goudbeweging per lot
 *   NDX100 : 0.10 / 0.01 =  10 USD per 1.00 indexpunt per lot
 *
 * lots = risicobedrag / (stopafstand × waarde per prijsbeweging)
 */
export function calcLots({ symbol, riskEur, slPoints }) {
  const spec = SPECS[symbol];
  if (!spec) return { lots: null, reason: `geen contractspecificatie voor ${symbol}` };
  if (!(slPoints > 0)) return { lots: null, reason: `ongeldige sl_points: ${slPoints}` };

  const valuePerUnit = spec.tickValue / spec.tickSize;   // bedrag per 1.0 prijsbeweging per lot
  const raw          = riskEur / (slPoints * valuePerUnit);

  // Naar beneden afronden op volStep: liever iets minder risico dan iets meer.
  // De +1e-9 vangt drijvende-kommaruis: 0.3 / 0.1 geeft in JavaScript
  // 2.9999999999999996, en dan zou Math.floor er 2 stappen van maken.
  const steps = Math.floor(raw / spec.volStep + 1e-9);
  let   lots  = +(steps * spec.volStep).toFixed(8);

  // ── Stop te wijd voor het risicobedrag ──────────────────────────────────
  // Vroeger werd de order hier geweigerd. Nu niet meer: we nemen het minimum
  // lot en accepteren dat het risico HOGER uitvalt dan RISK_EUR. Dat is een
  // bewuste keuze — bij een brede stop is dit een swing waar je zelf naar kijkt.
  //
  // Het werkelijke risico wordt teruggegeven en weggeschreven, zodat je
  // achteraf kunt zien welke trades boven het bedrag uitkwamen en hoeveel.
  // Zonder die registratie zou een 34-euro trade er in de statistiek uitzien
  // als een 20-euro trade, en klopt elke R-multiple niet meer.
  let forced = false;
  if (lots < spec.volMin) {
    lots   = spec.volMin;
    forced = true;
  }
  if (lots > spec.volMax) lots = spec.volMax;

  // Wat er ECHT op het spel staat bij deze lotgrootte.
  const riskAmount = +(lots * slPoints * valuePerUnit).toFixed(2);

  return {
    lots,
    riskAmount,          // werkelijk risico in rekeningvaluta
    riskTarget: riskEur, // wat je vroeg
    forced,              // true = minimum lot afgedwongen, risico is hoger
    valuePerUnit,
    raw,
  };
}

/** Bedrag dat één prijsbeweging waard is — gebruikt om R uit te rekenen bij close. */
export function valuePerUnit(symbol) {
  const spec = SPECS[symbol];
  return spec ? spec.tickValue / spec.tickSize : null;
}

/**
 * Futures -> CFD omrekening.
 *
 * TradingView rekent op MGC1! / MNQ1!, de order gaat naar XAUUSD / NDX100.
 * Daar zit een basis tussen: bij goud een paar tienden van een procent, bij
 * Nasdaq al snel 1,5–2%. Een stopafstand van 100 futurespunten is op de CFD dus
 * NIET 100 punten — hij is 100/28620 = 0,3494% van de prijs, en dat percentage
 * toegepast op 29100 geeft 101,7 punten.
 *
 * Daarom wordt alles als PERCENTAGE overgezet en pas op de werkelijke MT5-prijs
 * weer in punten omgerekend. De multiplier zit al in sl_points verwerkt door de
 * PineScript; hier wordt alleen geschaald, nooit vermenigvuldigd.
 */
export function convertToMt5({ tvEntry, mt5Ref, slPointsTv, tpPointsTv }) {
  const tv = parseFloat(tvEntry);
  if (!(tv > 0) || !(mt5Ref > 0)) {
    // Zonder geldige TV-prijs kunnen we niet schalen; dan maar 1-op-1, en dat
    // wordt zo gelogd zodat het achteraf zichtbaar is.
    return {
      ratio: 1, basis: null, basisPct: null,
      slPct: null, tpPct: null,
      slPointsMt5: slPointsTv, tpPointsMt5: tpPointsTv,
      scaled: false,
    };
  }
  const ratio    = mt5Ref / tv;
  const slPct    = slPointsTv / tv;          // fractie van de prijs
  const tpPct    = tpPointsTv / tv;
  return {
    ratio,
    basis:    +(mt5Ref - tv).toFixed(5),
    basisPct: +(ratio - 1).toFixed(8),
    slPct:    +slPct.toFixed(8),
    tpPct:    +tpPct.toFixed(8),
    slPointsMt5: +(mt5Ref * slPct).toFixed(5),
    tpPointsMt5: +(mt5Ref * tpPct).toFixed(5),
    scaled: true,
  };
}

/** Schaalt een los prijsniveau (ORB-hoog, VWAP, ...) mee naar CFD-schaal. */
export function scaleLevel(level, ratio) {
  const v = parseFloat(level);
  return (v > 0 && ratio > 0) ? +(v * ratio).toFixed(5) : null;
}
