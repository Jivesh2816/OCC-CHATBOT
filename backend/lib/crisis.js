// Crisis detection and crisis resources. Deliberately rule-based and
// model-free: it has to work when the model is down (quota exhausted, timeout),
// which is exactly when the LLM router can't classify anything.
//
// Patterns aim for recall on the ways students actually write about a crisis
// ("end it all", "bf hits me", "nowhere to sleep tonight") while excluding the
// common look-alikes that aren't one ("suicide prevention workshop", "hit me
// with a rent increase", "in danger of losing my deposit"). test/crisis.test.js
// holds both lists; add to them whenever a real message is misclassified.

// Checked against each organization's own website on 2026-09-28, except 211
// (211 Ontario's pages didn't load; 2-1-1 is the province-wide line).
// Re-verify before any public launch and whenever this list changes.
const RESOURCES = {
  emergency: '**Emergency**: call 911',
  crisisLine: '**9-8-8 Suicide Crisis Helpline**: call or text 988 (24/7)',
  good2talk: '**Good2Talk** (post-secondary students): 1-866-925-5454, or text GOOD2TALKON to 686868 (24/7)',
  here247: '**Here 24/7** (Waterloo-Wellington crisis & mental health): 1-844-437-3247',
  campusSafety: '**UW Special Constable Service**: 519-888-4911 (24/7)',
  policeNonEmergency: '**Waterloo Regional Police (non-emergency)**: 519-570-9777',
  womensCrisis: "**Women's Crisis Services of Waterloo Region**: 519-653-2422 (24/7)",
  assaultedWomen: "**Assaulted Women's Helpline**: 1-866-863-0511 (24/7)",
  sexualAssault: '**Sexual Assault Support Centre of Waterloo Region**: 519-741-8633 (24/7)',
  twoOneOne: '**211**: call 2-1-1 for emergency shelters and community services',
  ltb: '**Landlord and Tenant Board**: 1-888-332-3234'
};

// Each category: patterns that trigger it, patterns that veto a match (the
// look-alikes), whether it's a crisis that replaces the normal answer, and
// the resources shown.
const CATEGORIES = [
  {
    id: 'self_harm',
    label: 'self-harm or suicide',
    urgent: true,
    patterns: [
      /\bkill(ing)? my ?self\b/, /\bend(ing)? (my|it) (life|all)\b/, /\bend it all\b/, /\bending (it|things|everything)\b/,
      /\b(want(ed)?|wanna|going) to die\b/, /\bi wish i (was|were) dead\b/, /\bbetter off (dead|without me)\b/,
      /\b(don'?t|do not) want to (live|be alive|be here anymore|exist|wake up)\b/, /\bno reason to (live|keep going)\b/,
      /\bsuicid(e|al)\b/, /\bself[- ]?harm/, /\b(hurt|hurting|cut|cutting) my ?self\b/, /\bkms\b/,
      /\boverdos(e|ed|ing)\b/, /\btook (a bunch of|too many|all (of )?my|a lot of) (pills|meds|medication)\b/
    ],
    vetoes: [/\bsuicide (prevention|awareness|training|workshop|walk|research)\b/, /\bself[- ]?harm (resources|awareness|training)\b/],
    resources: ['emergency', 'crisisLine', 'good2talk', 'here247', 'campusSafety']
  },
  {
    id: 'sexual_violence',
    label: 'sexual violence',
    urgent: true,
    patterns: [/\braped\b/, /\brape\b/, /\bsexual(ly)? (assault(ed)?|abused?)\b/, /\bmolested\b/, /\bdrugged me\b/, /\bspiked my drink\b/],
    vetoes: [],
    resources: ['emergency', 'sexualAssault', 'campusSafety', 'good2talk']
  },
  {
    id: 'violence',
    label: 'violence or abuse',
    urgent: true,
    patterns: [
      /\b(hit|hits|hitting|beat|beats|beating|punch(ed|es|ing)?|chok(ed|es|ing)|slap(ped|s|ping)?|kick(ed|s|ing)?|shov(ed|es|ing)|push(ed|es|ing)|strangl(ed|es|ing)|attack(ed|s|ing)|assault(ed|s|ing)?)\s+me\b(?!\s+(out|to|into|around|for|off|over)\b)(?!\s+with\s+(a|an|the|this)\s+\w*\s*(rent|fee|bill|charge|increase|notice|question|message|text|email))/,
      /\bthreaten(ed|ing|s)? to (kill|hurt|beat|harm) (me|us)\b/, /\b(scared|afraid|terrified) (that )?(he|she|they|my \w+) (will|is going to|might|'ll|could) (kill|hurt|harm|beat) me\b/,
      /\bdomestic (violence|abuse)\b/, /\b(being|been|getting) abused\b/, /\babusive (partner|boyfriend|girlfriend|husband|wife|relationship|roommate|ex|landlord)\b/
    ],
    vetoes: [],
    resources: ['emergency', 'womensCrisis', 'assaultedWomen', 'campusSafety', 'policeNonEmergency']
  },
  {
    id: 'danger',
    label: 'immediate danger',
    urgent: true,
    patterns: [
      /\b(i'?m|i am) in danger\b(?! of)/, /\b(not|un)safe right now\b/, /\bfeel unsafe (at home|here|in my)\b/,
      /\b(don'?t|do not) feel safe (at home|here|in my (house|home|apartment|unit|room|place)|with (him|her|them|my))\b/,
      /\bsomeone (is|'s) (trying to (hurt|kill) me|in my (house|home|apartment|room|unit)|breaking in)\b/,
      /\bbroke into my (apartment|house|home|room|unit|place)\b/, /\b(stalking|following) me\b/, /\bbeing stalked\b/
    ],
    vetoes: [],
    resources: ['emergency', 'campusSafety', 'policeNonEmergency', 'here247']
  },
  {
    // Losing housing today is urgent in its own way: the student still gets the
    // normal (grounded) answer about their rights, plus these resources, and a
    // ticket is opened and escalated so a person can follow up.
    id: 'housing_emergency',
    label: 'losing housing',
    urgent: false,
    patterns: [
      /\bhomeless\b/, /\bnowhere to (sleep|stay|go|live)\b/, /\bno(where| place) to (sleep|stay) tonight\b/,
      /\bsleeping (outside|in my car|on the street|rough)\b/, /\bon the street\b/,
      /\b(locked|lock) me out\b/, /\blocked out of my (apartment|house|home|room|unit|place)\b/, /\bchanged the locks\b/,
      /\b(kicked|thrown|threw) (me )?out (of my (apartment|house|home|room|unit|place)|today|tonight)\b/,
      /\b(put|threw|thrown) my (stuff|things|belongings) (on the curb|outside|out)\b/, /\bevict(ed|ing) me (today|tonight|now)\b/
    ],
    vetoes: [],
    resources: ['twoOneOne', 'policeNonEmergency', 'ltb', 'campusSafety']
  }
];

// Returns the first matching category ({ id, label, urgent, match }) or null.
function detectCrisis(text) {
  const lower = String(text || '').toLowerCase().replace(/[’‘]/g, "'");
  for (const category of CATEGORIES) {
    if (category.vetoes.some(v => v.test(lower))) continue;
    for (const pattern of category.patterns) {
      const m = lower.match(pattern);
      if (m) return { id: category.id, label: category.label, urgent: category.urgent, match: m[0] };
    }
  }
  return null;
}

// Router-flagged urgent messages that no pattern matched get the general list.
const GENERAL_RESOURCES = ['emergency', 'crisisLine', 'good2talk', 'here247', 'campusSafety'];

function resourceLines(categoryId) {
  const category = CATEGORIES.find(c => c.id === categoryId);
  return (category ? category.resources : GENERAL_RESOURCES).map(key => `• ${RESOURCES[key]}`).join('\n');
}

// The fixed reply for an urgent message. `staffHandoff` must only be true when
// staff actually get alerted; a student in crisis shouldn't be promised a
// person who isn't coming.
function urgentReply(categoryId, { staffHandoff = false } = {}) {
  const intro = '⚠️ This sounds serious, and you deserve help from a real person right now — more than a chatbot can give.';
  const handoff = staffHandoff
    ? "\n\nI've also flagged this conversation for staff, and any reply will appear right here — but please don't wait on that if you're in danger. Use the numbers above."
    : '\n\nThese are staffed by people who can help right now. If you are in immediate danger, call 911.';
  return `${intro}\n\nPlease reach out directly:\n${resourceLines(categoryId)}${handoff}`;
}

// Appended to a normal answer (housing emergencies), not replacing it.
function resourceNote(categoryId) {
  return `\n\n**If you need help today:**\n${resourceLines(categoryId)}`;
}

// Shown when the model is unavailable and nothing in the FAQ matched, so the
// fallback is never a cheerful non-answer to someone who may be struggling.
const SAFETY_FOOTER = `\n\nIf this is urgent: call **911** in an emergency, **988** (call or text) for a mental-health crisis, or **2-1-1** for emergency shelter.`;

module.exports = { RESOURCES, CATEGORIES, detectCrisis, urgentReply, resourceNote, SAFETY_FOOTER };
