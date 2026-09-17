import { createHash } from 'node:crypto';

const SUMMARY_BEGIN = '<!-- SECTION:FINAL_SUMMARY:BEGIN -->';
const SUMMARY_END = '<!-- SECTION:FINAL_SUMMARY:END -->';
const NOTES_BEGIN = '<!-- SECTION:NOTES:BEGIN -->';
const NOTES_END = '<!-- SECTION:NOTES:END -->';

export function maskImplementationNotes(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!header) throw new Error('Backlog task file has no supported frontmatter.');
  const lines = header[1].split('\n');
  if (lines.filter(line => line.startsWith('updated_date:')).length > 1) throw new Error('Duplicate Backlog updated_date field.');
  const fixedHeader = lines.filter(line => !line.startsWith('updated_date:')).join('\n');
  let body = normalized.slice(header[0].length);
  const beginCount = body.split(NOTES_BEGIN).length - 1;
  const endCount = body.split(NOTES_END).length - 1;
  if (beginCount !== endCount || beginCount > 1) throw new Error('Unsupported Backlog Implementation Notes markers.');
  if (beginCount === 1) {
    const section = /\n*## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\n[\s\S]*?\n<!-- SECTION:NOTES:END -->(?=\n+(?:## |\s*$)|\s*$)/;
    if (!section.test(body)) throw new Error('Unsupported Backlog Implementation Notes section.');
    body = body.replace(section, '');
  }
  return `${fixedHeader}\n---\n${body.trimEnd()}`;
}

export function implementationNotesComparableDigest(text: string): string {
  return createHash('sha256').update(maskImplementationNotes(text)).digest('hex');
}

/** Compare task text without granting permission to change unrelated metadata. */
export function assertTaskMetadataEdit(before: string, after: string, checkedIndexes: number[]): void {
  const indexes = new Set(checkedIndexes);
  function unchangedText(text: string): string {
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!header) throw new Error('Backlog task file has no supported frontmatter.');
    const lines = header[1].split(/\r?\n/);
    for (const field of ['status', 'updated_date']) {
      if (lines.filter(line => line.startsWith(`${field}:`)).length > 1) throw new Error(`Duplicate Backlog ${field} field.`);
    }
    const fixedHeader = lines.filter(line => !/^(?:status|updated_date):/.test(line)).join('\n');
    let body = text.slice(header[0].length).replace(/\r\n/g, '\n');
    const begins = body.split(SUMMARY_BEGIN).length - 1;
    const ends = body.split(SUMMARY_END).length - 1;
    if (begins !== ends || begins > 1) throw new Error('Unsupported Backlog final summary markers.');
    if (begins) {
      const section = /\n*## Final Summary\n\n<!-- SECTION:FINAL_SUMMARY:BEGIN -->\n[\s\S]*?\n<!-- SECTION:FINAL_SUMMARY:END -->/;
      if (!section.test(body)) throw new Error('Unsupported Backlog final summary section.');
      body = body.replace(section, '');
    }
    const acSections = body.match(/<!-- AC:BEGIN -->[\s\S]*?<!-- AC:END -->/g) ?? [];
    if (acSections.length > 1) throw new Error('Duplicate Backlog acceptance criteria section.');
    if (acSections[0]) {
      const masked = acSections[0].replace(/^- \[[ x]\] #(\d+) /gm, (prefix, index: string) => indexes.has(Number(index)) ? `- [x] #${index} ` : prefix);
      body = body.replace(acSections[0], masked);
    }
    return `${fixedHeader}\n---\n${body.trimEnd()}`;
  }
  if (unchangedText(before) !== unchangedText(after)) {
    throw new Error('Backlog changed task content outside the intended criteria, status, timestamp, and final summary.');
  }
}
