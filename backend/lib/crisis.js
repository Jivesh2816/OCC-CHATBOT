// Crisis detection and crisis resources. Deliberately rule-based and
// model-free: it has to work when the model is down (quota exhausted, timeout),
// which is exactly when the LLM router can't classify anything.
//
// Patterns aim for recall on the ways students actually write about a crisis
// ("end it all", "bf hits me", "nowhere to sleep tonight") while excluding the
// common look-alikes that aren't one ("suicide prevention workshop", "hit me
// with a rent increase", "in danger of losing my deposit"). test/crisis.test.js
// holds both lists; add to them whenever a real message is misclassified.
//
// Rule for adding a pattern: it must unambiguously describe the speaker's own
// crisis. The eval (eval/README.md, "fresh" split) showed that broad phrase
// families written to catch indirect language don't generalize: on messages
// written after the rules were frozen they added false positives and caught
// nothing new. Indirect language is the LLM router's job; this layer is the
// precise backstop that still works when the model is down.

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
      /\boverdos(e|ed|ing)\b/, /\btook (a bunch of|too many|all (of )?my|a lot of) (pills|meds|medication)\b/,
      // Method or plan without the word "suicide".
      /\b(take|taking|swallow(ing)?|going to take) (all|a bunch|too many|a lot|the rest) (of )?(my |the )?(pills|meds|medication|tablets)\b/,
      /\b(stockpil(e|ed|ing)|sav(e|ed|ing) up|hoard(ed|ing)?) (my |all my )?(pills|meds|medication)\b/,
      /\b(want|going|planning|about|ready) to jump\b/, /\bjump(ing)? (off|from) (the|a|my) (roof|bridge|building|balcony|parking|top)/,
      /\b(ways|how) to (die|kill myself|end it)\b/, /\bnever wake up\b/,
      // Warning signs: saying goodbye, giving possessions away.
      /\b(goodbye|suicide) (letter|note)s?\b/, /\bgiving away (all )?(of )?my (things|stuff|belongings|possessions)\b/,
      /\b(can'?t|cannot) (go on|keep living|keep going)\b(?! to\b)/
    ],
    // Vetoes cancel only the phrase they overlap (see detectCrisis), so "a
    // suicide prevention workshop … I still want to kill myself" still matches.
    vetoes: [
      /\b(suicide|self[- ]?harm|overdose) (prevention|awareness|training|workshop|walk|research|resources|site|kits?|support group)\b/
    ],
    resources: ['emergency', 'crisisLine', 'good2talk', 'here247', 'campusSafety']
  },
  {
    id: 'sexual_violence',
    label: 'sexual violence',
    urgent: true,
    patterns: [
      /\braped\b/, /\brape\b/, /\bsexual(ly)? (assault(ed)?|abused?)\b/, /\bmolested\b/, /\bdrugged me\b/, /\bspiked my drink\b/,
      /\b(i was|i got|i've been|i think i was|been|got) (drugged|roofied)\b/, /\b(put|slipped) something in my drink\b/,
      /\bforced (himself|herself|themselves) on me\b/, /\bgroped me\b/,
      // Unwanted touching described with non-consent, not the landlord-entry kind.
      /\b(touch(ed|ing)?|grop(ed|ing)|fondl(ed|ing)|kiss(ed|ing)?) me\b[^.]{0,60}\b(without|didn'?t|did not|never|no) (my )?consent/
    ],
    vetoes: [
      /\bsexual (assault|violence|abuse) (prevention|awareness|training|workshop|policy|support cent(re|er)|cent(re|er)|resources|events?|statistics|research|education)\b/
    ],
    resources: ['emergency', 'sexualAssault', 'campusSafety', 'good2talk']
  },
  {
    id: 'violence',
    label: 'violence or abuse',
    urgent: true,
    patterns: [
      /\b(hit|hits|hitting|beat|beats|beating|punch(ed|es|ing)?|chok(ed|es|ing)|slap(ped|s|ping)?|kick(ed|s|ing)?|shov(ed|es|ing)|push(ed|es|ing)|strangl(ed|es|ing)|attack(ed|s|ing)|assault(ed|s|ing)?)\s+me\b(?!\s+(out|to|into|around|for|off|over)\b)(?!\s+with\s+(a|an|the|this)\s+\w*\s*(rent|fee|bill|charge|increase|notice|question|message|text|email))/,
      /\bthreaten(ed|ing|s)? to (kill|hurt|beat|harm) (me|us)\b/, /\b(scared|afraid|terrified) (that )?(he|she|they|my \w+) (will|is going to|might|'ll|could) (kill|hurt|harm|beat) me\b/,
      /\bdomestic (violence|abuse)\b/, /\b(being|been|getting) abused\b/, /\babusive (partner|boyfriend|girlfriend|husband|wife|relationship|roommate|ex|landlord)\b/,
      /\b(throws?|threw|throwing) (things|stuff|objects|plates|bottles) at me\b/,
      /\b(grabbed|grabs|held|pinned|shook) me (by the (throat|neck|hair|arm)|down|against)\b/
      // Deliberately absent: reported threats in the "said he'd kill me" form.
      // They read as hyperbole as often as not ("my prof said he'd kill me if
      // I'm late"), and the fresh eval split showed exactly that false positive.
      // The LLM router judges those from context.
    ],
    vetoes: [
      /\b(domestic|intimate partner) (violence|abuse) (policy|statistics|research|awareness|prevention|presentation|paper|essay|workshop|training|resources)\b/,
      /\b(paper|essay|presentation|project|research|report|assignment|class|course) (on|about) (domestic|intimate partner) (violence|abuse)\b/
    ],
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
      /\bbroke into my (apartment|house|home|room|unit|place)\b/, /\b(stalking|following) me\b/, /\bbeing stalked\b/,
      /\b(trying to|tried to) break in(to)?\b/, /\bfollowed me (home|to my|from)\b/
      // Not here: "someone at my door", "keeps showing up at my …". Neutral on
      // their own (a salesman, a roommate), so they're left to the router.
    ],
    vetoes: [/\bfollowing me on (instagram|insta|ig|twitter|x|tiktok|linkedin|snapchat|facebook|social media|twitch|youtube)\b/],
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
      /\bsleeping (outside|in my car|on the street|rough)\b/, /\b(living|sleeping|end up|ending up|be) on the streets?\b/,
      /\b(locked|lock) me out\b/, /\blocked out of my (apartment|house|home|room|unit|place)\b/, /\bchanged the (locks?|lock code|door code|code)\b/,
      /\b(kicked|thrown|threw) (me )?out (of my (apartment|house|home|room|unit|place)|today|tonight)\b/,
      /\b(put|threw|thrown|throw|tossed) (all )?(of )?my (stuff|things|belongings) (on the curb|outside|out|on the lawn)\b/, /\bevict(ed|ing) me (today|tonight|now)\b/,
      /\b(got|been|was) evicted (today|tonight|this (morning|week)|yesterday)\b/,
      /\b(don'?t|do not) have (anywhere|any ?where|a place|any place) to (sleep|stay|go|live)\b/, /\bno place to (sleep|stay|go|live)\b/,
      /\bno idea where (i'?m|i am|i'll|i will) (going to |gonna )?(sleep|stay|live)\b/,
      /\bcouch ?surf(ing)?\b/, /\blost my (housing|home|apartment|place to live)\b/, /\bforc(ing|ed|es) me out\b/
    ],
    vetoes: [
      /\bhomeless(ness)? (shelters?|people|persons?|population|community|charity|drive|outreach|volunteers?|policy|research)\b/,
      /\blocked (myself )?out\b[^.]{0,60}\b(lost|losing|forgot|left) (my )?keys?\b/, /\block(ed)? myself out\b/
    ],
    resources: ['twoOneOne', 'policeNonEmergency', 'ltb', 'campusSafety']
  }
];

const globalOf = re => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);

// A veto cancels a match only where the two overlap, so a look-alike phrase
// can't hide a real crisis elsewhere in the same message.
function vetoed(category, text, start, end) {
  return category.vetoes.some(veto => [...text.matchAll(globalOf(veto))].some(v => v.index < end && v.index + v[0].length > start));
}

// Returns the first matching category ({ id, label, urgent, match }) or null.
function detectCrisis(text) {
  const lower = String(text || '').toLowerCase().replace(/[’‘]/g, "'");
  for (const category of CATEGORIES) {
    for (const pattern of category.patterns) {
      for (const m of lower.matchAll(globalOf(pattern))) {
        if (!vetoed(category, lower, m.index, m.index + m[0].length)) {
          return { id: category.id, label: category.label, urgent: category.urgent, match: m[0] };
        }
      }
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
