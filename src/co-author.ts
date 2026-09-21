import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

function sanitizeDisplayName(name: string): string {
  const sanitized = name.replace(/[<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'Pi Model';
}

function sanitizeEmailLocalPart(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9.!#$%&'*+/=?^_`{|}~-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'model';
}

export function buildCoAuthorTrailerValues(model: ExtensionContext['model']): string[] {
  if (!model) return [];
  const provider = model.provider ?? 'unknown';
  const id = model.id ?? 'unknown';
  const displayName = sanitizeDisplayName(model.name ?? id);
  const emailLocalPart = sanitizeEmailLocalPart(`${provider}-${id}`);
  return [
    `Co-authored-by: ${displayName} <${emailLocalPart}@pi.local>`,
    `Pi-Model: ${provider}/${id}`,
  ];
}

export function buildCoAuthorTrailerArgs(model: ExtensionContext['model']): string[] {
  return buildCoAuthorTrailerValues(model).map(value => `--trailer=${value}`);
}
