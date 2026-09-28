// Builds backend/sources/official.json — verbatim passages from official
// University of Waterloo and Government of Ontario pages, split by heading so
// each passage can be cited with a link back to where it came from.
//
// Run: npm run build:sources   (re-run to refresh; the output is committed so
// the deployed backend never scrapes at request time)

const fs = require('fs');
const path = require('path');

const SOURCES = [
  { url: 'https://uwaterloo.ca/off-campus-housing/know-your-rights', publisher: 'UW Off-Campus Housing' },
  { url: 'https://uwaterloo.ca/off-campus-housing/signing-lease', publisher: 'UW Off-Campus Housing' },
  { url: 'https://uwaterloo.ca/off-campus-housing/before-you-rent', publisher: 'UW Off-Campus Housing' },
  { url: 'https://uwaterloo.ca/off-campus-housing/looking-for-place', publisher: 'UW Off-Campus Housing' },
  { url: 'https://uwaterloo.ca/off-campus-housing/help-waterloo', publisher: 'UW Off-Campus Housing' },
  { url: 'https://uwaterloo.ca/off-campus-housing/resources', publisher: 'UW Off-Campus Housing' },
  { url: 'https://uwaterloo.ca/special-constable-service/campus-safety/frauds-and-scams', publisher: 'UW Special Constable Service' },
  { url: 'https://www.ontario.ca/page/renting-ontario-your-rights', publisher: 'Government of Ontario' },
  { url: 'https://www.ontario.ca/page/guide-ontarios-standard-lease', publisher: 'Government of Ontario' },
  { url: 'https://www.ontario.ca/page/residential-rent-increases', publisher: 'Government of Ontario' }
];

const OUT_PATH = path.join(__dirname, '..', 'sources', 'official.json');
const MAX_CHARS = 1100;
const MIN_CHARS = 120;

const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…' };

function decode(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function htmlToLines(html) {
  return decode(
    html
      .replace(/<(script|style|nav|footer|button|svg|form)[\s\S]*?<\/\1>/gi, '')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(p|li|div|tr|h[1-6]|section|article|ul|ol)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line && line !== '•');
}

// Split one long section on line boundaries so no passage exceeds MAX_CHARS.
function splitLong(lines) {
  const parts = [];
  let current = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length > MAX_CHARS && current.length) {
      parts.push(current.join('\n'));
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length) parts.push(current.join('\n'));
  return parts;
}

function extractPassages(html, source) {
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html;
  const pageTitle = decode(html.match(/<title>([^<]*)<\/title>/i)?.[1] || source.url).split('|')[0].trim();

  // Split on h2/h3 so each passage stays under one heading.
  const pieces = main.split(/(?=<h[23][\s>])/i);
  const passages = [];
  for (const piece of pieces) {
    const heading = decode((piece.match(/^<h[23][^>]*>([\s\S]*?)<\/h[23]>/i)?.[1] || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const body = htmlToLines(piece.replace(/^<h[23][^>]*>[\s\S]*?<\/h[23]>/i, ''));
    const text = body.join('\n');
    if (text.length < MIN_CHARS) continue;
    for (const part of splitLong(body)) {
      if (part.length < MIN_CHARS) continue;
      passages.push({ heading: heading || pageTitle, text: part });
    }
  }
  return { pageTitle, passages };
}

async function main() {
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const out = [];

  for (const source of SOURCES) {
    const res = await fetch(source.url, { headers: { 'User-Agent': 'Mozilla/5.0 (occ-chatbot source builder)' } });
    if (!res.ok) {
      console.warn(`skip ${source.url}: HTTP ${res.status}`);
      continue;
    }
    const { pageTitle, passages } = extractPassages(await res.text(), source);
    passages.forEach((p, i) => {
      out.push({
        id: `${new URL(source.url).pathname.split('/').filter(Boolean).pop()}-${i + 1}`,
        publisher: source.publisher,
        pageTitle,
        heading: p.heading,
        url: source.url,
        fetchedAt,
        text: p.text
      });
    });
    console.log(`${passages.length.toString().padStart(3)} passages  ${source.url}`);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${out.length} passages to ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
