import { useState, useEffect, useCallback } from 'react'

// ---------------------------------------------------------------------------
// InvestingPanel — "Grow My Money" / Investing Guide
//
// Talks to the deterministic backend engine (investing_guide_routes.py +
// investing_scenarios_data.py) — a 5-question quiz drives a hardcoded
// 243-scenario lookup table. No LLM call is ever made for the
// recommendation itself; every score, ranking, exclusion reason, and
// piece of guide content comes straight from the API response.
//
// Phases: 'loading' -> 'quiz' (no saved profile) or 'results' (profile
// exists) -> 'detail' (an asset card was opened). Language is a single
// piece of state shared across quiz, results, and detail so switching
// languages never requires a re-fetch — the API already returns all 3
// languages for every string.
// ---------------------------------------------------------------------------

const LANGUAGES = [
  { value: 'en', label: 'English', dir: 'ltr' },
  { value: 'ur_roman', label: 'Roman Urdu', dir: 'ltr' },
  { value: 'ur', label: 'اردو', dir: 'rtl' },
]

const ASSET_ICONS = {
  stocks: 'fa-chart-line',
  mutual_funds: 'fa-layer-group',
  government_bonds: 'fa-landmark',
  gold: 'fa-coins',
  fixed_deposits: 'fa-piggy-bank',
  crypto: 'fa-bitcoin-sign',
}

// Risk-level -> badge color tokens (asset's own risk.level, e.g. "Medium-High").
const RISK_STYLES = {
  Low: { bg: '#ECFDF5', text: '#047857', ring: '#A7F3D0' },
  Medium: { bg: '#FFFBEB', text: '#B45309', ring: '#FDE68A' },
  'Medium-High': { bg: '#FFF7ED', text: '#C2410C', ring: '#FED7AA' },
  High: { bg: '#FEF2F2', text: '#B91C1C', ring: '#FECACA' },
}

// Suitability-score (0-100) -> gauge fill color band.
function suitabilityColor(score) {
  if (score >= 70) return '#10B981'
  if (score >= 40) return '#F59E0B'
  return '#EF4444'
}

// Core brand colors — #532B88 is the app's primary purple; the CSS
// variable is preferred when set, with that exact value as the fallback
// so this panel always renders on-brand even if --primary-purple isn't
// defined yet in a given build.
const PURPLE = 'var(--primary-purple, #532B88)'
const PURPLE_SOFT = 'var(--primary-purple-soft, #F1ECFA)'
const GRAY_BG = '#F3F4F6'
const GRAY_BG_SOFT = '#F9FAFB'
const GRAY_TEXT = '#6B7280'
const GRAY_TEXT_DARK = '#374151'
const GRAY_LABEL = '#9CA3AF'
const RED_BG = '#FEF2F2'
const RED_TEXT = '#B91C1C'
const RED_RING = '#FECACA'

const SECTION_LABELS = {
  en: {
    whatIsIt: 'What is it?',
    howToInvestPk: 'How to Invest in Pakistan',
    generalSteps: 'General Steps',
    risk: 'Risk Level',
    minCapital: 'Minimum Amount',
    whyExcluded: 'Why this is excluded for you',
    thingsToKeepInMind: 'Things to keep in mind',
  },
  ur_roman: {
    whatIsIt: 'Yeh Kya Hai?',
    howToInvestPk: 'Pakistan Mein Kaise Invest Karein',
    generalSteps: 'Aam Qadam',
    risk: 'Risk Level',
    minCapital: 'Kam Az Kam Raqam',
    whyExcluded: 'Yeh aapke liye kyun exclude hai',
    thingsToKeepInMind: 'Dhyan mein rakhne wali baatein',
  },
  ur: {
    whatIsIt: 'یہ کیا ہے؟',
    howToInvestPk: 'پاکستان میں کیسے سرمایہ کاری کریں',
    generalSteps: 'عمومی مراحل',
    risk: 'خطرے کی سطح',
    minCapital: 'کم از کم رقم',
    whyExcluded: 'یہ آپ کے لیے کیوں خارج ہے',
    thingsToKeepInMind: 'دھیان میں رکھنے والی باتیں',
  },
}

const UI_TEXT = {
  en: {
    heading: 'Investing',
    quizIntro: "A few quick questions so we can match you to the right options — takes under a minute.",
    step: 'Step',
    of: 'of',
    back: 'Back',
    next: 'Next',
    seeMyResults: 'See My Results',
    resultsHeading: 'Your Investing Matches',
    resultsSubtitle: 'Based on your answers — tap any card for the full guide.',
    topPicks: 'Top Picks For You',
    excludedHeading: 'Not Recommended Right Now',
    allOptions: 'All Options',
    retake: 'Retake Assessment',
    excludedBadge: 'Excluded',
    tapForWhy: 'Tap for why',
    viewFullGuide: 'View full guide',
    loading: 'Loading...',
  },
  ur_roman: {
    heading: 'Investing',
    quizIntro: 'Chand jaldi sawalat, taake hum aapko sahi options se match kar sakein — aik minute se kam lagega.',
    step: 'Sawal',
    of: 'mein se',
    back: 'Peechay',
    next: 'Agla',
    seeMyResults: 'Mere Results Dekhein',
    resultsHeading: 'Aapke Investing Matches',
    resultsSubtitle: 'Aapke jawabaat ke mutabiq — poori guide ke liye kisi bhi card par tap karein.',
    topPicks: 'Aapke Liye Behtareen',
    excludedHeading: 'Abhi Recommend Nahi',
    allOptions: 'Tamam Options',
    retake: 'Dobara Assessment Lein',
    excludedBadge: 'Excluded',
    tapForWhy: 'Wajah ke liye tap karein',
    viewFullGuide: 'Poori guide dekhein',
    loading: 'Load ho raha hai...',
  },
  ur: {
    heading: 'انویسٹنگ',
    quizIntro: 'چند فوری سوالات، تاکہ ہم آپ کو صحیح آپشنز سے میچ کر سکیں — ایک منٹ سے کم لگے گا۔',
    step: 'سوال',
    of: 'میں سے',
    back: 'پیچھے',
    next: 'اگلا',
    seeMyResults: 'میرے نتائج دیکھیں',
    resultsHeading: 'آپ کے انویسٹنگ میچز',
    resultsSubtitle: 'آپ کے جوابات کے مطابق — مکمل گائیڈ کے لیے کسی بھی کارڈ پر ٹیپ کریں۔',
    topPicks: 'آپ کے لیے بہترین',
    excludedHeading: 'فی الحال تجویز کردہ نہیں',
    allOptions: 'تمام آپشنز',
    retake: 'دوبارہ جائزہ لیں',
    excludedBadge: 'خارج',
    tapForWhy: 'وجہ کے لیے ٹیپ کریں',
    viewFullGuide: 'مکمل گائیڈ دیکھیں',
    loading: 'لوڈ ہو رہا ہے...',
  },
}

const DISCLAIMER = {
  en: 'This is educational information, not formal financial advice.',
  ur_roman: 'Yeh sirf maloomat ke liye hai, koi rasmi financial advice nahi.',
  ur: 'یہ صرف تعلیمی معلومات ہیں، کوئی باقاعدہ مالی مشورہ نہیں۔',
}

function dirOf(language) {
  return LANGUAGES.find((l) => l.value === language)?.dir || 'ltr'
}

async function fetchJSON(url, options) {
  const res = await fetch(url, { credentials: 'include', ...options })
  let data = null
  try {
    data = await res.json()
  } catch {
    // no JSON body
  }
  return { ok: res.ok, status: res.status, data }
}

// ---------------------------------------------------------------------------
// Inline style objects — matches the app's existing Savings/Goals section:
// rounded cards, soft gray section backgrounds, purple accents.
// ---------------------------------------------------------------------------
const S = {
  outer: { width: '100%' },
  card: {
    backgroundColor: '#fff',
    borderRadius: '24px',
    padding: '32px',
    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
  },
  headingWrap: { textAlign: 'center', marginBottom: '24px' },
  heading: { fontSize: '24px', fontWeight: 700, color: PURPLE, margin: 0 },
  subtitle: {
    fontSize: '14px',
    color: GRAY_TEXT,
    marginTop: '8px',
    maxWidth: '440px',
    marginLeft: 'auto',
    marginRight: 'auto',
    lineHeight: 1.5,
  },

  // Quiz
  progressWrap: { display: 'flex', gap: '6px', marginBottom: '24px' },
  progressDot: (active) => ({
    flex: 1,
    height: '6px',
    borderRadius: '999px',
    backgroundColor: active ? PURPLE : GRAY_BG,
    transition: 'background-color 0.2s ease',
  }),
  stepLabel: { fontSize: '12px', fontWeight: 600, color: GRAY_LABEL, marginBottom: '6px', textAlign: 'center' },
  questionText: { fontSize: '19px', fontWeight: 700, color: GRAY_TEXT_DARK, textAlign: 'center', marginBottom: '24px', lineHeight: 1.4 },
  optionList: { display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' },
  optionCard: (selected) => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    textAlign: 'left',
    padding: '18px 20px',
    borderRadius: '16px',
    border: selected ? `2px solid ${PURPLE}` : '2px solid transparent',
    backgroundColor: selected ? PURPLE_SOFT : GRAY_BG,
    color: selected ? PURPLE : GRAY_TEXT_DARK,
    fontSize: '15px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  }),
  quizNavRow: { display: 'flex', gap: '12px', marginTop: '4px' },
  ghostButton: {
    flex: 1,
    padding: '14px',
    borderRadius: '14px',
    border: `1.5px solid ${GRAY_BG}`,
    backgroundColor: '#fff',
    color: GRAY_TEXT_DARK,
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  primaryButton: {
    flex: 1,
    padding: '14px',
    borderRadius: '14px',
    border: 'none',
    backgroundColor: PURPLE,
    color: '#fff',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  primaryButtonDisabled: {
    flex: 1,
    padding: '14px',
    borderRadius: '14px',
    border: 'none',
    backgroundColor: GRAY_BG,
    color: GRAY_LABEL,
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'not-allowed',
    fontFamily: 'inherit',
  },

  // Results
  resultsSectionLabel: {
    fontSize: '13px',
    fontWeight: 700,
    color: GRAY_TEXT_DARK,
    marginBottom: '12px',
    marginTop: '24px',
  },
  topGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '14px' },
  assetGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '14px' },
  assetCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    backgroundColor: GRAY_BG,
    borderRadius: '16px',
    padding: '16px',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    position: 'relative',
  },
  assetCardTopRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  assetCardIcon: { fontSize: '18px', color: PURPLE },
  rankBadge: {
    fontSize: '10px',
    fontWeight: 700,
    color: '#fff',
    backgroundColor: PURPLE,
    borderRadius: '999px',
    padding: '2px 8px',
  },
  assetCardLabel: { fontSize: '14px', fontWeight: 700, color: GRAY_TEXT_DARK },
  gaugeTrack: { width: '100%', height: '6px', borderRadius: '999px', backgroundColor: '#E5E7EB', overflow: 'hidden' },
  gaugeFill: (pct, color) => ({ width: `${pct}%`, height: '100%', backgroundColor: color, borderRadius: '999px' }),
  gaugeLabel: { fontSize: '11px', fontWeight: 600, color: GRAY_LABEL },

  excludedRow: { display: 'flex', flexWrap: 'wrap', gap: '10px' },
  excludedBadgeButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 14px',
    borderRadius: '999px',
    backgroundColor: RED_BG,
    border: `1px solid ${RED_RING}`,
    color: RED_TEXT,
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  tooltipPopover: {
    position: 'absolute',
    zIndex: 10,
    top: 'calc(100% + 8px)',
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    borderRadius: '12px',
    padding: '14px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
    border: `1px solid ${GRAY_BG}`,
  },
  tooltipReason: { fontSize: '12.5px', color: GRAY_TEXT_DARK, lineHeight: 1.5, margin: 0, marginBottom: '6px' },

  retakeButton: {
    display: 'block',
    margin: '28px auto 0',
    padding: '10px 20px',
    borderRadius: '999px',
    border: `1.5px solid ${GRAY_BG}`,
    backgroundColor: '#fff',
    color: GRAY_TEXT,
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  // Detail
  backButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '14px',
    fontWeight: 500,
    color: GRAY_TEXT,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    marginBottom: '20px',
    padding: 0,
    fontFamily: 'inherit',
  },
  detailHeaderWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: '20px' },
  detailIconCircle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '56px',
    height: '56px',
    borderRadius: '16px',
    backgroundColor: GRAY_BG,
    color: PURPLE,
    fontSize: '22px',
    marginBottom: '12px',
  },
  detailTitle: { fontSize: '20px', fontWeight: 700, color: PURPLE, margin: 0 },
  detailBadgeRow: { display: 'flex', gap: '8px', marginTop: '10px' },
  langSwitchWrap: { display: 'flex', justifyContent: 'center', marginBottom: '24px' },
  langSwitch: { display: 'inline-flex', padding: '4px', borderRadius: '999px', backgroundColor: GRAY_BG },
  langButton: (active) => ({
    padding: '7px 16px',
    borderRadius: '999px',
    fontSize: '13px',
    fontWeight: 500,
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    backgroundColor: active ? '#fff' : 'transparent',
    color: active ? PURPLE : GRAY_TEXT,
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
  }),
  section: { backgroundColor: GRAY_BG_SOFT, borderRadius: '16px', padding: '20px', marginBottom: '14px' },
  warningSection: { backgroundColor: RED_BG, borderRadius: '16px', padding: '20px', marginBottom: '14px' },
  sectionLabel: { fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: GRAY_LABEL, marginBottom: '10px' },
  warningSectionLabel: { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: RED_TEXT, marginBottom: '10px' },
  sectionLabelRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' },
  bodyText: { color: GRAY_TEXT_DARK, lineHeight: 1.65, margin: 0, fontSize: '14.5px' },
  reasonList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' },
  reasonRow: (rtl) => ({ display: 'flex', flexDirection: rtl ? 'row-reverse' : 'row', alignItems: 'flex-start', gap: '10px' }),
  reasonBullet: { flexShrink: 0, color: RED_TEXT, fontSize: '13px', marginTop: '3px' },
  reasonText: { color: '#7F1D1D', lineHeight: 1.6, fontSize: '14px' },
  stepList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '12px' },
  stepRow: (rtl) => ({ display: 'flex', flexDirection: rtl ? 'row-reverse' : 'row', alignItems: 'flex-start', gap: '12px' }),
  stepNumber: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    borderRadius: '999px',
    backgroundColor: PURPLE,
    color: '#fff',
    fontSize: '11px',
    fontWeight: 700,
    marginTop: '2px',
  },
  stepText: { color: GRAY_TEXT_DARK, lineHeight: 1.6, fontSize: '14.5px' },
  minCapitalText: { color: GRAY_TEXT_DARK, fontWeight: 600, lineHeight: 1.5, margin: 0, fontSize: '14.5px' },
  disclaimer: { textAlign: 'center', fontSize: '12px', color: GRAY_LABEL, marginTop: '4px' },
  centerNote: { textAlign: 'center', color: GRAY_TEXT, fontSize: '14px', padding: '24px 0' },
  footNoteDisclaimer: { textAlign: 'center', fontSize: '12px', color: GRAY_LABEL, marginTop: '24px' },
}

function riskBadgeStyle(level) {
  const style = RISK_STYLES[level] || RISK_STYLES.Medium
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 12px',
    borderRadius: '999px',
    fontSize: '13px',
    fontWeight: 600,
    backgroundColor: style.bg,
    color: style.text,
    border: `1px solid ${style.ring}`,
  }
}

function LanguageSwitch({ value, onChange }) {
  return (
    <div style={S.langSwitch}>
      {LANGUAGES.map((lang) => (
        <button
          key={lang.value}
          type="button"
          onClick={() => onChange(lang.value)}
          aria-pressed={lang.value === value}
          style={S.langButton(lang.value === value)}
        >
          {lang.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quiz — one question per screen, 5 total, driven entirely by the
// `questions` array returned from GET /api/investing/questions.
// ---------------------------------------------------------------------------
function Quiz({ questions, language, ui, onComplete }) {
  const [stepIndex, setStepIndex] = useState(0)
  const [answers, setAnswers] = useState({})
  const isRtl = dirOf(language) === 'rtl'

  const question = questions[stepIndex]
  const isLast = stepIndex === questions.length - 1
  const selectedValue = answers[question.id]

  function selectOption(value) {
    setAnswers((prev) => ({ ...prev, [question.id]: value }))
  }

  function goNext() {
    if (isLast) {
      onComplete(answers)
    } else {
      setStepIndex((i) => i + 1)
    }
  }

  function goBack() {
    setStepIndex((i) => Math.max(0, i - 1))
  }

  return (
    <div dir={dirOf(language)} lang={language === 'ur' ? 'ur' : 'en'}>
      <div style={S.progressWrap}>
        {questions.map((q, i) => (
          <div key={q.id} style={S.progressDot(i <= stepIndex)} />
        ))}
      </div>
      <p style={S.stepLabel}>
        {ui.step} {stepIndex + 1} {ui.of} {questions.length}
      </p>
      <h2 style={S.questionText}>{question.prompt[language]}</h2>

      <div style={S.optionList}>
        {question.options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => selectOption(opt.value)}
            style={S.optionCard(selectedValue === opt.value)}
          >
            <span>{opt.label[language]}</span>
            {selectedValue === opt.value && <i className="fa-solid fa-circle-check" aria-hidden="true" />}
          </button>
        ))}
      </div>

      <div style={{ ...S.quizNavRow, flexDirection: isRtl ? 'row-reverse' : 'row' }}>
        {stepIndex > 0 && (
          <button type="button" onClick={goBack} style={S.ghostButton}>
            {ui.back}
          </button>
        )}
        <button
          type="button"
          onClick={goNext}
          disabled={!selectedValue}
          style={selectedValue ? S.primaryButton : S.primaryButtonDisabled}
        >
          {isLast ? ui.seeMyResults : ui.next}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Suitability gauge — small horizontal bar, colored by score band.
// ---------------------------------------------------------------------------
function SuitabilityGauge({ score }) {
  return (
    <div>
      <div style={S.gaugeTrack}>
        <div style={S.gaugeFill(score, suitabilityColor(score))} />
      </div>
      <p style={S.gaugeLabel}>{score}%</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Excluded badge with a tap-to-toggle reasons popover (works on touch,
// unlike a pure CSS :hover tooltip).
// ---------------------------------------------------------------------------
function ExcludedBadge({ assetBlock, language, ui, isRtl, onOpenDetail }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" style={S.excludedBadgeButton} onClick={() => setOpen((o) => !o)}>
        <i className={`fa-solid ${ASSET_ICONS[assetBlock.asset]}`} aria-hidden="true" />
        <span>{assetBlock.label[language]}</span>
        <i className="fa-solid fa-circle-info" aria-hidden="true" style={{ fontSize: '11px' }} />
      </button>
      {open && (
        <div style={S.tooltipPopover} dir={dirOf(language)}>
          <ul style={{ ...S.reasonList, marginBottom: '10px' }}>
            {assetBlock.exclusion_reasons.map((reason, i) => (
              <li key={i} style={S.reasonRow(isRtl)}>
                <span style={S.reasonBullet}>•</span>
                <span style={S.reasonText}>{reason[language]}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => onOpenDetail(assetBlock.asset)}
            style={{ ...S.ghostButton, padding: '8px', fontSize: '12.5px' }}
          >
            {ui.viewFullGuide}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Results screen — Top 3 badges w/ gauges, Excluded row w/ tooltips,
// full 6-asset grid. Every asset card opens the detail view.
// ---------------------------------------------------------------------------
function ResultsScreen({ results, language, ui, onOpenDetail, onRetake }) {
  const isRtl = dirOf(language) === 'rtl'
  const { top3, excluded, assets } = results
  const topAssets = top3.map((key) => assets[key])
  const excludedAssets = excluded.map((key) => assets[key])
  const allAssetKeys = Object.keys(assets)

  return (
    <div dir={dirOf(language)} lang={language === 'ur' ? 'ur' : 'en'}>
      <div style={S.headingWrap}>
        <h1 style={S.heading}>{ui.resultsHeading}</h1>
        <p style={S.subtitle}>{ui.resultsSubtitle}</p>
      </div>

      <h3 style={S.resultsSectionLabel}>{ui.topPicks}</h3>
      <div className="investing-type-grid" style={S.topGrid}>
        {topAssets.map((asset) => (
          <button key={asset.asset} type="button" style={S.assetCard} onClick={() => onOpenDetail(asset.asset)}>
            <div style={S.assetCardTopRow}>
              <i className={`fa-solid ${ASSET_ICONS[asset.asset]}`} style={S.assetCardIcon} aria-hidden="true" />
              <span style={S.rankBadge}>#{asset.rank}</span>
            </div>
            <span style={S.assetCardLabel}>{asset.label[language]}</span>
            <SuitabilityGauge score={asset.suitability_score} />
          </button>
        ))}
      </div>

      {excludedAssets.length > 0 && (
        <>
          <h3 style={S.resultsSectionLabel}>{ui.excludedHeading}</h3>
          <div style={S.excludedRow}>
            {excludedAssets.map((asset) => (
              <ExcludedBadge
                key={asset.asset}
                assetBlock={asset}
                language={language}
                ui={ui}
                isRtl={isRtl}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </div>
        </>
      )}

      <h3 style={S.resultsSectionLabel}>{ui.allOptions}</h3>
      <div className="investing-type-grid" style={S.assetGrid}>
        {allAssetKeys.map((key) => {
          const asset = assets[key]
          return (
            <button key={key} type="button" style={S.assetCard} onClick={() => onOpenDetail(key)}>
              <div style={S.assetCardTopRow}>
                <i className={`fa-solid ${ASSET_ICONS[key]}`} style={S.assetCardIcon} aria-hidden="true" />
                {asset.rank && <span style={S.rankBadge}>#{asset.rank}</span>}
                {asset.excluded && (
                  <span style={{ ...S.rankBadge, backgroundColor: RED_TEXT }}>{ui.excludedBadge}</span>
                )}
              </div>
              <span style={S.assetCardLabel}>{asset.label[language]}</span>
              <SuitabilityGauge score={asset.suitability_score} />
            </button>
          )
        })}
      </div>

      <p style={S.footNoteDisclaimer}>{DISCLAIMER[language]}</p>

      <button type="button" style={S.retakeButton} onClick={onRetake}>
        <i className="fa-solid fa-rotate-left" style={{ marginRight: '6px' }} aria-hidden="true" />
        {ui.retake}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Asset detail view — What is it / How to Invest in Pakistan / General
// Steps / Risk / Min Capital, plus either exclusion reasons (red warning
// section, shown first) or scenario advisories (also a warning-styled
// section, for included-but-cautioned assets).
// ---------------------------------------------------------------------------
function AssetDetailView({ assetBlock, language, setLanguage, onClose }) {
  const labels = SECTION_LABELS[language]
  const isRtl = dirOf(language) === 'rtl'
  const guide = assetBlock.guide[language]

  return (
    <div dir={dirOf(language)} lang={language === 'ur' ? 'ur' : 'en'}>
      <button type="button" onClick={onClose} style={S.backButton}>
        <i className="fa-solid fa-arrow-left" aria-hidden="true" />
        Back
      </button>

      <div style={S.detailHeaderWrap}>
        <span style={S.detailIconCircle}>
          <i className={`fa-solid ${ASSET_ICONS[assetBlock.asset]}`} aria-hidden="true" />
        </span>
        <h2 style={S.detailTitle}>{assetBlock.label[language]}</h2>
        <div style={S.detailBadgeRow}>
          {assetBlock.rank && <span style={S.rankBadge}>#{assetBlock.rank} Match</span>}
          {assetBlock.excluded && (
            <span style={{ ...S.rankBadge, backgroundColor: RED_TEXT }}>Excluded</span>
          )}
        </div>
      </div>

      <div style={S.langSwitchWrap}>
        <LanguageSwitch value={language} onChange={setLanguage} />
      </div>

      <div dir={dirOf(language)} lang={language === 'ur' ? 'ur' : 'en'} style={{ textAlign: isRtl ? 'right' : 'left' }}>
        {/* Exclusion reasons (only when excluded) */}
        {assetBlock.excluded && assetBlock.exclusion_reasons.length > 0 && (
          <section style={S.warningSection}>
            <h3 style={S.warningSectionLabel}>{labels.whyExcluded}</h3>
            <ul style={S.reasonList}>
              {assetBlock.exclusion_reasons.map((reason, i) => (
                <li key={i} style={S.reasonRow(isRtl)}>
                  <span style={S.reasonBullet}>•</span>
                  <span style={S.reasonText}>{reason[language]}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Scenario advisories (only when included but a caution applies) */}
        {!assetBlock.excluded && assetBlock.advisories.length > 0 && (
          <section style={S.warningSection}>
            <h3 style={S.warningSectionLabel}>{labels.thingsToKeepInMind}</h3>
            <ul style={S.reasonList}>
              {assetBlock.advisories.map((advisory, i) => (
                <li key={i} style={S.reasonRow(isRtl)}>
                  <span style={S.reasonBullet}>•</span>
                  <span style={S.reasonText}>{advisory[language]}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* What is it? */}
        <section style={S.section}>
          <h3 style={S.sectionLabel}>{labels.whatIsIt}</h3>
          <p style={S.bodyText}>{guide.what_is_it}</p>
        </section>

        {/* How to Invest in Pakistan — named platforms */}
        <section style={S.section}>
          <h3 style={S.sectionLabel}>{labels.howToInvestPk}</h3>
          <ol style={S.stepList}>
            {guide.how_to_invest_pk.map((step, i) => (
              <li key={i} style={S.stepRow(isRtl)}>
                <span style={S.stepNumber}>{i + 1}</span>
                <span style={S.stepText}>{step}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* General steps */}
        <section style={S.section}>
          <h3 style={S.sectionLabel}>{labels.generalSteps}</h3>
          <ol style={S.stepList}>
            {guide.general_steps.map((step, i) => (
              <li key={i} style={S.stepRow(isRtl)}>
                <span style={S.stepNumber}>{i + 1}</span>
                <span style={S.stepText}>{step}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* Risk */}
        <section style={S.section}>
          <div style={{ ...S.sectionLabelRow, flexDirection: isRtl ? 'row-reverse' : 'row' }}>
            <h3 style={{ ...S.sectionLabel, marginBottom: 0 }}>{labels.risk}</h3>
            <span style={riskBadgeStyle(guide.risk.level)}>{guide.risk.level}</span>
          </div>
          <p style={{ ...S.bodyText, marginTop: '10px' }}>{guide.risk.note}</p>
        </section>

        {/* Minimum Amount */}
        <section style={{ ...S.section, marginBottom: '20px' }}>
          <h3 style={S.sectionLabel}>{labels.minCapital}</h3>
          <p style={S.minCapitalText}>{guide.min_capital}</p>
        </section>

        <p style={S.disclaimer}>{DISCLAIMER[language]}</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function InvestingPanel() {
  const [phase, setPhase] = useState('loading') // 'loading' | 'quiz' | 'results' | 'detail' | 'error'
  const [language, setLanguage] = useState('en')
  const [questions, setQuestions] = useState([])
  const [results, setResults] = useState(null)
  const [selectedAssetKey, setSelectedAssetKey] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')

  const ui = UI_TEXT[language]

  const loadInitialState = useCallback(async () => {
    setPhase('loading')
    const guideRes = await fetchJSON('/api/investing/guide')

    if (guideRes.ok && guideRes.data?.success) {
      setResults(guideRes.data)
      setPhase('results')
      return
    }

    // No saved profile (404) — load the quiz questions.
    const questionsRes = await fetchJSON('/api/investing/questions')
    if (questionsRes.ok && questionsRes.data?.success) {
      setQuestions(questionsRes.data.questions)
      setPhase('quiz')
    } else {
      setErrorMessage('Could not load the Investing Guide right now. Please try again shortly.')
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    loadInitialState()
  }, [loadInitialState])

  async function handleQuizComplete(answers) {
    setPhase('loading')
    const res = await fetchJSON('/api/investing/guide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(answers),
    })
    if (res.ok && res.data?.success) {
      setResults(res.data)
      setPhase('results')
    } else {
      setErrorMessage(res.data?.message || 'Something went wrong submitting your answers. Please try again.')
      setPhase('error')
    }
  }

  async function handleRetake() {
    setPhase('loading')
    await fetchJSON('/api/investing/guide/retake', { method: 'POST' })
    const questionsRes = await fetchJSON('/api/investing/questions')
    if (questionsRes.ok && questionsRes.data?.success) {
      setQuestions(questionsRes.data.questions)
      setResults(null)
      setSelectedAssetKey(null)
      setPhase('quiz')
    } else {
      setErrorMessage('Could not restart the assessment right now. Please try again shortly.')
      setPhase('error')
    }
  }

  function openDetail(assetKey) {
    setSelectedAssetKey(assetKey)
    setPhase('detail')
  }

  function closeDetail() {
    setSelectedAssetKey(null)
    setPhase('results')
  }

  return (
    <div style={S.outer}>
      {/* Responsive grid tweak for the asset card grids on phones. */}
      <style>{`
        @media (max-width: 640px) {
          .investing-type-grid {
            grid-template-columns: repeat(2, 1fr) !important;
            gap: 10px !important;
          }
        }
      `}</style>
      <div style={S.card}>
        {phase === 'loading' && <p style={S.centerNote}>{ui.loading}</p>}

        {phase === 'error' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <p style={{ color: GRAY_TEXT }}>{errorMessage}</p>
            <button
              type="button"
              onClick={loadInitialState}
              style={{ ...S.primaryButton, maxWidth: '200px', margin: '16px auto 0' }}
            >
              Try Again
            </button>
          </div>
        )}

        {phase === 'quiz' && (
          <>
            <div style={S.headingWrap}>
              <h1 style={S.heading}>{ui.heading}</h1>
              <p style={S.subtitle}>{ui.quizIntro}</p>
            </div>
            <div style={S.langSwitchWrap}>
              <LanguageSwitch value={language} onChange={setLanguage} />
            </div>
            <Quiz questions={questions} language={language} ui={ui} onComplete={handleQuizComplete} />
          </>
        )}

        {phase === 'results' && results && (
          <>
            <div style={S.langSwitchWrap}>
              <LanguageSwitch value={language} onChange={setLanguage} />
            </div>
            <ResultsScreen
              results={results}
              language={language}
              ui={ui}
              onOpenDetail={openDetail}
              onRetake={handleRetake}
            />
          </>
        )}

        {phase === 'detail' && results && selectedAssetKey && (
          <AssetDetailView
            assetBlock={results.assets[selectedAssetKey]}
            language={language}
            setLanguage={setLanguage}
            onClose={closeDetail}
          />
        )}
      </div>
    </div>
  )
}