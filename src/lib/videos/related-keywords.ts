/**
 * Distinctive-keyword extraction for automatic Article ↔ Video links. Picks weighted unigrams and
 * bigrams (Vietnamese meaning lives mostly in two-syllable words) and turns them into a safe FTS5
 * OR query. Diacritics are kept in the query terms; the unicode61 tokenizer folds them itself.
 */

const EN_STOP = `the and that this with from have your you they them there their what when where which will would could should about
just like really going know think want make thing things very much more some also been were into then than because yeah okay right
well actually gonna people something other here only even each over those these does doing dont cant said says look need time maybe
pretty kind sort back still being after before first through every everyone everything anything today video welcome guys hello thanks
thank subscribe channel let lets get got can our out are was but not all any how who why its it's one two use using used way lot
come came give take made many most such own same while again ever never always within without upon onto off per via etc`;

// Folded (no diacritics, đ→d) Vietnamese function words and fillers.
const VI_STOP = `cua nhung trong khong duoc nguoi cho cac mot nay cung minh chung thi la va co de khi nhu ma se da dang roi lam gi nao vay
the cai con ban toi anh em chi nhieu rat hon qua ra vao len xuong lai neu vi nen hay hoac tu den voi bang theo ve sau truoc tren duoi
day do kia o thay biet noi muon phai can vang uh ah nhe nha a thoi moi nhat nua luon van deu tat ca ho cung nhu nhieu it hai ba bon
nam sau bay tam chin muoi tram nghin trieu ty nhieu kieu nhu the nao tai sao bao gio chua xong luc giua ngoai khac rieng chinh ngay
bay gio hom nay cac ban moi nguoi xin chao cam on video kenh dang ky like share comment`;

const STOP = new Set(`${EN_STOP} ${VI_STOP}`.split(/\s+/).filter(Boolean));

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

export function foldTerm(term: string): string {
  return term.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
}

function tokens(text: string): string[] {
  return text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t && !CJK_RE.test(t));
}

const isStop = (folded: string) => STOP.has(folded) || /^\d+$/.test(folded);

export interface WeightedText { text: string; weight: number }

/** Top distinctive terms (unigrams ≥4 letters, bigrams of content words) by weighted frequency. */
export function extractKeywords(fields: WeightedText[], maxTerms = 12): string[] {
  const scores = new Map<string, { term: string; score: number }>();
  const add = (key: string, term: string, w: number) => {
    const cur = scores.get(key);
    if (cur) cur.score += w; else scores.set(key, { term, score: w });
  };
  for (const { text, weight } of fields) {
    const list = tokens(text);
    const folded = list.map(foldTerm);
    for (let i = 0; i < list.length; i += 1) {
      const f = folded[i];
      if (isStop(f)) continue;
      if (f.length >= 4) add(f, list[i], weight);
      const nf = folded[i + 1];
      if (nf !== undefined && !isStop(nf) && f.length >= 2 && nf.length >= 2) add(`${f} ${nf}`, `${list[i]} ${list[i + 1]}`, weight * 1.5);
    }
  }
  return [...scores.values()]
    // A term must recur (or come from a weighted field such as the title) to count as distinctive.
    .filter(x => x.score >= 2)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, maxTerms)
    .map(x => x.term);
}

/** FTS5 OR query of quoted keyword phrases; null when nothing distinctive was found. */
export function relatedMatchQuery(fields: WeightedText[], maxTerms = 12): string | null {
  const terms = extractKeywords(fields, maxTerms);
  return terms.length ? terms.map(t => `"${t}"`).join(' OR ') : null;
}

/** Keeps hits whose score is at least `ratio` of the best one (drops weak, incidental matches). */
export function keepStrong<T extends { score: number }>(hits: T[], ratio = 0.3): T[] {
  const top = hits.reduce((m, h) => Math.max(m, h.score), 0);
  return top > 0 ? hits.filter(h => h.score >= top * ratio) : [];
}
