// Turns passage ids into the links shown under a finding. Two passages from
// the same section of the same page collapse into one link.
function citeSources(sourceIds, sourcesById) {
  const seen = new Set();
  const links = [];
  for (const id of sourceIds) {
    const s = sourcesById[id];
    if (!s) continue;
    const key = `${s.url}#${s.heading}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ id: s.id, title: s.heading, publisher: s.publisher, url: s.url });
  }
  return links;
}

module.exports = { citeSources };
